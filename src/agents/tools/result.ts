export interface ToolResult {
  success: boolean;
  output: string;
}

export function fail(output: string): ToolResult {
  return { success: false, output };
}

export function ok(output: string): ToolResult {
  return { success: true, output };
}
