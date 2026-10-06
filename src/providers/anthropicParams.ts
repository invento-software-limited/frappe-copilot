import { capsFor, clampEffort, EffortLevel } from './modelCaps';

/** Server-side clearing of old tool results (Anthropic context editing).
 *  Used instead of rewriting history client-side, which current models
 *  reject once the history carries thinking blocks. */
export const CONTEXT_EDITING_BETA = 'context-management-2025-06-27';
export const CONTEXT_EDITING = { edits: [{ type: 'clear_tool_uses_20250919' }] };

export interface ParamInput {
  model: string;
  stream: boolean;
  maxTokens?: number;
  temperature?: number;
  effort?: EffortLevel;
  /** User's "extended thinking" switch. */
  thinking: boolean;
  /** Legacy budget for models that still take budget_tokens. */
  thinkingBudget: number;
}

/** Sampling/thinking/effort fields valid for this model. Current Claude
 *  models reject budget_tokens and custom temperature, and think adaptively
 *  — effort is the depth control there. */
export function generationParams(p: ParamInput): Record<string, any> {
  const caps = capsFor(p.model);
  const out: Record<string, any> = {};
  // Streams can afford the model's full output room; a thinking model
  // answering a tiny non-streaming classify call still needs room to think.
  const floor = p.stream ? caps.maxOutput : caps.thinksByDefault ? 4096 : 0;
  out.max_tokens = Math.max(p.maxTokens || 8192, floor);

  if (caps.thinking === 'adaptive' && (p.thinking || caps.thinksByDefault)) {
    // 'summarized' — the default on current models streams empty thinking text.
    out.thinking = { type: 'adaptive', display: 'summarized' };
  } else if (caps.thinking === 'budget' && p.thinking) {
    out.thinking = { type: 'enabled', budget_tokens: p.thinkingBudget };
    out.max_tokens = Math.max(out.max_tokens, p.thinkingBudget + 8192);
  }

  // Small non-streaming helper calls (routing, compaction) don't need depth.
  const effort = clampEffort(p.effort ?? (!p.stream && caps.thinksByDefault ? 'low' : undefined), caps);
  if (effort) out.output_config = { effort };

  if (caps.temperature && !out.thinking && p.temperature !== undefined) {
    out.temperature = p.temperature;
  }
  return out;
}

export function addBeta(headers: Record<string, string>, flag: string): void {
  const existing = headers['anthropic-beta'];
  const flags = existing ? existing.split(',').map(f => f.trim()) : [];
  if (!flags.includes(flag)) flags.push(flag);
  headers['anthropic-beta'] = flags.join(',');
}
