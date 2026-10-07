import { Message } from '../types';
import { parseXmlToolCalls, stripToolCallMarkup } from './xmlToolCalls';

/** Saved tool output is capped so reloading a long session stays light. */
const MAX_OUTPUT_CHARS = 4000;

/** One visible step of a finished run, as the chat shows it live. */
export type RunStep =
  | { kind: 'text'; text: string; thinking?: string }
  | { kind: 'tool'; id: string; name: string; args: Record<string, any>; output?: string; isError?: boolean; subRunId?: string; children?: RunStep[] };

type ToolStep = Extract<RunStep, { kind: 'tool' }>;

/** Turns a run's saved transcript into the steps the chat streamed live —
 *  intermediate text, reasoning, and tool calls with their results — so a
 *  reopened chat shows the same timeline instead of only the final answer.
 *  The last assistant text is dropped when `finalText` already carries it. */
export function buildRunSteps(entries: Message[], finalText: string, readSubRun?: (runId: string) => Message[]): RunStep[] {
  const steps: RunStep[] = [];
  const byId = new Map<string, ToolStep>();
  let pendingXml: ToolStep[] = [];

  for (const e of entries) {
    if (e.role === 'assistant') {
      pendingXml = addAssistantSteps(e, steps, byId);
    } else if (e.toolResults?.length) {
      for (const r of e.toolResults) {
        const step = byId.get(r.toolCallId);
        if (step) Object.assign(step, { output: cap(r.content), isError: !!r.isError, ...(r.subRunId ? { subRunId: r.subRunId } : {}) });
      }
    } else if (e.content.trim().startsWith('<tool_result')) {
      const step = attachXmlResults(e.content, pendingXml);
      if (step && e.subRunId) step.subRunId = e.subRunId;
    }
  }
  dropRepeatedFinalText(steps, finalText);
  if (readSubRun) nestSubRuns(steps, readSubRun);
  return steps;
}

/** A `task` call's sub-agent run, shown inside its card (one level deep). */
function nestSubRuns(steps: RunStep[], readSubRun: (runId: string) => Message[]): void {
  for (const s of steps) {
    if (s.kind !== 'tool' || !s.subRunId) continue;
    const children = buildRunSteps(readSubRun(s.subRunId), s.output || '');
    if (children.length) s.children = children;
  }
}

function addAssistantSteps(
  e: Message,
  steps: RunStep[],
  byId: Map<string, ToolStep>
): ToolStep[] {
  const text = stripToolCallMarkup(e.content).trim();
  const thinking = (e.thinkingBlocks || []).map(b => b.thinking).filter(Boolean).join('\n\n');
  if (text || thinking) steps.push({ kind: 'text', text, ...(thinking ? { thinking } : {}) });

  if (e.toolCalls?.length) {
    for (const c of e.toolCalls) {
      const step = { kind: 'tool' as const, id: c.id, name: c.name, args: c.input || {} };
      byId.set(c.id, step);
      steps.push(step);
    }
    return [];
  }
  const xml = parseXmlToolCalls(e.content).map((c, i) => ({ kind: 'tool' as const, id: `xml-${steps.length}-${i}`, name: c.name, args: c.args }));
  steps.push(...xml);
  return xml;
}

/** XML-protocol results arrive in call order as `<tool_result name="…">`
 *  blocks, one or more per message — each answers the oldest open call. */
function attachXmlResults(content: string, pending: ToolStep[]): ToolStep | undefined {
  const regex = /<tool_result name="([^"]+)"[^>]*>\n?([\s\S]*?)\n?<\/tool_result>/g;
  let match;
  let last: ToolStep | undefined;
  while ((match = regex.exec(content)) !== null) {
    const name = match[1];
    const step = pending.find(s => s.output === undefined && s.name === name);
    if (step) {
      step.output = cap(match[2]);
      last = step;
    }
  }
  return last;
}

function dropRepeatedFinalText(steps: RunStep[], finalText: string): void {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.kind !== 'text') continue;
    if (s.text && finalText.trim().startsWith(s.text)) s.text = '';
    if (!s.text && !s.thinking) steps.splice(i, 1);
    return;
  }
}

function cap(s: string): string {
  return s.length > MAX_OUTPUT_CHARS ? s.slice(0, MAX_OUTPUT_CHARS) + `\n… (${s.length - MAX_OUTPUT_CHARS} more chars)` : s;
}
