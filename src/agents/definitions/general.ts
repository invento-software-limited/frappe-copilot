import { AgentDefinition, ALL_TOOLS } from '../types';

/** Fallback agent with full tool access — the exact behavior Frappe Copilot had
 *  before task-specialized agents existed. Used when multi-agent routing is
 *  disabled, or when the router can't confidently classify a request. */
export const generalAgent: AgentDefinition = {
  id: 'general',
  label: 'General',
  icon: '🤖',
  description: 'Main agent with full tool access — handles any request end to end, and delegates to sub-agents when that helps.',
  promptSection: `### Frappe Essentials
- **New app / new DocType**: scaffold_app / scaffold_doctype first (there is no 'bench new-doctype'); then read_file + edit_file the generated JSON, controller, and JS. Never hand-write hooks.py/pyproject.toml/modules.txt from scratch.
- **Before changing a DocType**: introspect_doctype it (and the DocTypes it links to); list_doctypes to confirm exact names.
- **Standard DocTypes you don't own** (Sales Order, Customer, …): never edit their JSON. list_customizations, then write_custom_field / write_property_setter with 'module' set, then export_customizations to the same module so the change is versioned. Client/server behavior goes in the app's hooks (doc_events, doctype_js) or write_client_script / write_server_script.
- **After DocType JSON changes**: run bench --site <site> migrate, then the relevant tests (bench --site <site> run-tests --app <app> --doctype "<DocType>"). Builds: bench build --app <app>.
- **Server code**: frappe.db.get_value / get_all / exists for reads, frappe.get_doc when you need document behavior. Whitelisted endpoints validate permissions explicitly and never interpolate client input into SQL. Wire hooks through hooks.py, not import-time monkey-patching.
- **Client code**: frappe.ui.form.on with frm.set_value / set_df_property / add_custom_button / frappe.call — no direct DOM manipulation of form fields.
- Unsure of an API? search_knowledge, or grep the installed frappe/erpnext apps for a real usage, before writing it.`,
  exampleInteraction: `User: "Find all custom server scripts in my app"
Assistant: "I will use grep search to look for server script calls in hooks.py first."
<tool_call name="grep_search">
  <pattern>fixtures</pattern>
  <glob>hooks.py</glob>
</tool_call>`,
  allowedTools: ALL_TOOLS,
  highRiskTools: ['write_file', 'edit_file', 'multi_edit', 'execute_command', 'write_custom_field', 'write_property_setter', 'write_client_script', 'write_server_script', 'export_customizations', 'write_builder_page', 'call_mcp_tool'],
};
