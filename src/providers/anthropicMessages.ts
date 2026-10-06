import { Message, ToolCall, ThinkingBlock, ToolSpec } from '../types';
import { repairToolPairs, hasPayload } from './toolMessages';

export interface AnthropicTurn {
  role: 'user' | 'assistant';
  content: any[];
}

/** Converts the transcript into Anthropic's content-block form: native
 *  tool_use/tool_result blocks, signed thinking replayed on tool turns, and
 *  consecutive same-role messages merged (the API requires alternation). */
export function toAnthropicTurns(
  messages: Message[],
  keepThinking: boolean
): { system?: string; turns: AnthropicTurn[] } {
  const system = messages.find(m => m.role === 'system')?.content;
  const turns: AnthropicTurn[] = [];
  const convo = repairToolPairs(messages.filter(m => m.role !== 'system' && hasPayload(m)));

  for (const msg of convo) {
    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    const blocks = role === 'assistant' ? assistantBlocks(msg, keepThinking) : userBlocks(msg);
    if (blocks.length === 0) continue;
    const prev = turns[turns.length - 1];
    if (prev && prev.role === role) {
      prev.content.push(...blocks);
    } else {
      turns.push({ role, content: blocks });
    }
  }
  // tool_result blocks must lead their user turn, ahead of any text/images.
  for (const t of turns) {
    if (t.role === 'user') t.content.sort((a, b) => rank(a) - rank(b));
  }
  return { system, turns };
}

export function toAnthropicTools(tools: ToolSpec[]): any[] {
  return tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));
}

/** Rebuilds text, thinking, and tool_use blocks from Anthropic's SSE events. */
export class AnthropicStreamState {
  private blocks = new Map<number, PartialBlock>();
  /** Set when a tool_use block's JSON input never completed (output cut off). */
  incompleteToolCall = false;

  /** Feeds one parsed SSE event; returns any text/thinking delta to surface live. */
  onEvent(chunk: any): { text?: string; thinking?: string } {
    if (chunk.type === 'content_block_start') {
      const b = chunk.content_block || {};
      this.blocks.set(chunk.index, {
        type: b.type, id: b.id, name: b.name, text: '', json: '', signature: '', data: b.data,
      });
      return {};
    }
    if (chunk.type !== 'content_block_delta') return {};
    const block = this.blocks.get(chunk.index);
    const d = chunk.delta || {};
    if (d.type === 'text_delta') return { text: d.text || '' };
    if (d.type === 'thinking_delta') {
      if (block) block.text += d.thinking || '';
      return { thinking: d.thinking || '' };
    }
    if (d.type === 'signature_delta' && block) block.signature += d.signature || '';
    if (d.type === 'input_json_delta' && block) block.json += d.partial_json || '';
    return {};
  }

  finish(): { toolCalls: ToolCall[]; thinkingBlocks: ThinkingBlock[] } {
    const toolCalls: ToolCall[] = [];
    const thinkingBlocks: ThinkingBlock[] = [];
    const ordered = [...this.blocks.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]);
    for (const b of ordered) {
      if (b.type === 'thinking') thinkingBlocks.push({ thinking: b.text, signature: b.signature });
      if (b.type === 'redacted_thinking') thinkingBlocks.push({ thinking: '', redacted: b.data });
      if (b.type === 'tool_use') {
        const input = parseInput(b.json);
        if (input) toolCalls.push({ id: b.id!, name: b.name!, input });
        else this.incompleteToolCall = true;
      }
    }
    return { toolCalls, thinkingBlocks };
  }
}

interface PartialBlock {
  type: string;
  id?: string;
  name?: string;
  text: string;
  json: string;
  signature: string;
  data?: string;
}

function assistantBlocks(msg: Message, keepThinking: boolean): any[] {
  const blocks: any[] = [];
  if (keepThinking && msg.toolCalls?.length) {
    for (const t of msg.thinkingBlocks || []) {
      if (t.redacted) blocks.push({ type: 'redacted_thinking', data: t.redacted });
      else if (t.signature) blocks.push({ type: 'thinking', thinking: t.thinking, signature: t.signature });
    }
  }
  if (msg.content?.trim()) blocks.push({ type: 'text', text: msg.content });
  for (const c of msg.toolCalls || []) {
    blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input || {} });
  }
  return blocks;
}

/** Anthropic wants images before the text that refers to them. */
function userBlocks(msg: Message): any[] {
  const blocks: any[] = (msg.toolResults || []).map(r => ({
    type: 'tool_result',
    tool_use_id: r.toolCallId,
    content: r.content || '(no output)',
    ...(r.isError ? { is_error: true } : {}),
  }));
  for (const img of msg.images || []) {
    if (!img.data) continue;
    blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
  }
  if (msg.content?.trim()) blocks.push({ type: 'text', text: msg.content });
  return blocks;
}

function rank(block: any): number {
  return block.type === 'tool_result' ? 0 : 1;
}

function parseInput(json: string): Record<string, any> | null {
  if (!json.trim()) return {};
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}
