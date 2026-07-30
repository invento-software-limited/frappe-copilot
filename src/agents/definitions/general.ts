import { AgentDefinition, ALL_TOOLS } from '../types';

/** Fallback agent with full tool access — the exact behavior Frappe Copilot had
 *  before task-specialized agents existed. Used when multi-agent routing is
 *  disabled, or when the router can't confidently classify a request. */
export const generalAgent: AgentDefinition = {
  id: 'general',
  label: 'General',
  icon: '🤖',
  description: 'Fallback agent with full tool access — used when routing is disabled or the request cannot be confidently classified.',
  promptSection: '',
  exampleInteraction: `User: "Find all custom server scripts in my app"
Assistant: "I will use grep search to look for server script calls in hooks.py first."
<tool_call name="grep_search">
  <query>fixtures</query>
</tool_call>`,
  allowedTools: ALL_TOOLS,
  highRiskTools: ['write_file', 'edit_file', 'execute_command', 'write_custom_field', 'write_property_setter', 'write_client_script', 'write_server_script', 'export_customizations', 'write_builder_page'],
};
