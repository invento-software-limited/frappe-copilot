import * as vscode from 'vscode';
import { Message, ChatOptions, ChatResponse, ImageAttachment } from '../types';
import { LLMProvider } from './interface';

/**
 * @anthropic-ai/claude-agent-sdk ships as an ESM-only package ("type": "module").
 * tsc with "module": "commonjs" rewrites both static and dynamic `import()` into
 * `require()`, which throws ERR_REQUIRE_ESM for an ESM-only package. Routing the
 * import through `new Function(...)` hides it from TypeScript's transpiler, so
 * the emitted code keeps a real native dynamic `import()` at runtime.
 */
const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string
) => Promise<typeof import('@anthropic-ai/claude-agent-sdk')>;

type ClaudeAgentSdk = typeof import('@anthropic-ai/claude-agent-sdk');
type SDKMessage = Awaited<ReturnType<ClaudeAgentSdk['query']>> extends AsyncGenerator<infer M, void> ? M : never;

/** Per-run resume checkpoint: the Claude Code session that already contains
 *  everything up through `consumedThrough` non-system messages of that run's
 *  transcript, so the next call only has to send what's new since then. */
interface RunCheckpoint {
  sessionId: string;
  consumedThrough: number;
}

/** Upper bound on concurrently-tracked runs — bounds memory for a long-lived
 *  extension host without needing an explicit end-of-run hook from the caller.
 *  Far above any realistic number of in-flight/recent agent runs. */
const MAX_TRACKED_RUNS = 20;

/**
 * Delegates auth and API calling to Anthropic's own Claude Agent SDK — the same
 * library the official Claude Code VS Code extension is built on. It resolves
 * credentials itself (an `ANTHROPIC_API_KEY` env var, or the OAuth/API-key
 * profile from `claude auth login` / the Claude Code "Login with Claude" flow),
 * and handles retries, thinking/effort params, and rate-limit backoff
 * internally — none of that needs to be reimplemented here.
 *
 * Each step of this extension's own tool-call loop (ChatPanel.runOneAgentStep)
 * calls this provider again with the whole growing transcript. Rather than
 * flattening and resending all of it every time, calls tagged with the same
 * `options.runId` resume the same Claude Code session and send only what's new
 * since the last call — see resolveTurn/recordCheckpoint below.
 */
export class ClaudeAgentSdkProvider implements LLMProvider {
  readonly name = 'Claude Code';
  private model: string = 'claude-sonnet-5';
  private extendedThinking: boolean = false;
  private thinkingBudgetTokens: number = 10000;
  private sdkPromise: Promise<ClaudeAgentSdk> | undefined;
  private runs = new Map<string, RunCheckpoint>();

  refreshConfig(): void {
    const config = vscode.workspace.getConfiguration('frappe-copilot.claudeCode');
    this.model = config.get<string>('model', 'claude-sonnet-5');
    this.extendedThinking = config.get<boolean>('extendedThinking', false);
    this.thinkingBudgetTokens = config.get<number>('thinkingBudgetTokens', 10000);
  }

  private getSdk(): Promise<ClaudeAgentSdk> {
    if (!this.sdkPromise) {
      this.sdkPromise = dynamicImport('@anthropic-ai/claude-agent-sdk');
    }
    return this.sdkPromise;
  }

  /** Credentials live outside this extension (Claude Code login state or
   *  ANTHROPIC_API_KEY) — there is nothing to store or clear here. */
  async hasApiKey(): Promise<boolean> {
    return this.isAvailable();
  }
  async setApiKey(): Promise<void> {}
  async clearApiKey(): Promise<void> {}

  async getAuthMode(): Promise<'api-key' | 'oauth' | 'none'> {
    return (await this.isAvailable()) ? 'oauth' : 'none';
  }

  async isAvailable(): Promise<boolean> {
    try {
      const sdk = await this.getSdk();
      return typeof sdk.query === 'function';
    } catch {
      return false;
    }
  }

  /** Folds consecutive same-role messages into single turns. */
  private mergeTurns(messages: Message[]): { role: 'user' | 'assistant'; content: string }[] {
    const merged: { role: 'user' | 'assistant'; content: string }[] = [];
    for (const m of messages) {
      const role = m.role === 'assistant' ? 'assistant' : 'user';
      if (merged.length > 0 && merged[merged.length - 1].role === role) {
        merged[merged.length - 1].content += '\n\n' + m.content;
      } else {
        merged.push({ role, content: m.content });
      }
    }
    return merged;
  }

