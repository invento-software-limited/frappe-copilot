import { Message } from '../types';
import { LLMProvider } from '../providers/interface';
import { AgentDefinition } from './types';

export interface RouteResult {
  agentId: string;
  reasoning?: string;
}

/** How many of the most recent transcript turns are shown to the router (and
 *  reused as the sub-agent's own conversational context) — enough for
 *  follow-ups like "now add a permission rule to that doctype" to resolve
 *  correctly, without shipping the whole session history for a cheap classify call. */
export const ROUTER_CONTEXT_TURNS = 6;

function buildRouterPrompt(agents: AgentDefinition[]): string {
  const roster = agents
    .map(a => `- ${a.id}: ${a.label} — ${a.description}`)
    .join('\n');
  return `You are a routing classifier for Frappe Copilot, a Frappe/ERPNext coding assistant. Given the user's latest message (and recent conversation for context), pick the ONE specialist agent best suited to handle it.

Available agents:
${roster}

Respond with EXACTLY one line in this format, nothing else:
AGENT_ID: <id>

If the request doesn't clearly fit a specialist, or spans multiple specialists equally, respond with:
AGENT_ID: general`;
}

/** Per-turn character budgets for the router/planner's view of the transcript.
 *  A flat 300-char head-only cut was too aggressive: an assistant turn here is
 *  a whole run's summary, and the part that resolves a follow-up ("created
 *  `apps/x/.../sales_visit.json`", "left the permission rule as a TODO") is in
 *  its closing lines, not its opening ones. Losing that made "now add a
 *  validation to that doctype" route to whichever agent the bare words
 *  suggested — often one with no write tools — which reads to the user as the
 *  assistant having forgotten the conversation. */
const RECENT_TURN_BUDGET = 4000;
const OLDER_TURN_BUDGET = 1200;
/** How many of the newest turns are passed through untrimmed-in-practice. */
const RECENT_TURNS = 2;

/** Trims the middle, not the tail, so both what a turn set out to do and what
 *  it concluded survive. */
function trimTurn(content: string, budget: number): string {
  if (content.length <= budget) return content;
  const head = Math.ceil(budget * 0.6);
  const tail = budget - head;
  return `${content.slice(0, head)}\n... [${content.length - budget} chars omitted] ...\n${content.slice(-tail)}`;
}

export function formatHistory(history: Message[]): string {
  const messages = history.filter(m => m.role !== 'system');
  if (messages.length === 0) return '';
  const firstRecent = messages.length - RECENT_TURNS;
  const turns = messages
    .map((m, i) => {
      const role = m.role === 'assistant' ? 'Assistant' : 'User';
      const budget = i >= firstRecent ? RECENT_TURN_BUDGET : OLDER_TURN_BUDGET;
      return `${role}: ${trimTurn(m.content, budget)}`;
    })
    .join('\n\n');
  return `\n\n### Recent conversation\n${turns}`;
}

export function parseAgentId(raw: string, validIds: Set<string>): string | null {
  const match = raw.match(/AGENT_ID:\s*([a-z0-9-]+)/i);
  if (!match) return null;
  const id = match[1].toLowerCase();
  return validIds.has(id) ? id : null;
}

/** Classifies a user request into one of `agents` via a single cheap, non-streaming
 *  completion. Falls back to 'general' on any ambiguous or unparseable response —
 *  this is the safety net that keeps routing failures from ever blocking the user. */
export async function routeToAgent(
  provider: LLMProvider,
  userMessage: string,
  recentHistory: Message[],
  agents: AgentDefinition[]
): Promise<RouteResult> {
  const validIds = new Set(agents.map(a => a.id));
  const system = buildRouterPrompt(agents) + formatHistory(recentHistory);

  try {
    const response = await provider.chat(
      [
        { role: 'system', content: system },
        { role: 'user', content: userMessage },
      ],
      { maxTokens: 50, temperature: 0 }
    );
    const agentId = parseAgentId(response.content, validIds);
    return agentId ? { agentId } : { agentId: 'general', reasoning: 'Unparseable or ambiguous router response' };
  } catch (e: any) {
    return { agentId: 'general', reasoning: `Router call failed: ${e.message || String(e)}` };
  }
}
