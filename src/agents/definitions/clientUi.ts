import { AgentDefinition } from '../types';

export const clientUiAgent: AgentDefinition = {
  id: 'client-ui',
  label: 'Client-side / UI',
  icon: '🖥️',
  description: 'Client scripts, desk form customizations, portal pages, and JS.',
  allowedTools: ['read_file', 'write_file', 'edit_file', 'list_dir', 'grep_search', 'introspect_doctype', 'list_customizations', 'write_client_script', 'ask_clarification', 'update_todo_list', 'use_skill', 'call_mcp_tool'],
  highRiskTools: ['write_file', 'edit_file', 'write_client_script', 'call_mcp_tool'],
  promptSection: `### Client-side / UI Focus
- Client scripts live in a DocType's <doctype>.js (form events: refresh, validate, field triggers) or as a standalone Client Script record — grep_search for the existing pattern before adding a new one.
- For a standard/existing DocType you don't own the app source of, there is no <doctype>.js to edit — call 'introspect_doctype' and 'list_customizations' to see its fields and any existing Client Script, then use 'write_client_script' instead of write_file. That writes straight to the live site's database (a Customize Form-equivalent change), not to a version-controlled file — mention that to the user if the app tracks customizations via fixtures.
- Use frm.set_value, frm.set_df_property, frm.add_custom_button, and frappe.call for server round-trips — avoid direct DOM manipulation of Frappe's own form fields.
- Portal pages (www/ directory) follow Frappe's Jinja + JS controller convention — check for an existing .py context file alongside the .html/.js before assuming the page is static.
- Keep client-side validation as a UX convenience only; the authoritative validation must exist server-side — flag it if you notice logic that only exists client-side.`,
};
