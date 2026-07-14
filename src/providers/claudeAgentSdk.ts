import * as vscode from 'vscode';
import { Message, ChatOptions, ChatResponse } from '../types';
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

/**
 * Delegates auth and API calling to Anthropic's own Claude Agent SDK — the same
 * library the official Claude Code VS Code extension is built on. It resolves
 * credentials itself (an `ANTHROPIC_API_KEY` env var, or the OAuth/API-key
 * profile from `claude auth login` / the Claude Code "Login with Claude" flow),
 * and handles retries, thinking/effort params, and rate-limit backoff
 * internally — none of that needs to be reimplemented here.
 */
export class ClaudeAgentSdkProvider implements LLMProvider {
  readonly name = 'Claude Code';
  private model: string = 'claude-sonnet-5';
  private extendedThinking: boolean = false;
  private sdkPromise: Promise<ClaudeAgentSdk> | undefined;

  refreshConfig(): void {
    const config = vscode.workspace.getConfiguration('frappe-copilot.claudeCode');
    this.model = config.get<string>('model', 'claude-sonnet-5');
    this.extendedThinking = config.get<boolean>('extendedThinking', false);
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

  /** Splits out the system message and flattens the remaining turns into a single
   *  transcript string. `query()` takes one prompt string per call and this extension
   *  resends the full history (plus a freshly-rebuilt system prompt) every turn rather
   *  than using the SDK's session `resume` — so folding prior turns into the prompt
   *  keeps behavior identical to the direct-API provider instead of tying state to a
   *  Claude Code session id. */
  private buildPrompt(messages: Message[]): { system?: string; prompt: string } {
    const system = messages.find(m => m.role === 'system')?.content;
    const turns = messages.filter(m => m.role !== 'system');

    const merged: { role: 'user' | 'assistant'; content: string }[] = [];
    for (const m of turns) {
      const role = m.role === 'assistant' ? 'assistant' : 'user';
      if (merged.length > 0 && merged[merged.length - 1].role === role) {
        merged[merged.length - 1].content += '\n\n' + m.content;
      } else {
        merged.push({ role, content: m.content });
      }
    }

    if (merged.length === 0) {
      return { system, prompt: '' };
    }

    const last = merged[merged.length - 1];
    const priorTurns = merged.slice(0, -1);

    let prompt = '';
    if (priorTurns.length > 0) {
      prompt += '<prior_conversation>\n';
      for (const turn of priorTurns) {
        prompt += `${turn.role === 'user' ? 'Human' : 'Assistant'}: ${turn.content}\n\n`;
      }
      prompt += '</prior_conversation>\n\n';
    }
    prompt += last.content;

    return { system, prompt };
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
    const { system, prompt } = this.buildPrompt(messages);
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
      persistSession: false,
      settingSources: [],
      includePartialMessages: true,
      maxTurns: 1,
      abortController: controller,
    };
    if (system) {
      sdkOptions.systemPrompt = system;
    }
    if (this.extendedThinking) {
      sdkOptions.thinking = { type: 'adaptive' };
    }

    let resultText: string | undefined;
    let sawTextDelta = false;
    let errorMessage: string | undefined;

    try {
      const stream = sdk.query({ prompt, options: sdkOptions as any });
      for await (const msg of stream as AsyncIterable<SDKMessage>) {
        if (abortSignal?.aborted) return;

        const m = msg as any;
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
    if (resultText) {
      yield { content: resultText, model: modelToUse };
    }
  }

  async getModels(): Promise<string[]> {
    return ['claude-sonnet-5', 'claude-opus-4-8', 'claude-haiku-4-5-20251001', 'claude-fable-5'];
  }
}
