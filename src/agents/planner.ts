import { Message } from '../types';
import { LLMProvider } from '../providers/interface';
import { AgentDefinition } from './types';
import { formatHistory, parseAgentId } from './router';

export interface StagePlan {
  agentId: string;
  task: string;
}

export interface PlanResult {
  kind: 'single' | 'plan';
  agentId?: string;
  stages?: StagePlan[];
  reasoning?: string;
}

const MAX_STAGES = 6;
const STAGE_LINE = /^STAGE:\s*([a-z0-9-]+)\s*\|\s*(.+)$/i;

function buildPlannerPrompt(agents: AgentDefinition[]): string {
  const roster = agents
    .map(a => `- ${a.id}: ${a.label} — ${a.description}`)
    .join('\n');
  return `You are a routing/planning classifier for Frappe Copilot, a Frappe/ERPNext coding assistant. Given the user's latest message (and recent conversation for context), decide how to handle it.

Available agents:
${roster}

Respond with EXACTLY one of the following:

1. If ONE specialist can handle the whole request, one line:
AGENT_ID: <id>

2. If the request spans multiple specialists needing an ordered pipeline (e.g. new DocTypes AND server logic AND client UI), respond with:
PLAN
STAGE: <agentId> | <one-line, concrete, scoped task for that stage — not the raw user request repeated; reference what the prior stage will have produced where relevant>
STAGE: <agentId> | <task>
END

Use 2-${MAX_STAGES} stages. If ambiguous or you're unsure, prefer a single AGENT_ID line over a plan.

Example, for "add a loyalty points feature":
PLAN
STAGE: doctype-builder | Design and create the DocType(s) needed to track customer loyalty points balances and point-earning transactions.
STAGE: server-logic | Implement whitelisted APIs and hooks to award and redeem loyalty points against the DocType(s) created in the previous stage.
STAGE: client-ui | Add client-side UI for the loyalty features built in the previous stages.
END`;
}

function parsePlan(raw: string, validIds: Set<string>): StagePlan[] | null {
  if (!/^PLAN\s*$/m.test(raw)) return null;
  const lines = raw.split('\n').map(l => l.trim());
  const start = lines.findIndex(l => l === 'PLAN');
  const end = lines.findIndex((l, i) => i > start && l === 'END');
  if (start === -1 || end === -1) return null;

  const stages: StagePlan[] = [];
  for (const line of lines.slice(start + 1, end)) {
    if (!line) continue;
    const match = line.match(STAGE_LINE);
    if (!match) return null; // any malformed line invalidates the whole plan — don't partially trust it
    const agentId = match[1].toLowerCase();
    if (!validIds.has(agentId)) return null;
    stages.push({ agentId, task: match[2].trim() });
  }

  if (stages.length === 0 || stages.length > MAX_STAGES) return null;
  return stages;
}

/** Classifies a user request into either a single agent (today's routeToAgent
 *  behavior) or an ordered multi-stage plan, via the same one cheap
 *  non-streaming completion — an extended response grammar, not an extra
 *  round-trip. Falls back to a single 'general' agent on anything ambiguous
 *  or unparseable, same safety net as routeToAgent. */
export async function routeOrPlan(
  provider: LLMProvider,
  userMessage: string,
  recentHistory: Message[],
  agents: AgentDefinition[]
): Promise<PlanResult> {
  const validIds = new Set(agents.map(a => a.id));
  const system = buildPlannerPrompt(agents) + formatHistory(recentHistory);

  try {
    const response = await provider.chat(
      [
        { role: 'system', content: system },
        { role: 'user', content: userMessage },
      ],
      { maxTokens: 400, temperature: 0 }
    );

    const stages = parsePlan(response.content, validIds);
    if (stages) {
      return { kind: 'plan', stages };
    }

    const agentId = parseAgentId(response.content, validIds);
    return agentId
      ? { kind: 'single', agentId }
      : { kind: 'single', agentId: 'general', reasoning: 'Unparseable or ambiguous planner response' };
  } catch (e: any) {
    return { kind: 'single', agentId: 'general', reasoning: `Planner call failed: ${e.message || String(e)}` };
  }
}
