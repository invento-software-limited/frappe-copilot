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

export function formatHistory(history: Message[]): string {
  if (history.length === 0) return '';
  const turns = history
    .filter(m => m.role !== 'system')
    .map(m => {
      const role = m.role === 'assistant' ? 'Assistant' : 'User';
      const snippet = m.content.length > 300 ? m.content.slice(0, 300) + '... [truncated]' : m.content;
      return `${role}: ${snippet}`;
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
