import { AgentDefinition } from './types';
import { doctypeBuilderAgent } from './definitions/doctypeBuilder';
import { serverLogicAgent } from './definitions/serverLogic';
import { clientUiAgent } from './definitions/clientUi';
import { devopsDebugAgent } from './definitions/devopsDebug';
import { researchAgent } from './definitions/research';
import { architectureAgent } from './definitions/architecture';
import { designAgent } from './definitions/design';
import { generalAgent } from './definitions/general';

/** Specialized agents first, general fallback last — order matters for the
 *  router prompt (specialists are offered before the catch-all). */
export const AGENTS: AgentDefinition[] = [
  doctypeBuilderAgent,
  serverLogicAgent,
  clientUiAgent,
  devopsDebugAgent,
  researchAgent,
  architectureAgent,
  designAgent,
  generalAgent,
];

export const GENERAL_AGENT = generalAgent;

export function getAgent(id: string): AgentDefinition {
  return AGENTS.find(a => a.id === id) || generalAgent;
}