  /** `query()` takes one prompt string per call — flattens merged turns into
   *  the `<prior_conversation>`-wrapped transcript format the SDK expects,
   *  with the last turn as the actual trailing prompt. */
  private turnsToPrompt(turns: { role: 'user' | 'assistant'; content: string }[]): string {
    if (turns.length === 0) return '';
    const last = turns[turns.length - 1];
    const priorTurns = turns.slice(0, -1);

    let prompt = '';
    if (priorTurns.length > 0) {
      prompt += '<prior_conversation>\n';
      for (const turn of priorTurns) {
        prompt += `${turn.role === 'user' ? 'Human' : 'Assistant'}: ${turn.content}\n\n`;
      }
      prompt += '</prior_conversation>\n\n';
    }
    prompt += last.content;
    return prompt;
  }

  /** Decides what actually needs to go out over the wire for this call.
   *
   *  Without `runId` (or on a run's first call), there's nothing to resume —
   *  the whole transcript is sent, same as before.
   *
   *  With `runId`, this extension's own tool-call loop (ChatPanel.runOneAgentStep)
   *  re-invokes the provider once per tool round trip within one run, each time
   *  with `messages` grown by exactly the assistant reply plus tool result(s)
   *  from the previous step — never mutated or shortened. So once a run has a
   *  checkpoint, only messages past `consumedThrough` are new. The leading one
   *  of those is always this run's own last assistant reply (pushed by the
   *  caller before the next step); the resumed Claude Code session already
   *  contains it verbatim, since it's what that session generated, so it's
   *  dropped rather than resent. What's left — the tool result(s) — is the only
   *  actually-new content, and gets sent with `resume: sessionId` instead of
   *  the full growing history. This is what turns an O(n^2) multi-step run
   *  (full transcript resent every step, uncached — see chatStream's
   *  `persistSession` comment) into O(n) total input tokens for that run. */
  private resolveTurn(
    messages: Message[],
    runId: string | undefined
  ): { system?: string; prompt: string; images: ImageAttachment[]; resume?: string } {
    const system = messages.find(m => m.role === 'system')?.content;
    const nonSystem = messages.filter(m => m.role !== 'system');

    const checkpoint = runId ? this.runs.get(runId) : undefined;
    let toSend = nonSystem;
    let resume: string | undefined;

    if (checkpoint && nonSystem.length > checkpoint.consumedThrough) {
      let newSlice = nonSystem.slice(checkpoint.consumedThrough);
      if (newSlice.length > 0 && newSlice[0].role === 'assistant') {
        newSlice = newSlice.slice(1);
      }
      if (newSlice.length > 0) {
        toSend = newSlice;
        resume = checkpoint.sessionId;
      }
      // else: nothing new beyond the already-resumed assistant turn (shouldn't
      // happen in practice) — fall through and resend the full transcript.
    }

    const images = toSend.flatMap(m => (m.images || []).filter(img => !!img.data));
    const prompt = this.turnsToPrompt(this.mergeTurns(toSend));

    return { system, prompt, images, resume };
  }

  /** Records how much of this run's transcript the resumed/newly-created
   *  session now covers, so the next call for the same `runId` only sends the
   *  delta. Only called after a call succeeds — an error leaves the previous
   *  checkpoint (or none) in place, so a retry naturally resends full context
   *  instead of resuming a session that may be in a bad state. */
  private recordCheckpoint(runId: string | undefined, sessionId: string | undefined, messages: Message[]): void {
    if (!runId || !sessionId) return;
    const nonSystemCount = messages.filter(m => m.role !== 'system').length;
    this.runs.set(runId, { sessionId, consumedThrough: nonSystemCount });
    while (this.runs.size > MAX_TRACKED_RUNS) {
      const oldestKey = this.runs.keys().next().value;
      if (oldestKey === undefined) break;
      this.runs.delete(oldestKey);
    }
  }

