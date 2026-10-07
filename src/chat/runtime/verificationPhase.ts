import { isAutoApprove } from '../../agents/approvalMode';
import {
  VerificationOutcome, buildVerificationPlan, VERIFY_MAX_ROUNDS, VERIFY_FIX_STEP_BUDGET, migrateCmd,
} from '../../agents/verification';
import type { AgentRuntime } from './agentRuntime';
import { newLoopState, RunScope } from './types';

export interface VerificationResult {
  outcome: VerificationOutcome;
  lastAssistantText: string;
}

/** Harness-driven verification: bench migrate and scoped tests run directly
 *  (never through the model's own tools), behind one approval per run. On
 *  failure the real error goes back to the agent with a small fix budget, up
 *  to VERIFY_MAX_ROUNDS times, before it reports failure honestly. */
export class VerificationPhase {
  constructor(private rt: AgentRuntime) {}

  async run(scope: RunScope, lastText: string): Promise<VerificationResult> {
    const { benchEnv, tools, approvals, ui } = this.rt.deps;
    const skip = (skippedReason?: string, missingTestNotes: string[] = []): VerificationResult => ({
      outcome: { ran: false, passed: true, roundsUsed: 0, missingTestNotes, ...(skippedReason ? { skippedReason } : {}) },
      lastAssistantText: lastText,
    });

    const env = benchEnv();
    const site = env && env.type !== 'not-found' ? (await tools.sites.resolve()).site : null;
    if (!site) return skip('no site or bench environment configured');

    const plan = buildVerificationPlan(scope.touchedFiles, scope.root);
    if (!plan.shouldMigrate && plan.testCommands.length === 0) return skip(undefined, plan.missingTestNotes);

    if (!isAutoApprove()) {
      ui.say('verifyApprovalRequired', {
        runId: scope.runId,
        willMigrate: plan.shouldMigrate,
        testCommands: plan.testCommands.map(t => t.description),
      });
      if (!(await approvals.waitForTool())) return skip('declined by user', plan.missingTestNotes);
    }

    let roundsUsed = 0;
    let lastError = '';
    let passed = false;
    const fixState = newLoopState();
    for (let round = 0; round <= VERIFY_MAX_ROUNDS; round++) {
      roundsUsed = round + 1;
      const failure = await this.runChecks(scope.runId, roundsUsed, site, plan);
      if (failure === null) { passed = true; break; }
      lastError = failure;
      if (round >= VERIFY_MAX_ROUNDS) break;
      lastText = await this.fixRound({ ...scope, loopState: fixState }, roundsUsed, failure, lastText);
      if (this.rt.deps.control.aborted) break;
    }

    const outcome: VerificationOutcome = {
      ran: true, passed, roundsUsed,
      missingTestNotes: plan.missingTestNotes,
      lastError: passed ? undefined : lastError,
    };
    ui.say('verifyResult', {
      runId: scope.runId, passed, roundsUsed,
      missingTestNotes: outcome.missingTestNotes, lastError: outcome.lastError,
    });
    return { outcome, lastAssistantText: lastText };
  }

  /** Runs migrate then each test command, streaming output live. Returns the
   *  combined output on failure, or null when everything passed. */
  private async runChecks(runId: string, round: number, site: string, plan: ReturnType<typeof buildVerificationPlan>): Promise<string | null> {
    const { tools, ui } = this.rt.deps;
    ui.say('verifyRunning', { runId, round });
    const onChunk = (chunk: string) => ui.say('verifyOutputChunk', { runId, round, chunk });
    let output = '';
    if (plan.shouldMigrate) {
      const cmd = migrateCmd(site);
      onChunk(`$ ${cmd}\n`);
      const result = await tools.executeCommand(cmd, onChunk);
      output += `[migrate]\n${result.output}\n`;
      if (!result.success) return output;
    }
    for (const test of plan.testCommands) {
      const cmd = test.command(site);
      onChunk(`\n$ ${cmd}\n`);
      const result = await tools.executeCommand(cmd, onChunk);
      output += `[${test.description}]\n${result.output}\n`;
      if (!result.success) return output;
    }
    return null;
  }

  /** Hands the failure back to the agent for a few steps to fix it. `scope`
   *  shares the run's transcript but has its own failure counters. */
  private async fixRound(scope: RunScope, round: number, failure: string, lastText: string): Promise<string> {
    scope.localHistory.push({
      role: 'user',
      content: `<tool_result name="verify_run">\n[VERIFICATION FAILED - round ${round}]\n${failure}\nFix the issue above, then finish this turn (no further tool calls) once done. Verification will re-run automatically.\n</tool_result>`,
    });
    for (let step = 1; step <= VERIFY_FIX_STEP_BUDGET; step++) {
      if (this.rt.deps.control.aborted) break;
      const result = await this.rt.steps.run(scope, `fix-${round}-${step}`);
      if (result.assistantText.trim()) lastText = result.assistantText;
      if (result.done) break;
    }
    return lastText;
  }
}
