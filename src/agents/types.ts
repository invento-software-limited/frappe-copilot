/** Names of tools an agent may be granted access to. Kept in sync with the
 *  tool-call handling in ToolExecutor.runTool and the docs in prompts.ts. */
export type ToolName =
  | 'read_file' | 'write_file' | 'edit_file' | 'list_dir' | 'grep_search'
  | 'execute_command' | 'introspect_doctype' | 'ask_clarification'
  | 'update_todo_list' | 'web_search' | 'web_fetch' | 'use_skill'
  | 'list_customizations' | 'write_custom_field' | 'write_property_setter'
  | 'write_client_script' | 'write_server_script' | 'export_customizations'
  | 'write_builder_page' | 'call_mcp_tool' | 'scaffold_app' | 'scaffold_doctype'
  | 'glob' | 'multi_edit' | 'command_output' | 'kill_command'
  | 'task' | 'search_knowledge' | 'list_doctypes'
  | 'browser' | 'browser_action';

export const ALL_TOOLS: ToolName[] = [
  'read_file', 'write_file', 'edit_file', 'list_dir', 'grep_search',
  'execute_command', 'introspect_doctype', 'ask_clarification',
  'update_todo_list', 'web_search', 'web_fetch', 'use_skill',
  'list_customizations', 'write_custom_field', 'write_property_setter',
  'write_client_script', 'write_server_script', 'export_customizations',
  'write_builder_page', 'call_mcp_tool', 'scaffold_app', 'scaffold_doctype',
  'glob', 'multi_edit', 'command_output', 'kill_command',
  'task', 'search_knowledge', 'list_doctypes',
  'browser', 'browser_action',
];

/** Tools with no side effects — safe to run concurrently within one step. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set<ToolName>([
  'read_file', 'list_dir', 'grep_search', 'glob', 'introspect_doctype',
  'list_customizations', 'web_search', 'web_fetch', 'use_skill', 'command_output',
  'search_knowledge', 'list_doctypes',
]);

/** A task-specialized agent: its own scoped system prompt and tool allowlist,
 *  run as an isolated loop (see runAgentLoop in panel.ts) that continues until
 *  it stops calling tools, is aborted, or a stream error occurs. */
export interface AgentDefinition {
  id: string;
  label: string;
  icon: string;
  /** One-liner shown to the router when classifying a request. */
  description: string;
  /** Domain-specific guidance appended to the shared preamble. */
  promptSection: string;
  exampleInteraction?: string;
  allowedTools: ToolName[];
  /** Subset of allowedTools that still requires user approval before running. */
  highRiskTools: ToolName[];
  model?: string;
  /** Upper bound on reasoning effort for this agent's runs. */
  maxEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}
