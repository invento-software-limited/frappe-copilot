import { ImageAttachment, Message, ToolResultBlock } from '../../types';
import { buildToolSpecs } from '../../agents/tools/schemas';
import { estimateMessagesTokens } from '../../session/compaction';
import { pruneRunHistory } from '../../session/contextBudget';
import type { AgentRuntime } from './agentRuntime';
import {
  batchToolCalls, extractXmlToolCalls, handleNoToolCalls, isPermanentError, looksLikeImagesUnsupported, looksLikeToolsUnsupported,
} from './replyAnalysis';
import { PendingToolCall, RunScope, StepResult, StreamResult } from './types';

/** A thrown stream error has already survived the provider's own retries, but
 *  a mid-stream connection drop is still transient — retry the step, giving
 *  up after this many consecutive failures so a real outage ends the run. */
export const MAX_CONSECUTIVE_STREAM_ERRORS = 5;

/** One reasoning + tool-dispatch step of an agent run. Shared by the main
 *  loop, verification fix-rounds and sub-agents so they all get the same
 *  approval flow, allowlist gate and recovery logic. */
export class AgentStepper {
  constructor(private rt: AgentRuntime) {}

  async run(scope: RunScope, stepLabel: string): Promise<StepResult> {
    const { ui, models } = this.rt.deps;
    const native = models.useNativeTools();
    const messages = await this.rt.prompts.build(scope, native);
    ui.say('agentState', { state: 'running', phase: stepLabel === '1' ? 'Analyzing request...' : 'Continuing reasoning...' });

    let streamed: StreamResult;
    try {
      const tools = native ? buildToolSpecs(scope.agent.allowedTools) : undefined;
      streamed = await this.rt.streamer.stream(messages, scope.runId, tools, models.effortFor(scope.agent));
    } catch (e: any) {
      return this.recoverFromStreamError(e, native, scope);
    }
    scope.loopState.streamErrorCount = 0;
    this.trackContextUsage(streamed, messages, scope.localHistory);

    const calls = this.collectToolCalls(streamed, scope, stepLabel);
    if (calls.length === 0) {
      return handleNoToolCalls(streamed.content, streamed.reasoning, streamed.truncated, native, scope.localHistory, scope.loopState);
    }
    scope.loopState.malformedCount = 0;
    scope.loopState.truncatedCount = 0;
    scope.loopState.emptyCount = 0;

    const { results, images } = await this.runTools(scope, calls, stepLabel);
    if (streamed.toolCalls?.length) {
      scope.localHistory.push({ role: 'user', content: '', toolResults: results });
    } else {
      for (const r of results) {
        scope.localHistory.push({
          role: 'user',
          content: `<tool_result name="${r.name}">\n${r.content}\n</tool_result>`,
          ...(r.subRunId ? { subRunId: r.subRunId } : {}),
        });
      }
    }
    // Images ride on the turn that returns the results — every provider
    // already sends a user turn's images.
    if (images.length) {
      scope.localHistory[scope.localHistory.length - 1].images = images;
      if (!this.rt.deps.provider.managesContextServerSide?.()) keepRecentImages(scope.localHistory);
    }
    return { done: false, assistantText: streamed.content, stopLoop: false };
  }

  /** Native calls come back structured; XML calls are parsed from the text. */
  private collectToolCalls(streamed: StreamResult, scope: RunScope, stepLabel: string): PendingToolCall[] {
    const nativeCalls = streamed.toolCalls || [];
    if (nativeCalls.length === 0) {
      return extractXmlToolCalls(streamed.content, streamed.reasoning, scope.localHistory, `${scope.runId}-${stepLabel}`);
    }
    scope.localHistory.push({
      role: 'assistant',
      content: streamed.content,
      toolCalls: nativeCalls,
      thinkingBlocks: streamed.thinkingBlocks,
    });
    return nativeCalls.map(c => ({ callId: c.id, name: c.name, args: c.input || {} }));
  }

