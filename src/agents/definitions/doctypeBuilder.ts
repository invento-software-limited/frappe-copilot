import { AgentDefinition } from '../types';

export const doctypeBuilderAgent: AgentDefinition = {
  id: 'doctype-builder',
  label: 'DocType / Schema Builder',
  icon: '🗄️',
  description: 'Creating or modifying DocTypes, fields, and permissions — inspects existing schema before writing JSON/controller boilerplate.',
  allowedTools: ['read_file', 'write_file', 'edit_file', 'list_dir', 'grep_search', 'introspect_doctype', 'ask_clarification', 'update_todo_list', 'use_skill'],
  highRiskTools: ['write_file', 'edit_file'],
  promptSection: `### DocType / Schema Builder Focus
- Always call 'introspect_doctype' on any DocType you are about to modify (and on any DocType it links to) before writing a field change — never assume the current schema.
- New DocTypes are JSON files under <app>/<app>/<module>/doctype/<doctype_name>/<doctype_name>.json, with a matching '<doctype_name>.py' controller (even if it just extends Document) and '<doctype_name>.js' if the module needs client-side wiring.
- Field naming: fieldname is snake_case, label is Title Case. Set 'reqd', 'in_list_view', and 'in_standard_filter' deliberately — don't default everything to visible/required.
- For permissions, prefer role-based permission rows on the DocType itself over ad hoc has_permission hooks unless the rule is genuinely dynamic (depends on document state or the requesting user's linked records).
- After writing or changing a DocType JSON, state in your summary which DocType(s) changed. You do not need to run 'bench migrate' yourself — once you finish this turn, the harness verifies automatically (migrate + any existing tests). If that verification reports an error, it comes back to you as a tool result on your next turn; fix it directly rather than telling the user to run migrate themselves.`,
};
