import { Message, ToolCall, ToolSpec, ChatOptions } from '../types';
import { capsFor, clampEffort } from './modelCaps';
import { repairToolPairs, hasPayload } from './toolMessages';

/** Converts the transcript to chat-completions messages. Native tool calls
 *  become assistant `tool_calls` and one `role: tool` message per result. */
export function toOpenAIMessages(messages: Message[]): any[] {
  const system = messages.filter(m => m.role === 'system');
  const convo = repairToolPairs(messages.filter(m => m.role !== 'system' && hasPayload(m)));
  return [...system, ...convo].flatMap(toOpenAIEntries);
}

export function toOpenAITools(tools: ToolSpec[]): any[] {
  return tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/** Reasoning models (gpt-5*, o-series) reject a custom temperature and take
 *  `reasoning_effort` instead; everything else keeps temperature. */
export function samplingParams(model: string, temperature: number | undefined, effort?: ChatOptions['effort']): Record<string, unknown> {
  const caps = capsFor(model);
  // Claude via an OpenAI-compatible proxy: no temperature, and the proxy's
  // effort mapping is unknown, so leave both to its defaults.
  if (/claude/i.test(model) && !caps.temperature) return {};
  if (!caps.temperature) {
    const level = clampEffort(effort, caps);
    return level ? { reasoning_effort: level } : {};
  }
  return temperature === undefined ? {} : { temperature };
}

/** Rebuilds tool calls from streamed `delta.tool_calls` fragments, which
 *  arrive keyed by index with the JSON arguments split across chunks. */
export class OpenAIToolAccumulator {
  private calls = new Map<number, { id: string; name: string; args: string }>();
  incompleteToolCall = false;

  add(deltas: any[] | undefined): void {
    for (const d of deltas || []) {
      const idx = typeof d.index === 'number' ? d.index : this.calls.size;
      const cur = this.calls.get(idx) || { id: '', name: '', args: '' };
      if (d.id) cur.id = d.id;
      if (d.function?.name) cur.name += d.function.name;
      if (d.function?.arguments) cur.args += d.function.arguments;
      this.calls.set(idx, cur);
    }
  }

  finish(): ToolCall[] {
    const out: ToolCall[] = [];
    for (const [idx, c] of [...this.calls.entries()].sort((a, b) => a[0] - b[0])) {
      const input = parseArgs(c.args);
      if (!c.name || !input) {
        this.incompleteToolCall = true;
        continue;
      }
      out.push({ id: c.id || `call_${Date.now()}_${idx}`, name: c.name, input });
    }
    return out;
  }
}

function toOpenAIEntries(m: Message): any[] {
  if (m.role === 'assistant' && m.toolCalls?.length) {
    const reasoning = (m.thinkingBlocks || []).map(t => t.thinking).join('');
    return [{
      role: 'assistant',
      content: m.content || null,
      tool_calls: m.toolCalls.map(c => ({
        id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input || {}) },
      })),
      ...(reasoning ? { reasoning_content: reasoning } : {}),
    }];
  }
  const entries: any[] = (m.toolResults || []).map(r => ({
    role: 'tool', tool_call_id: r.toolCallId, content: r.content || '(no output)',
  }));
  if (m.content?.trim() || m.images?.some(i => i.data) || entries.length === 0) {
    entries.push(toPlainMessage(m));
  }
  return entries;
}

/** Promotes to the multimodal content-array form only when hydrated images
 *  are attached — a plain string keeps compatibility with the many
 *  OpenAI-compatible endpoints that never accept content arrays. */
function toPlainMessage(m: Message): { role: string; content: any } {
  const images = (m.images || []).filter(img => !!img.data);
  if (images.length === 0) {
    return { role: m.role, content: m.content };
  }
  const parts: any[] = images.map(img => ({
    type: 'image_url',
    image_url: { url: `data:${img.mediaType};base64,${img.data}` },
  }));
  if (m.content) {
    parts.push({ type: 'text', text: m.content });
  }
  return { role: m.role, content: parts };
}

function parseArgs(raw: string): Record<string, any> | null {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}
