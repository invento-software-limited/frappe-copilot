import { AgentDefinition } from '../types';

export const doctypeBuilderAgent: AgentDefinition = {
  id: 'doctype-builder',
  label: 'DocType / Schema Builder',
  icon: '🗄️',
  description: 'Creating or modifying DocTypes, fields, and permissions — including Custom Fields and Property Setters on standard DocTypes — inspects existing schema before writing JSON/controller boilerplate.',
  allowedTools: ['read_file', 'write_file', 'edit_file', 'list_dir', 'grep_search', 'introspect_doctype', 'list_customizations', 'write_custom_field', 'write_property_setter', 'export_customizations', 'ask_clarification', 'update_todo_list', 'use_skill', 'call_mcp_tool'],
  highRiskTools: ['write_file', 'edit_file', 'write_custom_field', 'write_property_setter', 'export_customizations', 'call_mcp_tool'],
  promptSection: `### DocType / Schema Builder Focus
- Always call 'introspect_doctype' on any DocType you are about to modify (and on any DocType it links to) before writing a field change — never assume the current schema.
- New DocTypes are JSON files under <app>/<app>/<module>/doctype/<doctype_name>/<doctype_name>.json, with a matching '<doctype_name>.py' controller (even if it just extends Document) and '<doctype_name>.js' if the module needs client-side wiring.
- Field naming: fieldname is snake_case, label is Title Case. Set 'reqd', 'in_list_view', and 'in_standard_filter' deliberately — don't default everything to visible/required.
- For permissions, prefer role-based permission rows on the DocType itself over ad hoc has_permission hooks unless the rule is genuinely dynamic (depends on document state or the requesting user's linked records).
- **Customizing a standard/existing DocType (Sales Order, Customer, or any DocType you don't own the source of) is a different task from building a new one — do not write its JSON directly.** Call 'list_customizations' first to see what's already there, then use 'write_custom_field' / 'write_property_setter' for the change. These write straight to the live site's database (the same effect Customize Form has), which is not by itself tracked by version control.
- **Always set 'module' on write_custom_field / write_property_setter for a standard-DocType customization, and follow up with 'export_customizations' using that same module** — this is what actually turns the DB change into a versioned file (<app>/<app>/custom/<doctype>.json), the same effect as clicking "Export Customizations" in Customize Form. Don't just tell the user to export it themselves; do it as part of the same turn. Determine the target module from the app you're customizing into (check its modules.txt, or an existing custom/ folder for the convention already in use) rather than guessing — ask the user if it's genuinely ambiguous which app/module should own the customization. If export_customizations fails citing developer_mode, tell the user to enable it on that site (bench set-config -g developer_mode 1) rather than treating it as your own error.
- After writing or changing a DocType JSON, state in your summary which DocType(s) changed. You do not need to run 'bench migrate' yourself — once you finish this turn, the harness verifies automatically (migrate + any existing tests). If that verification reports an error, it comes back to you as a tool result on your next turn; fix it directly rather than telling the user to run migrate themselves.`,
};
