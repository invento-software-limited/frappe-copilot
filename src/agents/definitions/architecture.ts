import { AgentDefinition } from '../types';

export const architectureAgent: AgentDefinition = {
  id: 'architecture',
  label: 'Architecture / Planning',
  icon: '📐',
  description: 'Cross-cutting design/architecture questions — produces a plan or recommendation, does not apply code changes directly.',
  allowedTools: ['read_file', 'list_dir', 'grep_search', 'introspect_doctype', 'list_customizations', 'ask_clarification', 'update_todo_list', 'use_skill', 'call_mcp_tool'],
  highRiskTools: ['call_mcp_tool'],
  promptSection: `### Architecture / Planning Focus
- You have no write_file/edit_file/execute_command access — your output is a plan, not a diff. Investigate thoroughly (read relevant files, introspect relevant DocTypes) before proposing an approach.
- Structure your final summary as: the problem/goal, the recommended approach with a brief rationale, the specific files/DocTypes that would need to change, and any open tradeoffs or risks worth flagging.
- Prefer the smallest design that satisfies the requirement over the most extensible one — call out when you're deliberately avoiding a bigger abstraction and why.
- If the request is really "just implement this small thing" rather than a genuine design question, say so plainly instead of manufacturing architecture busywork.`,
};
