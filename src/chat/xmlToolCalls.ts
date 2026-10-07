export interface XmlToolCall {
  name: string;
  args: Record<string, string>;
  raw: string;
}

const TOOL_CALL = /<tool_call\s+name="(\w+)"\s*>([\s\S]*?)<\/tool_call>/g;
/** Some models (DeepSeek, models trained on Anthropic's format) slip into
 *  their own call syntax: <invoke name="x"><parameter name="p">v</parameter></invoke>,
 *  sometimes with a "｜DSML｜"-style prefix inside the tag. */
const PREFIX = String.raw`(?:[^\w\s<>"]{0,3}DSML[^\w\s<>"]{0,3})?`;
const INVOKE = new RegExp(String.raw`<${PREFIX}invoke\s+name="(\w+)"\s*>([\s\S]*?)<\/${PREFIX}invoke>`, 'g');
const INVOKE_PARAM = new RegExp(String.raw`<${PREFIX}parameter\s+name="(\w+)"[^>]*>([\s\S]*?)<\/${PREFIX}parameter>`, 'g');

/** Extracts tool calls written in the XML tool protocol. Calls in the
 *  `<invoke>` dialect count only when the reply has no `<tool_call>` at all —
 *  a stray `<invoke>` next to a real call must not run twice. */
export function parseXmlToolCalls(text: string): XmlToolCall[] {
  const calls = collect(text, TOOL_CALL, /<(\w+)>([\s\S]*?)<\/\1>/g);
  return calls.length ? calls : collect(text, INVOKE, INVOKE_PARAM);
}

/** The reply text with every tool-call block (either dialect, plus
 *  `<function_calls>` wrappers) removed — what the user should read. */
export function stripToolCallMarkup(text: string): string {
  return text
    .replace(TOOL_CALL, '')
    .replace(INVOKE, '')
    .replace(/<\/?tool_calls\s*>/g, '')
    .replace(new RegExp(String.raw`<\/?${PREFIX}function_calls\s*>`, 'g'), '');
}

function collect(text: string, callPattern: RegExp, paramPattern: RegExp): XmlToolCall[] {
  const calls: XmlToolCall[] = [];
  for (const match of text.matchAll(callPattern)) {
    const args: Record<string, string> = {};
    for (const param of match[2].matchAll(paramPattern)) {
      let val = param[2].trim();
      if (val.startsWith('<![CDATA[') && val.endsWith(']]>')) val = val.slice(9, -3);
      args[param[1]] = val;
    }
    calls.push({ name: match[1], args, raw: match[0] });
  }
  return calls;
}
