import { Message } from '../types';

/** Same cheap token heuristic already used in src/intake/splitter.ts —
 *  no tokenizer dependency, good enough for a threshold check and a display badge. */
export function estimateTokens(text: string): number {
  return Math.ceil((text || '').length / 4);
}

export function estimateMessagesTokens(messages: Message[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

function estimateMessageTokens(m: Message): number {
  const calls = (m.toolCalls || []).reduce((n, c) => n + estimateTokens(c.name + JSON.stringify(c.input || {})), 0);
  const results = (m.toolResults || []).reduce((n, r) => n + estimateTokens(r.content), 0);
  return estimateTokens(m.content) + calls + results + 4;
}

export const DEFAULT_COMPACTION_THRESHOLD_TOKENS = 40000;

/** Builds the one-shot, non-streaming summarization prompt used to compact a
 *  session — same "cheap plain provider.chat() call" pattern as the router/planner. */
export function buildCompactionPrompt(messages: Message[], maxChars = Infinity): { system: string; user: string } {
  const full = messages
    .filter(m => m.role !== 'system')
    .map(m => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`)
    .join('\n\n');
  const transcript = fitTranscript(full, maxChars);

  const system = `You are compacting a long coding-assistant conversation so a fresh agent invocation can continue with full context but far fewer tokens.

Produce a concise but complete carry-forward summary. Preserve:
- File paths, DocTypes, apps, and modules that were created, modified, or discussed
- Concrete decisions made and why
- The current state of any in-progress work
- Open TODOs or unresolved questions
- The user's stated preferences and constraints, and any corrections they made

Omit resolved tool-call noise, exploratory dead ends, and anything no longer relevant. Write it as plain prose/bullets, not a transcript.`;

  return { system, user: transcript };
}

/** Keeps the opening (original goal) and the most recent turns when the raw
 *  transcript is too large to fit the summarization call itself. */
function fitTranscript(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.2);
  const tail = maxChars - head;
  return `${text.slice(0, head)}\n\n[... ${text.length - maxChars} characters of the middle of the conversation omitted ...]\n\n${text.slice(-tail)}`;
}
