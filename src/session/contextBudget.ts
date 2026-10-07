import * as vscode from 'vscode';
import { Message } from '../types';

/** Start clearing old tool output once a step's prompt passes this share of the window. */
export const PRUNE_AT = 0.6;
/** Large context windows still need an absolute cost ceiling. */
export const PRUNE_AT_TOKENS = 80_000;
/** Past this share, keep only the newest tool output. */
const AGGRESSIVE_AT = 0.85;
const AGGRESSIVE_AT_TOKENS = 160_000;
const KEEP_RECENT = 4;
const MIN_PRUNE_CHARS = 600;
const PREVIEW_CHARS = 300;
const CLEARED = '[older tool output cleared to save context — re-run the tool if you need it again]';

/** Known context windows by model-id pattern; first match wins. */
const WINDOWS: [RegExp, number][] = [
  [/\[1m\]|-1m\b/i, 1_000_000],
  // Current Claude models (Opus/Sonnet 4.6+, Sonnet 5.x, Opus 5.x, Fable, Mythos) have 1M windows.
  [/claude-(fable|mythos)|claude-(opus|sonnet)-(5|4-[678])/i, 1_000_000],
  [/claude/i, 200_000],
  [/gpt-5/i, 400_000],
  [/gpt-4\.1/i, 1_000_000],
  [/gpt-4o|o1|o3|o4/i, 128_000],
  [/gemini/i, 1_000_000],
  [/deepseek|qwen|kimi|glm|mistral|llama/i, 128_000],
];
const DEFAULT_WINDOW = 128_000;

/** The model's context window, unless the user pinned one in settings. */
export function contextWindowFor(model: string): number {
  const override = vscode.workspace.getConfiguration('frappe-copilot').get<number>('contextWindowTokens', 0);
  if (override && override > 0) return override;
  return WINDOWS.find(([re]) => re.test(model))?.[1] ?? DEFAULT_WINDOW;
}

/** Clears the bodies of older tool results (and the large inputs of older
 *  write calls) once a run nears its context limit or an absolute cost ceiling —
 *  the same "tool result clearing" Claude Code does, with no extra LLM call.
 *  Returns how many characters were freed. */
export function pruneRunHistory(history: Message[], promptTokens: number, window: number): number {
  const pruneAt = Math.min(window * PRUNE_AT, PRUNE_AT_TOKENS);
  if (promptTokens < pruneAt) return 0;
  const aggressiveAt = Math.min(window * AGGRESSIVE_AT, AGGRESSIVE_AT_TOKENS);
  const keep = promptTokens >= aggressiveAt ? 1 : KEEP_RECENT;
  const resultIdx = history.map((m, i) => (isToolResultMessage(m) ? i : -1)).filter(i => i >= 0);
  const cutoff = resultIdx.length > keep ? resultIdx[resultIdx.length - keep] : -1;

  let freed = 0;
  for (let i = 0; i < cutoff; i++) {
    freed += clearMessage(history[i]);
  }
  return freed;
}

function isToolResultMessage(m: Message): boolean {
  return m.role === 'user' && (!!m.toolResults?.length || m.content.startsWith('<tool_result'));
}

function clearMessage(m: Message): number {
  let freed = 0;
  for (const r of m.toolResults || []) {
    if (r.content.length > MIN_PRUNE_CHARS && !r.content.endsWith(CLEARED)) {
      freed += r.content.length;
      r.content = `${r.content.slice(0, PREVIEW_CHARS)}\n…\n${CLEARED}`;
    }
  }
  if (m.role === 'user' && m.content.startsWith('<tool_result') && m.content.length > MIN_PRUNE_CHARS && !m.content.includes(CLEARED)) {
    const head = m.content.slice(0, PREVIEW_CHARS);
    freed += m.content.length;
    m.content = `${head}\n…\n${CLEARED}\n</tool_result>`;
  }
  for (const c of m.toolCalls || []) {
    for (const key of ['content', 'search', 'replace', 'edits', 'script', 'blocks']) {
      const v = c.input?.[key];
      const size = typeof v === 'string' ? v.length : v ? JSON.stringify(v).length : 0;
      if (size > MIN_PRUNE_CHARS) {
        freed += size;
        c.input[key] = '[cleared — already applied]';
      }
    }
  }
  return freed;
}
