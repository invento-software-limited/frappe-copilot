import { Message } from '../../types';
import { READ_ONLY_TOOLS } from '../../agents/types';
import { isParallelSafeTask } from '../../agents/subagents';
import { parseXmlToolCalls } from '../xmlToolCalls';
import { LoopState, PendingToolCall, StepResult } from './types';

/** A model that can't emit this app's tool-call format will repeat the
 *  failure forever — give up after this many consecutive malformed replies. */
export const MAX_CONSECUTIVE_MALFORMED_TOOL_CALLS = 5;
/** A reply cut off at the output-token ceiling is re-prompted, but a
 *  model/config that always gets cut off gives up after this many in a row. */
export const MAX_CONSECUTIVE_TRUNCATIONS = 5;

const TRUNCATION_NUDGE = 'Your previous response was cut off by the output length limit before finishing, so any tool call in it was NOT executed. Continue from where you left off; if you were writing a large file, split it into smaller write_file/edit_file calls.';
const MALFORMED_NUDGE = 'Your previous response used an invalid tool-call format (garbled tag, invented tag name such as <tool_check>, or a missing name attribute) and was NOT executed. You must use exactly this format, with no other function-calling syntax, tokens, or extra characters: <tool_call name="TOOL_NAME"><param_name>value</param_name></tool_call> — the literal tag is `tool_call` and the `name` attribute is required. Write it in your visible reply, not inside your reasoning. Retry the tool call now in that exact format.';

/** Parses XML-protocol tool calls from the reply. With extended thinking on,
 *  the model sometimes emits the whole <tool_call> block inside its thinking
 *  instead, so fall back to that and fold the recovered calls into the
 *  assistant turn the tool results will answer. */
export function extractXmlToolCalls(content: string, reasoning: string, localHistory: Message[], idPrefix: string): PendingToolCall[] {
  let parsed = parseXmlToolCalls(content);
  let transcriptText = content;
  if (parsed.length === 0 && reasoning.trim()) {
    const recovered = parseXmlToolCalls(reasoning);
    if (recovered.length > 0) {
      parsed = recovered;
      transcriptText = [content.trim(), ...recovered.map(c => c.raw)].filter(Boolean).join('\n\n');
    }
  }
  if (transcriptText.trim()) localHistory.push({ role: 'assistant', content: transcriptText });
  return parsed.map((c, idx) => ({ callId: `${idPrefix}-${idx}`, name: c.name, args: c.args }));
}

/** A step with no tool calls normally ends the run — unless the reply was
 *  cut off by the output limit, or (XML protocol) the model garbled the
 *  tool-call syntax, in which case nudge it and keep looping. */
export function handleNoToolCalls(
  fullContent: string,
  fullReasoning: string,
  truncated: boolean,
  native: boolean,
  localHistory: Message[],
  loopState: LoopState
): StepResult {
  const emitted = `${fullContent}\n${fullReasoning}`;
  const openCount = (emitted.match(/<tool_call\s+name="/g) || []).length;
  const closeCount = (emitted.match(/<\/tool_call>/g) || []).length;
  const danglingXmlCall = !native && openCount > closeCount;

  if (truncated || danglingXmlCall) {
    loopState.truncatedCount++;
    if (loopState.truncatedCount > MAX_CONSECUTIVE_TRUNCATIONS) {
      return {
        done: true,
        stopLoop: true,
        assistantText: `${fullContent}\n\n---\n**Stopped:** the response kept getting cut off by the output-length limit ${loopState.truncatedCount} times in a row before finishing. Try a shorter request, a lower extended-thinking budget, or a model with a larger output limit.`,
      };
    }
    localHistory.push({ role: 'user', content: TRUNCATION_NUDGE });
    return { done: false, assistantText: fullContent, stopLoop: false };
  }
  loopState.truncatedCount = 0;

  // A model can drift into another invocation syntax (<invoke>/<parameter>,
  // stray "DSML" tokens, invented tags like <tool_check>). Accepting that as
  // a finished answer would end the run mid-task, so correct it instead.
  if (!native && looksLikeMalformedToolCall(emitted)) {
    loopState.malformedCount++;
    if (loopState.malformedCount > MAX_CONSECUTIVE_MALFORMED_TOOL_CALLS) {
      return {
        done: true,
        stopLoop: true,
        assistantText: `${fullContent}\n\n---\n**Stopped:** the model repeated an invalid/garbled tool-call format ${loopState.malformedCount} times in a row instead of using this app's expected format. This usually means the current model doesn't support this app's tool-calling protocol reliably — try switching models (\`/model\`) rather than retrying.`,
      };
    }
    localHistory.push({ role: 'user', content: MALFORMED_NUDGE });
    return { done: false, assistantText: fullContent, stopLoop: false };
  }
  loopState.malformedCount = 0;
  return { done: true, assistantText: fullContent, stopLoop: true };
}

function looksLikeMalformedToolCall(emitted: string): boolean {
  return /<\s*\/?[^a-zA-Z\n]{0,6}(invoke|parameter)\b/i.test(emitted) ||
    /\bDSML\b/i.test(emitted) ||
    /<\s*(?!tool_call\s+name\s*=)(tool[_-]?\w*|function[_-]?call)\b/i.test(emitted);
}

/** Groups consecutive read-only calls so they run concurrently; anything with
 *  side effects (or an approval prompt) runs alone, in order. */
export function batchToolCalls(calls: PendingToolCall[]): PendingToolCall[][] {
  const batches: PendingToolCall[][] = [];
  for (const call of calls) {
    const last = batches[batches.length - 1];
    if (isParallelSafe(call) && last && isParallelSafe(last[0])) last.push(call);
    else batches.push([call]);
  }
  return batches;
}

function isParallelSafe(call: PendingToolCall): boolean {
  return READ_ONLY_TOOLS.has(call.name) || (call.name === 'task' && isParallelSafeTask(call.args));
}

/** Client-side errors (unsupported model, bad credentials, invalid request)
 *  that will fail identically on every retry. Overload/rate-limit/network
 *  errors stay retryable. */
export function isPermanentError(e: any): boolean {
  const msg = String(e?.message || e);
  if (/overloaded|rate.?limit|timed? ?out|ECONNRESET|ETIMEDOUT|socket hang up|\b(429|5\d\d)\b/i.test(msg)) return false;
  return /does not support this model|or newer is required|\b(400|401|403|404)\b|invalid[_ ]request|authentication|invalid (x-)?api.?key/i.test(msg);
}

/** Heuristic for "this model can't take image input". */
export function looksLikeImagesUnsupported(e: any): boolean {
  const msg = String(e?.message || e);
  return /\b(400|404|422)\b/.test(msg) && /image|vision|multimodal|image_url/i.test(msg);
}

/** Heuristic for "this endpoint/model doesn't accept the tools parameter". */
export function looksLikeToolsUnsupported(e: any): boolean {
  const msg = String(e?.message || e);
  return /\((400|404|422)\)/.test(msg) && /tool|function/i.test(msg) && /support|invalid|unknown|unrecognized|not allowed|extra/i.test(msg);
}
