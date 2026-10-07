import * as vscode from 'vscode';
import { Session } from '../../types';
import { AGENTS, GENERAL_AGENT } from '../../agents/registry';
import { reviseStagesWithComments, StagePlan } from '../../agents/planner';
import { writePlanFile, updatePlanFile, appendPlanDecision, parsePlanComments, deriveTitle } from '../../agents/planStore';
import type { AgentRuntime } from './agentRuntime';

type DisplayStage = { agentId: string; label: string; icon: string; task: string };

/** A StagePlan's bare agentId resolved into what the approval card shows. */
function toDisplayStages(stages: StagePlan[]): DisplayStage[] {
  return stages.map(s => {
    const agent = AGENTS.find(a => a.id === s.agentId) || GENERAL_AGENT;
    return { agentId: agent.id, label: agent.label, icon: agent.icon, task: s.task };
  });
}

/** Multi-stage plans: saved to .frappe-copilot/plans/, approved by the user
 *  (always — ask/auto mode only governs tool calls inside a stage), then run
 *  stage by stage, each verified before the next starts. */
export class PipelineRunner {
  constructor(private rt: AgentRuntime) {}

  /** Blocks on plan approval, looping on "revise" — which reads the user's
   *  `COMMENT:` lines from the plan file, asks the model for updated stages
   *  and re-shows the card — until the user approves or rejects. */
  async runApproved(initialStages: StagePlan[], session: Session, userMessage: string, promptId?: string): Promise<void> {
    const { ui, approvals, provider } = this.rt.deps;
    let stages = initialStages;
    const title = deriveTitle(userMessage);
    const plan = writePlanFile({ kind: 'pipeline', title, sessionId: session.id, sessionName: session.name, promptId, stages: toDisplayStages(stages) });
    const planFileUri = plan ? vscode.Uri.file(plan.absPath).toString() : null;
    let revision = 0;

    while (true) {
      const decision = await approvals.requirePlan({ stages: toDisplayStages(stages), planPath: plan?.relPath ?? null, planFileUri });
      if (decision === 'revise') {
        if (!plan) {
          ui.chat('system', '⚠️ Can\'t revise — the plan file couldn\'t be saved (no workspace open?). Approve or reject to continue.');
          continue;
        }
        const comments = parsePlanComments(plan.absPath);
        if (comments.length === 0) {
          ui.chat('system', 'ℹ️ No `COMMENT:` lines found in the plan file — add one directly below the stage you want changed, save the file, then click **Revise from comments** again.');
          continue;
        }
        ui.chat('system', `🔄 Revising plan from ${comments.length} comment(s)...`);
        const revised = await reviseStagesWithComments(provider, stages, comments, AGENTS);
        if (!revised) {
          ui.chat('system', '⚠️ Revision failed (unparseable model response) — showing the plan unchanged.');
          continue;
        }
        stages = revised;
        updatePlanFile(plan, { title, sessionId: session.id, sessionName: session.name, promptId, stages: toDisplayStages(stages) }, ++revision);
        continue;
      }

      const approved = decision === 'approved';
      if (plan) appendPlanDecision(plan.absPath, approved ? 'approved' : 'rejected');
      if (!approved) {
        ui.chat('system', `🚫 Plan rejected — no stages started.${plan ? ` (Saved at \`${plan.relPath}\`.)` : ''}`);
        return;
      }
      await this.runStages(stages, session, promptId);
      return;
    }
  }

  /** Runs approved stages in order on one chained graph. Stops rather than
   *  building on a broken foundation if a stage fails verification or ends early. */
  private async runStages(stages: StagePlan[], session: Session, promptId?: string): Promise<void> {
    const { ui, sessions, control } = this.rt.deps;
    const resolved = stages.map(s => ({ agent: AGENTS.find(a => a.id === s.agentId) || GENERAL_AGENT, task: s.task }));
    const total = resolved.length;
    let precedingRunId: string | undefined;

    for (let i = 0; i < total; i++) {
      if (control.aborted) break;
      const { agent, task } = resolved[i];
      ui.say('featureStageStarted', { index: i, total, agentId: agent.id, label: agent.label, icon: agent.icon, task });
      // Earlier stages' summaries are already in the history; this tells the
      // model its OWN stage's scope.
      sessions.appendMessage(session.id, { role: 'user', content: `[Pipeline — Stage ${i + 1}/${total}: ${agent.label}]\n${task}` });

      const outcome = await this.rt.loop.run(agent, session, task, {
        verify: true, resetGraph: i === 0, precedingRunId, graphLabelPrefix: `Stage ${i + 1}/${total}:`, promptId,
      });
      precedingRunId = outcome.runId;
      ui.say('featureStageFinished', {
        index: i, total, agentId: agent.id, label: agent.label,
        verificationPassed: outcome.verification?.passed ?? null,
      });

      const remaining = resolved.slice(i + 1).map(s => s.agent.label).join(', ') || '(none)';
      if (outcome.verification && outcome.verification.ran && !outcome.verification.passed) {
        ui.chat('system', `⏹️ Pipeline stopped after stage ${i + 1}/${total} (${agent.label}) — verification did not pass. Remaining stage(s) not started: ${remaining}.`);
        ui.say('featurePipelineStopped', { atStage: i, reason: 'verification-failed' });
        return;
      }
      if (!outcome.done) {
        ui.chat('system', `⏹️ Pipeline stopped after stage ${i + 1}/${total} (${agent.label}) — it was cancelled or hit a stream error before completing.`);
        ui.say('featurePipelineStopped', { atStage: i, reason: 'stage-incomplete' });
        return;
      }
    }
    ui.say('featurePipelineFinished', { stages: total });
  }
}
