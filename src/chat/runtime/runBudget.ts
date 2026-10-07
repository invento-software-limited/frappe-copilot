import * as vscode from 'vscode';
import { TokenUsage } from '../../types';
import { ChatUi } from '../chatUi';

export interface RunUsage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  freshInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

const EMPTY_USAGE: RunUsage = {
  calls: 0,
  promptTokens: 0,
  completionTokens: 0,
  freshInputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

function limits(): { steps: number; tokens: number } {
  const cfg = vscode.workspace.getConfiguration('frappe-copilot.runLimits');
  return { steps: Math.max(0, cfg.get<number>('pauseAfterSteps', 100)), tokens: Math.max(0, cfg.get<number>('pauseAfterTokens', 200_000)) };
}

/** Token usage of the run in flight, and the guard that pauses a run which
 *  has gone on suspiciously long so the user can stop it before it burns
 *  through their budget. Each "continue" doubles the limit that was hit. */
export class RunBudget {
  private usage: RunUsage = { ...EMPTY_USAGE };
  private steps = 0;
  private stepLimit = 0;
  private tokenLimit = 0;

  constructor(private ui: ChatUi) {}

  begin(): void {
    this.usage = { ...EMPTY_USAGE };
    this.steps = 0;
    const { steps, tokens } = limits();
    this.stepLimit = steps;
    this.tokenLimit = tokens;
  }

  get totals(): RunUsage {
    return { ...this.usage };
  }

  /** One model call finished; usage is estimated when the provider reports none. */
  record(call: TokenUsage): void {
    this.usage.calls++;
    this.usage.promptTokens += call.promptTokens;
    this.usage.completionTokens += call.completionTokens;
    this.usage.freshInputTokens += call.freshInputTokens ?? call.promptTokens;
    this.usage.cacheReadTokens += call.cacheReadTokens ?? 0;
    this.usage.cacheWriteTokens += call.cacheWriteTokens ?? 0;
    this.ui.say('runUsage', { ...this.usage, live: true });
  }

  /** Called after each main-loop step: resolves false when the user stops a
   *  run that crossed a limit (or presses stop while it waits), true otherwise. */
  async allowNextStep(signal?: AbortSignal): Promise<boolean> {
    this.steps++;
    const overSteps = this.stepLimit > 0 && this.steps >= this.stepLimit;
    const total = this.usage.promptTokens + this.usage.completionTokens;
    const overTokens = this.tokenLimit > 0 && total >= this.tokenLimit;
    if (!overSteps && !overTokens) return true;

    const why = overSteps ? `${this.steps} steps` : `${Math.round(total / 1000)}k tokens`;
    this.ui.chat('system', `⏸️ Paused after ${why} — choose **Continue** or **Stop** in the notification.`);
    this.ui.say('agentState', { state: 'paused' });
    const choice = await Promise.race([
      vscode.window.showWarningMessage(
        `Frappe Copilot has run for ${why} (${this.steps} steps, ${Math.round(total / 1000)}k tokens) on this request. Keep going?`,
        'Continue', 'Stop'
      ),
      new Promise<undefined>(resolve => signal?.addEventListener('abort', () => resolve(undefined), { once: true })),
    ]);
    if (choice !== 'Continue') return false;
    if (overSteps) this.stepLimit *= 2;
    if (overTokens) this.tokenLimit *= 2;
    this.ui.say('agentState', { state: 'running' });
    return true;
  }
}