  /** `query()` takes either a plain string or a stream of user messages. Images
   *  can only be expressed as content blocks, so an attachment forces the
   *  second form — a single-message async iterable carrying image blocks
   *  followed by the same prompt text the string form would have used. */
  private async *imagePromptStream(
    prompt: string,
    images: ImageAttachment[]
  ): AsyncIterable<any> {
    const content: any[] = images.map(img => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.data },
    }));
    content.push({ type: 'text', text: prompt });

    yield {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: '',
    };
  }

  private describeSdkError(error: string | undefined, status: number | null | undefined): string {
    switch (error) {
      case 'authentication_failed':
        return 'Not signed in to Claude Code. Run `claude` in a terminal once and complete login (or set ANTHROPIC_API_KEY), then try again.';
      case 'oauth_org_not_allowed':
        return 'Your Claude.ai organization does not permit this integration — check your Claude Code / Claude.ai admin settings.';
      case 'billing_error':
        return 'Billing issue on your Claude account — check console.anthropic.com or claude.ai billing settings.';
      case 'rate_limit':
        return 'Rate limited — this shares limits with your Claude Code CLI sessions. Wait a bit and try again.';
      case 'overloaded':
        return 'Claude is temporarily overloaded.';
      case 'model_not_found':
        return 'Model not found, or not available on your plan.';
      case 'max_output_tokens':
        return 'Hit the maximum output token limit.';
      case 'invalid_request':
        return 'Invalid request sent to Claude.';
      default:
        return status ? `Claude API error (status ${status}).` : 'Unknown error from Claude Code.';
    }
  }

  private describeResultError(msg: any): string {
    const parts: string[] = [];
    if (msg.subtype && msg.subtype !== 'success') parts.push(String(msg.subtype).replace(/_/g, ' '));
    if (Array.isArray(msg.errors) && msg.errors.length) parts.push(msg.errors.join('; '));
    if (msg.api_error_status) parts.push(`(HTTP ${msg.api_error_status})`);
    return parts.length ? `Claude Code error: ${parts.join(' ')}` : 'Claude Code returned an error.';
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<ChatResponse> {
    let content = '';
    let reasoning = '';
    let model = options?.model || this.model;
    for await (const chunk of this.chatStream(messages, options)) {
      content += chunk.content;
      reasoning += chunk.reasoning || '';
      model = chunk.model || model;
    }
    return { content, reasoning: reasoning || undefined, model };
  }

  async *chatStream(
    messages: Message[],
    options?: ChatOptions,
    abortSignal?: AbortSignal
  ): AsyncIterable<ChatResponse> {
    const sdk = await this.getSdk();
    const { system, prompt, images, resume } = this.resolveTurn(messages, options?.runId);
    const modelToUse = options?.model || this.model;

    const controller = new AbortController();
    if (abortSignal) {
      if (abortSignal.aborted) controller.abort();
      abortSignal.addEventListener('abort', () => controller.abort());
    }

    const sdkOptions: Record<string, unknown> = {
      model: modelToUse,
      tools: [],
      strictMcpConfig: true,
      // Sessions need to persist to disk so a later call for the same runId
      // can `resume` this one instead of resending the whole transcript —
      // see resolveTurn/recordCheckpoint.
      persistSession: true,
      settingSources: [],
      includePartialMessages: true,
      maxTurns: 1,
      abortController: controller,
    };
    if (resume) {
      sdkOptions.resume = resume;
    }
    if (system) {
      sdkOptions.systemPrompt = system;
    }
    if (this.extendedThinking) {
      // `adaptive` only works on Opus-class models (the SDK decides when/how much
      // to think for those); every model this provider offers, including the
      // default (claude-sonnet-5), needs the model-agnostic fixed-budget form
      // instead or the SDK silently emits no thinking_delta events at all.
      sdkOptions.thinking = { type: 'enabled', budgetTokens: this.thinkingBudgetTokens };
    }

    let resultText: string | undefined;
    let sawTextDelta = false;
    let errorMessage: string | undefined;
    let sessionId: string | undefined = resume;

    try {
      const stream = sdk.query({
        prompt: images.length > 0 ? this.imagePromptStream(prompt, images) as any : prompt,
        options: sdkOptions as any
      });
      for await (const msg of stream as AsyncIterable<SDKMessage>) {
        if (abortSignal?.aborted) return;

        const m = msg as any;
        if (typeof m.session_id === 'string' && m.session_id) {
          sessionId = m.session_id;
        }
        if (m.type === 'stream_event') {
          const event = m.event;
          if (event?.type === 'content_block_delta') {
            if (event.delta?.type === 'text_delta') {
              sawTextDelta = true;
              yield { content: event.delta.text || '', model: modelToUse };
            } else if (event.delta?.type === 'thinking_delta') {
              yield { content: '', reasoning: event.delta.thinking || '', model: modelToUse };
            }
          }
        } else if (m.type === 'system' && m.subtype === 'api_retry') {
          options?.onRetry?.(
            m.attempt,
            (m.retry_delay_ms || 0) / 1000,
            this.describeSdkError(m.error, m.error_status)
          );
        } else if (m.type === 'result') {
          if (m.is_error) {
            errorMessage = this.describeResultError(m);
          } else if (!sawTextDelta && typeof m.result === 'string') {
            // Fallback for the (unexpected) case where partial deltas didn't fire.
            resultText = m.result;
          }
        }
      }
    } catch (e: any) {
      if (abortSignal?.aborted || e?.name === 'AbortError') return;
      throw e;
    }

    if (errorMessage) {
      throw new Error(errorMessage);
    }
    this.recordCheckpoint(options?.runId, sessionId, messages);
    if (resultText) {
      yield { content: resultText, model: modelToUse };
    }
  }

  async getModels(): Promise<string[]> {
    return ['claude-sonnet-5', 'claude-opus-4-8', 'claude-haiku-4-5-20251001', 'claude-fable-5'];
  }
}
