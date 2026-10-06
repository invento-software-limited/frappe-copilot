import { Message, ToolResultBlock } from '../types';

const INTERRUPTED = 'Tool call was not executed (the run was interrupted before it ran).';

/** Both native APIs reject a transcript where an assistant tool call has no
 *  matching result on the next user turn. That happens when a run is aborted
 *  mid-step, so patch in a synthetic result instead of failing the request. */
export function repairToolPairs(messages: Message[]): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    out.push(msg);
    if (msg.role !== 'assistant' || !msg.toolCalls?.length) continue;

    const answered = collectAnsweredIds(messages, i + 1);
    const missing = msg.toolCalls.filter(c => !answered.has(c.id));
    if (missing.length === 0) continue;
    const results: ToolResultBlock[] = missing.map(c => ({
      toolCallId: c.id, name: c.name, content: INTERRUPTED, isError: true,
    }));
    out.push({ role: 'user', content: '', toolResults: results });
  }
  return out;
}

/** True when a message carries anything a provider would actually send. */
export function hasPayload(m: Message): boolean {
  return !!(m.content?.trim() || m.toolCalls?.length || m.toolResults?.length || m.images?.some(i => i.data));
}

function collectAnsweredIds(messages: Message[], start: number): Set<string> {
  const ids = new Set<string>();
  for (let j = start; j < messages.length && messages[j].role !== 'assistant'; j++) {
    for (const r of messages[j].toolResults || []) ids.add(r.toolCallId);
  }
  return ids;
}
