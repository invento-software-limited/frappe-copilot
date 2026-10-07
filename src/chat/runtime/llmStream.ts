import { ChatOptions, ChatResponse, Message, ThinkingBlock, ToolCall, ToolSpec } from '../../types';
import { EffortLevel } from '../../providers/modelCaps';
import type { AgentRuntime } from './agentRuntime';
import { StreamResult } from './types';

/** Model replies are capped per call; a cut-off reply is continued, not lost. */
const MAX_OUTPUT_TOKENS = 16384;

/** Streams one model call into a chat bubble and collects the full reply. */
export class LlmStreamer {
  private seq = 0;

  constructor(private rt: AgentRuntime) {}

  /** Returns the visible reply *and* the thinking stream — with extended
   *  thinking on, a model sometimes writes a whole <tool_call> inside its
   *  thinking, and that call still has to run. `truncated` is set when the
   *  provider cut the turn off at its output-token ceiling. */
  async stream(msgs: Message[], runId?: string, tools?: ToolSpec[], effort?: EffortLevel): Promise<StreamResult> {
    const { ui, provider, control, models } = this.rt.deps;
    let full = '', fullReasoning = '', truncated = false;
    let toolCalls: ToolCall[] | undefined;
    let thinkingBlocks: ThinkingBlock[] | undefined;
    let usage: ChatResponse['usage'];
    // Unique even for parallel sub-agent streams started in the same millisecond.
    const id = `${Date.now()}-${++this.seq}`;
    ui.post({ type: 'startStream', messageId: id });
    try {
      const options: ChatOptions = { maxTokens: MAX_OUTPUT_TOKENS };
      if (models.selectedModel) options.model = models.selectedModel;
      if (runId) options.runId = runId;
      if (tools?.length) options.tools = tools;
      if (effort) options.effort = effort;
      options.onRetry = (attempt: number, delaySec: number, error: string) => {
        ui.say('retryNotice', { attempt, delaySec, error });
      };
      for await (const c of provider.chatStream(msgs, options, control.signal)) {
        if (control.aborted) throw new Error('Streaming aborted by user.');
        full += c.content;
        fullReasoning += c.reasoning || '';
        if (c.truncated) truncated = true;
        if (c.toolCalls?.length) toolCalls = [...(toolCalls || []), ...c.toolCalls];
        if (c.thinkingBlocks?.length) thinkingBlocks = [...(thinkingBlocks || []), ...c.thinkingBlocks];
        if (c.usage?.promptTokens) usage = c.usage;
        if (c.content || c.reasoning) {
          ui.post({ type: 'streamChunk', messageId: id, chunk: c.content, reasoning: c.reasoning || '' });
        }
      }
    } catch (e) {
      ui.post({ type: 'streamError', messageId: id, error: String(e) });
      throw e;
    }
    ui.post({ type: 'endStream', messageId: id, fullContent: full, fullReasoning });
    return { content: full, reasoning: fullReasoning, truncated, toolCalls, thinkingBlocks, usage };
  }
}
