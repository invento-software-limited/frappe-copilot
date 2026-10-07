import { ChatUi } from './chatUi';

export type PlanDecision = 'approved' | 'rejected' | 'revise';

export interface PlanApprovalPayload {
  stages: { agentId: string; label: string; icon: string; task: string }[];
  planPath: string | null;
  planFileUri: string | null;
}

/** Webview replies that settle whatever the run was waiting on. */
export const ANSWER_MESSAGES: ReadonlySet<string> = new Set([
  'toolApproved', 'toolRejected', 'planApproved', 'planRejected', 'planRevise', 'clarificationSubmitted', 'abort',
]);

const CANCELLED_ANSWER = '(The user cancelled the run before answering.)';

/** Everything a run can pause on until the user answers in the chat: a
 *  high-risk tool (or the verification gate), a multi-stage plan, and a
 *  clarifying question. Each is kept separate so one reply can never settle
 *  the wrong kind of wait. */
export class ApprovalGate {
  private pendingTool: ((approved: boolean) => void) | null = null;
  /** Unlike tool approvals, the plan gate ignores ask/auto mode — a plan
   *  always needs a yes before any stage starts. */
  private pendingPlan: ((decision: PlanDecision) => void) | null = null;
  private pendingQuestion: ((answers: string) => void) | null = null;
  /** Tools the user chose "always allow" for in this session. */
  private alwaysAllowed = new Set<string>();

  constructor(private ui: ChatUi) {}

  isAlwaysAllowed(tool: string): boolean {
    return this.alwaysAllowed.has(tool);
  }

  clearAlwaysAllowed(): void {
    this.alwaysAllowed.clear();
  }

  /** Parks the run until the user approves or rejects (the card is already shown). */
  waitForTool(): Promise<boolean> {
    this.ui.say('agentState', { state: 'paused' });
    return new Promise(resolve => { this.pendingTool = resolve; });
  }

  requirePlan(payload: PlanApprovalPayload): Promise<PlanDecision> {
    this.ui.say('planApprovalRequired', payload);
    this.ui.say('agentState', { state: 'paused' });
    return new Promise(resolve => { this.pendingPlan = resolve; });
  }

  ask(questions: string): Promise<string> {
    this.ui.say('showClarificationPopup', { questions });
    this.ui.say('agentState', { state: 'paused' });
    return new Promise(resolve => { this.pendingQuestion = resolve; });
  }

  /** Settles the matching wait for a webview reply. Returns false when the
   *  message isn't an answer at all. */
  answer(msg: any): boolean {
    switch (msg.type) {
      case 'toolApproved':
        if (msg.always && typeof msg.tool === 'string') this.alwaysAllowed.add(msg.tool);
        this.settleTool(true);
        return true;
      case 'toolRejected':
        this.settleTool(false);
        return true;
      case 'planApproved':
        this.settlePlan('approved', true);
        return true;
      case 'planRejected':
        this.settlePlan('rejected', true);
        return true;
      case 'planRevise':
        // Stays paused — the revised plan is re-shown as a fresh card.
        this.settlePlan('revise', false);
        return true;
      case 'clarificationSubmitted':
        if (this.pendingQuestion) {
          this.ui.say('agentState', { state: 'running' });
          this.settleQuestion(msg.answers);
        }
        return true;
      default:
        return false;
    }
  }

  /** The user stopped the run — release anything it's parked on. */
  cancelAll(): void {
    const tool = this.pendingTool;
    this.pendingTool = null;
    tool?.(false);
    this.settleQuestion(CANCELLED_ANSWER);
  }

  private settleTool(approved: boolean): void {
    const resolve = this.pendingTool;
    if (!resolve) return;
    this.pendingTool = null;
    this.ui.say('agentState', { state: 'running' });
    resolve(approved);
  }

  private settlePlan(decision: PlanDecision, resume: boolean): void {
    const resolve = this.pendingPlan;
    if (!resolve) return;
    this.pendingPlan = null;
    if (resume) this.ui.say('agentState', { state: 'running' });
    resolve(decision);
  }

  private settleQuestion(answers: string): void {
    const resolve = this.pendingQuestion;
    this.pendingQuestion = null;
    resolve?.(answers);
  }
}
