export interface XmlToolCall {
  name: string;
  args: Record<string, string>;
  raw: string;
}

/** Extracts `<tool_call name="…">` blocks written in the XML tool protocol. */
export function parseXmlToolCalls(text: string): XmlToolCall[] {
  const toolCalls: XmlToolCall[] = [];
  const regex = /<tool_call\s+name="(\w+)"\s*>([\s\S]*?)<\/tool_call>/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const args: Record<string, string> = {};
    const paramRegex = /<(\w+)>([\s\S]*?)<\/\1>/g;
    let paramMatch;
    while ((paramMatch = paramRegex.exec(match[2])) !== null) {
      let val = paramMatch[2].trim();
      if (val.startsWith('<![CDATA[') && val.endsWith(']]>')) val = val.slice(9, -3);
      args[paramMatch[1]] = val;
    }
    toolCalls.push({ name: match[1], args, raw: match[0] });
  }
  return toolCalls;
}
