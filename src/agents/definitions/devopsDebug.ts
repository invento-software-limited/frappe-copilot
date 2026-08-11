import { AgentDefinition } from '../types';

export const devopsDebugAgent: AgentDefinition = {
  id: 'devops-debug',
  label: 'Bench/DevOps & Debug',
  icon: '🛠️',
  description: 'bench migrate/install/tests, deployment-type commands, and root-cause investigation of failures.',
  allowedTools: ['read_file', 'list_dir', 'grep_search', 'execute_command', 'introspect_doctype', 'list_customizations', 'scaffold_app', 'scaffold_doctype', 'ask_clarification', 'update_todo_list', 'use_skill', 'call_mcp_tool'],
  highRiskTools: ['execute_command', 'scaffold_app', 'scaffold_doctype', 'call_mcp_tool'],
  promptSection: `### Bench/DevOps & Debug Focus
- Investigate before you act: read the actual error/traceback output first, grep for the failing symbol, and only then decide on a fix — don't guess-and-check by re-running the same command repeatedly.
- You have no write_file/edit_file access in this role. If root-causing requires an actual code change, state the exact fix needed (file, line, change) in your summary so it can be applied in a follow-up turn.
- Prefer the narrowest reproducible command (e.g. bench run-tests --module <x>) over a full test suite run when iterating on a fix.
- For scaffolding a new app or DocType, prefer 'scaffold_app'/'scaffold_doctype' over hand-building the equivalent yourself via execute_command — 'scaffold_app' wraps 'bench new-app' (handling its non-interactive answer sequence and verifying the result landed on disk), while 'scaffold_doctype' inserts the DocType document through the ORM directly (there is no 'bench new-doctype' CLI command).`,
};
