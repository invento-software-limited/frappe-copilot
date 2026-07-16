import { Message } from '../types';

/** Same cheap token heuristic already used in src/intake/splitter.ts —
 *  no tokenizer dependency, good enough for a threshold check and a display badge. */
export function estimateTokens(text: string): number {
  return Math.ceil((text || '').length / 4);
}

export function estimateMessagesTokens(messages: Message[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0);
}

export const DEFAULT_COMPACTION_THRESHOLD_TOKENS = 40000;

/** Builds the one-shot, non-streaming summarization prompt used to compact a
 *  session — same "cheap plain provider.chat() call" pattern as the router/planner. */
export function buildCompactionPrompt(messages: Message[]): { system: string; user: string } {
  const transcript = messages
    .filter(m => m.role !== 'system')
    .map(m => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`)
    .join('\n\n');

  const system = `You are compacting a long coding-assistant conversation so a fresh agent invocation can continue with full context but far fewer tokens.

Produce a concise but complete carry-forward summary. Preserve:
- File paths, DocTypes, apps, and modules that were created, modified, or discussed
- Concrete decisions made and why
- The current state of any in-progress work
- Open TODOs or unresolved questions

Omit resolved tool-call noise, exploratory dead ends, and anything no longer relevant. Write it as plain prose/bullets, not a transcript.`;

  return { system, user: transcript };
}
