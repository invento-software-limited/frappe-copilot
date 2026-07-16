import { AgentDefinition } from '../types';

export const clientUiAgent: AgentDefinition = {
  id: 'client-ui',
  label: 'Client-side / UI',
  icon: '🖥️',
  description: 'Client scripts, desk form customizations, portal pages, and JS.',
  allowedTools: ['read_file', 'write_file', 'edit_file', 'list_dir', 'grep_search', 'ask_clarification', 'update_todo_list', 'use_skill'],
  highRiskTools: ['write_file', 'edit_file'],
  promptSection: `### Client-side / UI Focus
- Client scripts live in a DocType's <doctype>.js (form events: refresh, validate, field triggers) or as a standalone Client Script record — grep_search for the existing pattern before adding a new one.
- Use frm.set_value, frm.set_df_property, frm.add_custom_button, and frappe.call for server round-trips — avoid direct DOM manipulation of Frappe's own form fields.
- Portal pages (www/ directory) follow Frappe's Jinja + JS controller convention — check for an existing .py context file alongside the .html/.js before assuming the page is static.
- Keep client-side validation as a UX convenience only; the authoritative validation must exist server-side — flag it if you notice logic that only exists client-side.`,
};
