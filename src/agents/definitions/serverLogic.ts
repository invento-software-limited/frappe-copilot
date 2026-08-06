import { AgentDefinition } from '../types';

export const serverLogicAgent: AgentDefinition = {
  id: 'server-logic',
  label: 'Server-side Logic',
  icon: '🐍',
  description: 'Python controllers, hooks.py wiring, whitelisted APIs, background jobs, frappe.db/ORM usage, and Server Scripts.',
  allowedTools: ['read_file', 'write_file', 'edit_file', 'list_dir', 'grep_search', 'introspect_doctype', 'list_customizations', 'write_server_script', 'execute_command', 'ask_clarification', 'update_todo_list', 'use_skill', 'call_mcp_tool'],
  highRiskTools: ['write_file', 'edit_file', 'execute_command', 'write_server_script', 'call_mcp_tool'],
  promptSection: `### Server-side Logic Focus
- Prefer frappe.db.get_value / get_all / exists for read paths and frappe.get_doc only when you need full document behavior (validation, hooks, child tables) — get_all with filters is cheaper than looping over get_doc.
- Whitelisted endpoints: use @frappe.whitelist(), validate frappe.has_permission(...) explicitly if the endpoint bypasses the standard doctype permission model, and never trust client-supplied filters/SQL fragments directly.
- Wire new hooks (doc_events, scheduler_events, override_whitelisted_methods) through hooks.py rather than monkey-patching at import time.
- For logic that must attach to a standard/existing DocType you don't own the source of (no hooks.py entry point available), 'write_server_script' is the DB-level equivalent — call 'list_customizations' first to check for an existing one to update rather than creating a duplicate. Treat it as genuinely high-risk: it executes arbitrary Python against the live site the moment it's enabled, and many installs disable Server Script execution entirely (System Settings > enable_server_script) — say so if the write succeeds but the user reports nothing happening. Prefer hooks.py + app code whenever the app source is actually available to you; reach for write_server_script only when it isn't.
- Background or long-running work belongs in a queued job (frappe.enqueue), not inline in a request handler.
- You don't need to manually compile-check files or run 'bench migrate'/'run-tests' yourself — the harness checks syntax after every write automatically, and verifies (migrate + any existing tests) once your turn ends, feeding any real error back to you as a tool result to fix. Use 'execute_command' for actual investigation (e.g. a quick DB query or reading a log), not for checks the harness already runs for you.`,
};
