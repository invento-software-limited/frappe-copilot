import * as vscode from 'vscode';
import { ImageAttachment, Session } from '../../types';
import { AGENTS, GENERAL_AGENT } from '../../agents/registry';
import { ROUTER_CONTEXT_TURNS } from '../../agents/router';
import { routeOrPlan } from '../../agents/planner';
import { deriveTitle } from '../../agents/planStore';
import type { AgentRuntime } from './agentRuntime';

/** Entry point for one user prompt: records it, routes it to an agent (or a
 *  multi-stage plan in multi-agent mode) and runs it to completion. */
export class Orchestrator {
  constructor(private rt: AgentRuntime) {}

  async run(userMessage: string, images?: ImageAttachment[]): Promise<void> {
    const { ui, sessions, control, compaction } = this.rt.deps;
    control.begin();
    this.rt.budget.begin();
    const session = sessions.activeSession || sessions.createSession('Chat');
    // The prompt was sent from the chat on screen, so that's this run's session.
    ui.showingSession(session.id);
    const isFirstMessage = session.messageCount === 0;
    const promptId = sessions.generateRunId();
    sessions.appendMessage(session.id, { role: 'user', content: userMessage, promptId, ...(images?.length ? { images } : {}) });
    ui.liveRun.begin(session.id, sessions.readMessages(session.id).length);
    ui.say('agentState', { state: 'running' });
    // The webview already drew the user's bubble — tag it so a later
    // "revert this prompt" link can find it.
    ui.say('userPromptStarted', { promptId });
    if (isFirstMessage) this.nameSession(session, userMessage);

    try {
      await this.route(session, userMessage, promptId);
    } catch (e: any) {
      ui.chat('error', `Agent execution failed: ${e.message || String(e)}`);
    } finally {
      control.finish();
      ui.say('runUsage', this.rt.budget.totals);
      ui.say('agentState', { state: 'idle' });
      compaction.reportSessionSize(session);
      const producedCheckpoint = sessions.readMessages(session.id).some(m => m.promptId === promptId && m.hasCheckpoint);
      if (producedCheckpoint) ui.say('promptCheckpointReady', { promptId });
      ui.liveRun.end();
    }
  }

  private async route(session: Session, userMessage: string, promptId: string): Promise<void> {
    const multiAgent = vscode.workspace.getConfiguration('frappe-copilot').get<boolean>('multiAgent.enabled', false);
    if (!multiAgent) {
      await this.rt.loop.run(GENERAL_AGENT, session, userMessage, { promptId });
      return;
    }
    const { sessions, provider, ui } = this.rt.deps;
    const recentHistory = sessions.readMessages(session.id).slice(-ROUTER_CONTEXT_TURNS);
    const route = await routeOrPlan(provider, userMessage, recentHistory, AGENTS);
    if (route.kind === 'plan' && route.stages && route.stages.length > 1) {
      await this.rt.pipeline.runApproved(route.stages, session, userMessage, promptId);
      return;
    }
    const agentId = route.kind === 'single' ? route.agentId! : route.stages?.[0]?.agentId ?? 'general';
    const agent = AGENTS.find(a => a.id === agentId) || GENERAL_AGENT;
    ui.say('agentRouted', { agentId: agent.id, label: agent.label, icon: agent.icon, reasoning: route.reasoning });
    await this.rt.loop.run(agent, session, userMessage, { verify: true, promptId });
  }

  private nameSession(session: Session, userMessage: string): void {
    const { sessions } = this.rt.deps;
    const title = deriveTitle(userMessage, 30);
    sessions.renameSession(session.id, title === 'plan' ? 'Session ' + (sessions.sessions.length + 1) : title);
  }
}
