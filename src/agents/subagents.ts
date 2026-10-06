import { AgentDefinition, ToolName } from './types';
import { AGENTS } from './registry';

/** Tools a sub-agent never gets: it can't talk to the user, can't clobber the
 *  parent's todo list, and can't spawn further sub-agents. */
const PARENT_ONLY: ReadonlySet<ToolName> = new Set<ToolName>(['task', 'ask_clarification', 'update_todo_list']);

const SUBAGENT_MODE = `### Sub-agent Mode
You were started by the main agent to handle one delegated task. The user does not see your messages — only your final reply is returned to the main agent. Work autonomously; you cannot ask clarifying questions. No automatic verification runs after you finish: if you can run commands, run bench migrate / the relevant tests yourself; otherwise list what the main agent must verify. When done, reply with a complete, self-contained report: what you found or changed (with file paths and line numbers), anything you could not do, and anything the main agent must follow up on.`;

export const EXPLORE_AGENT: AgentDefinition = {
  id: 'explore',
  label: 'Explore',
  icon: '🧭',
  description: 'Fast read-only codebase investigation: finds where things are defined and used, how a feature works, and which files a change will touch. Cannot modify anything. Several can run in parallel.',
  promptSection: `### Explore Focus
- Search broadly first (grep_search with files_with_matches, glob), then read only the relevant parts.
- Run independent searches and reads in the same turn — they execute in parallel.
- Report concrete locations (path:line) and short excerpts, not whole files.`,
  allowedTools: ['read_file', 'list_dir', 'grep_search', 'glob', 'introspect_doctype', 'list_customizations', 'list_doctypes', 'search_knowledge', 'web_search', 'web_fetch', 'use_skill'],
  highRiskTools: [],
  maxEffort: 'medium',
};

/** Sub-agent types the main agent can delegate to: explore plus every
 *  specialist except the general fallback (that's the main agent itself). */
export const SUBAGENT_TYPES: AgentDefinition[] = [EXPLORE_AGENT, ...AGENTS.filter(a => a.id !== 'general')];

/** Resolves a sub-agent type into a runnable definition with parent-only
 *  tools stripped and sub-agent instructions appended. */
export function buildSubagent(type: string): AgentDefinition | null {
  const base = SUBAGENT_TYPES.find(a => a.id === type);
  if (!base) return null;
  return {
    ...base,
    allowedTools: base.allowedTools.filter(t => !PARENT_ONLY.has(t)),
    highRiskTools: base.highRiskTools.filter(t => !PARENT_ONLY.has(t)),
    promptSection: [base.promptSection, SUBAGENT_MODE].filter(Boolean).join('\n\n'),
  };
}

/** Explore sub-agents have no side effects or approval prompts, so several
 *  can run concurrently; anything else runs alone. */
export function isParallelSafeTask(args: Record<string, any>): boolean {
  return String(args?.subagent_type || '') === EXPLORE_AGENT.id;
}

export function subagentCatalog(): string {
  return SUBAGENT_TYPES.map(a => `- ${a.id}: ${a.description}`).join('\n');
}