  private async runTools(scope: RunScope, calls: PendingToolCall[], stepLabel: string): Promise<{ results: ToolResultBlock[]; images: ImageAttachment[] }> {
    const results: ToolResultBlock[] = [];
    const images: ImageAttachment[] = [];
    const canSee = this.rt.deps.models.toolImagesEnabled();
    for (const batch of batchToolCalls(calls)) {
      const outs = await Promise.all(batch.map(call => this.rt.toolCalls.run(scope, call, stepLabel)));
      batch.forEach((call, k) => {
        const out = outs[k];
        let content = out.output;
        if (out.images?.length && canSee) images.push(...out.images);
        else if (out.images?.length) content += '\n(The image was not sent — this model can\'t view images.)';
        results.push({ toolCallId: call.callId, name: call.name, content, isError: !out.success, ...(out.subRunId ? { subRunId: out.subRunId } : {}) });
      });
    }
    return { results, images };
  }

  private async recoverFromStreamError(e: any, native: boolean, scope: RunScope): Promise<StepResult> {
    const { ui, models, control } = this.rt.deps;
    const message = e?.message || String(e);
    if (native && looksLikeToolsUnsupported(e)) {
      // Some OpenAI-compatible models reject `tools` outright — use XML from now on.
      models.disableNativeTools();
      ui.chat('system', '⚠️ This model rejected native tool calling; switching to the text-based tool protocol.');
      return { done: false, assistantText: '', stopLoop: false };
    }
    if (looksLikeImagesUnsupported(e) && dropImages(scope)) {
      models.disableToolImages();
      ui.chat('system', '⚠️ This model rejected images; continuing without screenshots.');
      return { done: false, assistantText: '', stopLoop: false };
    }
    if (isPermanentError(e)) {
      // Bad model, auth, or malformed request — retrying can't fix these.
      ui.chat('error', message);
      return { done: false, assistantText: '', stopLoop: true };
    }
    const attempt = ++scope.loopState.streamErrorCount;
    if (attempt > MAX_CONSECUTIVE_STREAM_ERRORS) {
      ui.chat('error', `LLM Stream error (gave up after ${attempt} consecutive failures): ${message}`);
      return { done: false, assistantText: '', stopLoop: true };
    }
    ui.chat('system', `⚠️ Stream error, retrying (attempt ${attempt}/${MAX_CONSECUTIVE_STREAM_ERRORS}): ${message}`);
    await control.sleep(Math.min(2000 * attempt, 10000));
    return { done: false, assistantText: '', stopLoop: false };
  }

  /** Updates the context badge with the step's real prompt size (estimated
   *  when the provider doesn't report usage) and clears older tool output
   *  once the run nears the model's context window. */
  private trackContextUsage(streamed: StreamResult, sent: Message[], localHistory: Message[]): void {
    const { ui, provider, models } = this.rt.deps;
    const window = models.contextWindow();
    const prompt = streamed.usage?.promptTokens || estimateMessagesTokens(sent);
    ui.say('tokenUsage', { estimatedTokens: prompt, budget: window, live: true });
    this.rt.budget.record(prompt, streamed.usage?.completionTokens || Math.ceil((streamed.content.length + streamed.reasoning.length) / 4));
    // Providers that clear old tool results server-side need an append-only
    // history — rewriting it invalidates thinking blocks.
    if (provider.managesContextServerSide?.()) return;
    const freed = pruneRunHistory(localHistory, prompt + (streamed.usage?.completionTokens || 0), window);
    if (freed > 0) console.log(`[context] cleared ~${Math.round(freed / 4)} tokens of older tool output (${prompt}/${window})`);
  }
}

/** Removes tool images from the run's transcript; true when there were any. */
function dropImages(scope: RunScope): boolean {
  let dropped = false;
  for (const m of scope.localHistory) {
    if (!m.images?.length) continue;
    delete m.images;
    dropped = true;
  }
  return dropped;
}

/** Screenshots cost tokens on every later call — only the latest few stay. */
const MAX_IMAGE_TURNS = 2;

function keepRecentImages(history: Message[]): void {
  let kept = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (!m.images?.length || m.role !== 'user' || !(m.toolResults?.length || m.content.startsWith('<tool_result'))) continue;
    if (++kept > MAX_IMAGE_TURNS) {
      delete m.images;
      m.content += m.content ? '\n(older screenshot removed to save context)' : '';
    }
  }
}
