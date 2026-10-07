import { buildSubagent, SUBAGENT_TYPES } from '../../agents/subagents';
import type { AgentRuntime } from './agentRuntime';
import { newLoopState, RunScope, ToolOutcome } from './types';

/** A sub-agent that hasn't finished by now is stuck or over-scoped. */
export const MAX_SUBAGENT_STEPS = 40;

/** Runs a delegated task (the `task` tool) as an isolated agent run with a
 *  fresh transcript and returns its final reply as the tool result. File
 *  changes land in the parent's checkpoint so "revert" still covers them. */
export class SubagentRunner {
  constructor(private rt: AgentRuntime) {}

  async run(parent: RunScope, args: Record<string, any>): Promise<ToolOutcome> {
    const { ui, sessions, control } = this.rt.deps;
    const type = String(args.subagent_type || 'explore');
    const agent = buildSubagent(type);
    if (!agent) return { success: false, output: `Unknown subagent_type '${type}'. Available: ${SUBAGENT_TYPES.map(a => a.id).join(', ')}` };
    const prompt = String(args.prompt || '').trim();
    if (!prompt) return { success: false, output: 'Missing prompt — give the sub-agent a complete task brief.' };
    const description = String(args.description || agent.label);

    const scope: RunScope = {
      ...parent,
      agent,
      userMessage: prompt,
      runId: sessions.generateRunId(),
      baseHistory: [],
      localHistory: [{ role: 'user', content: prompt }],
      loopState: newLoopState(),
    };
    ui.chat('system', `${agent.icon} Sub-agent **${agent.label}** started: ${description}`);
    this.rt.graph.startSubagent(scope.runId, parent.runId, agent, description);

    let report = '';
    let done = false;
    for (let step = 1; step <= MAX_SUBAGENT_STEPS && !control.aborted; step++) {
      const r = await this.rt.steps.run(scope, `${scope.runId}-${step}`);
      if (r.assistantText.trim()) report = r.assistantText;
      if (r.done) { done = true; break; }
      if (r.stopLoop) break;
    }
    sessions.writeRunTranscript(parent.session.id, scope.runId, scope.localHistory);
    this.rt.graph.finishNode(scope.runId, done);
    ui.chat('system', `${agent.icon} Sub-agent **${agent.label}** ${done ? 'finished' : 'stopped'}: ${description}`);
    if (!done) {
      const why = control.aborted ? 'cancelled by the user' : 'step limit or repeated errors';
      return { success: false, output: `${report ? report + '\n\n' : ''}[Sub-agent stopped before finishing: ${why}.]`, subRunId: scope.runId };
    }
    return { success: true, output: report || '(sub-agent finished without a report)', subRunId: scope.runId };
  }
}
