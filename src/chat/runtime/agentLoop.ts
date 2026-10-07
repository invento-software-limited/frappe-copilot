import { Message, Session } from '../../types';
import { AgentDefinition } from '../../agents/types';
import { VerificationOutcome } from '../../agents/verification';
import { writePlanFile, deriveTitle } from '../../agents/planStore';
import { workspaceRoot } from '../projectContext';
import type { AgentRuntime } from './agentRuntime';
import { newLoopState, RunOptions, RunOutcome, RunScope } from './types';

/** Runs one agent's tool loop in isolation — its own tool allowlist and its
 *  own transcript, never written turn-by-turn into messages.jsonl. It keeps
 *  going, with no step cap, until the model stops calling tools, the user
 *  aborts, or a stream error ends it. When the run finishes, exactly one
 *  summarized assistant turn joins the session and the full transcript is
 *  saved alongside it. */
export class AgentLoop {
  constructor(private rt: AgentRuntime) {}

  async run(agent: AgentDefinition, session: Session, userMessage: string, opts: RunOptions = {}): Promise<RunOutcome> {
    const { sessions, todos } = this.rt.deps;
    const scope: RunScope = {
      agent, session, userMessage,
      runId: sessions.generateRunId(),
      root: workspaceRoot(),
      baseHistory: sessions.buildEffectiveHistory(session.id),
      localHistory: [],
      touchedFiles: [],
      checkpoint: [],
      loopState: newLoopState(),
    };
    this.rt.graph.startRun(scope.runId, agent, opts);

    // Picked once per run so the system prompt stays byte-identical across
    // steps (prompt cache hits) and the model needn't spend a call on use_skill.
    this.rt.skills.begin(userMessage, requestedSkills(sessions.readMessages(session.id)));
    todos.bind(session);
    this.rt.prompts.todoContext = todos.tracker.carryOver();
    todos.tracker.beginRun();
    todos.send();

    const looped = await this.loop(scope);
    const done = looped.done;
    let lastText = looped.lastText;
    // Whatever is still open survives into the next run instead of lingering forever.
    todos.tracker.markInterrupted();
    todos.send();

    let verification: VerificationOutcome | null = null;
    if (opts.verify && done && scope.touchedFiles.length > 0) {
      const verified = await this.rt.verification.run(scope, lastText);
      verification = verified.outcome;
      lastText = verified.lastAssistantText;
    }
    this.rt.graph.finishRun(scope.runId, !!verification && verification.ran && !verification.passed);
    this.persist(scope, opts, summarize(lastText, done, verification), done);
    return { runId: scope.runId, done, verification };
  }

  private async loop(scope: RunScope): Promise<{ done: boolean; lastText: string }> {
    const { ui, control, todos } = this.rt.deps;
    let lastText = '';
    let done = false;
    let step = 0;
    while (!done) {
      if (control.aborted) {
        ui.chat('system', '⏹️ Execution cancelled by user.');
        break;
      }
      const result = await this.rt.steps.run(scope, String(++step));
      if (result.assistantText.trim()) lastText = result.assistantText;
      done = result.done;
      // Finishing with open todos: send the agent back once to reconcile them.
      const nudge = done && !control.aborted && scope.agent.allowedTools.includes('update_todo_list')
        ? todos.tracker.endOfRunNudge() : null;
      if (nudge) {
        scope.localHistory.push({ role: 'user', content: nudge });
        done = false;
        continue;
      }
      if (result.stopLoop) break;
      if (!done && !(await this.rt.budget.allowNextStep(control.signal))) {
        ui.chat('system', '⏹️ Stopped at your request.');
        break;
      }
    }
    return { done, lastText };
  }

  /** Folds the run back into the session as one summarized turn, and saves
   *  the transcript and file checkpoint next to it. */
  private persist(scope: RunScope, opts: RunOptions, summary: string, done: boolean): void {
    const { sessions } = this.rt.deps;
    let planPath: string | undefined;
    // An architecture run's output is a plan worth keeping as a file.
    if (scope.agent.id === 'architecture' && done && summary.trim()) {
      const record = writePlanFile({
        kind: 'architecture',
        title: deriveTitle(scope.userMessage),
        sessionId: scope.session.id,
        sessionName: scope.session.name,
        promptId: opts.promptId,
        body: summary,
      });
      if (record) {
        planPath = record.relPath;
        summary += `\n\n---\n📄 Plan saved to \`${record.relPath}\``;
      }
    }
    if (summary.trim()) {
      sessions.appendMessage(scope.session.id, {
        role: 'assistant',
        content: summary,
        agentId: scope.agent.id,
        runId: scope.runId,
        hasCheckpoint: scope.checkpoint.length > 0,
        promptId: opts.promptId,
        ...(planPath ? { planPath } : {}),
      });
    }
    sessions.writeRunTranscript(scope.session.id, scope.runId, scope.localHistory);
    if (scope.checkpoint.length > 0) sessions.writeCheckpoint(scope.session.id, scope.runId, scope.checkpoint);
  }
}

/** The run's final reply, plus how it ended and what verification found. */
export function summarize(lastText: string, done: boolean, verification: VerificationOutcome | null): string {
  let summary = lastText;
  if (!done) {
    // Always say something — a run that just stops with no text is a mystery.
    summary = (summary.trim() ? summary + '\n\n' : '') +
      '_(execution stopped before completing — cancelled or a stream error occurred; see any error above)_';
  }
  if (verification?.ran) {
    summary += verification.passed
      ? `\n\n---\n**Verification passed** (${verification.roundsUsed} attempt(s)).`
      : `\n\n---\n**Verification FAILED** after ${verification.roundsUsed} attempt(s). Last error:\n\`\`\`\n${(verification.lastError || '').slice(0, 2000)}\n\`\`\``;
  } else if (verification?.skippedReason) {
    summary += `\n\n_(Verification skipped: ${verification.skippedReason}.)_`;
  }
  if (verification?.missingTestNotes.length) {
    summary += `\n\n${verification.missingTestNotes.map(n => `_${n}_`).join('\n')}`;
  }
  return summary;
}

/** Skills the user asked for anywhere in the session — they stay loaded for
 *  every later turn, the way a "/" skill does in Claude Code. */
function requestedSkills(messages: Message[]): string[] {
  return [...new Set(messages.flatMap(m => (m.role === 'user' && m.skills) || []))];
}
