import * as vscode from 'vscode';
import { SessionManager } from '../session/manager';
import { ChatUi } from './chatUi';
import { buildRevertPreview, mergePromptCheckpoint, restoreCheckpointEntries } from './checkpoints';
import { workspaceRoot } from './projectContext';

const COMPACTED_NOTE = ' Note: this conversation has since been compacted — the summary may still describe work this revert undoes.';

/** Run transcripts and "revert" for the chat: per run (native confirm) or per
 *  prompt (the webview shows a diff preview and confirms itself). */
export class RevertController {
  constructor(private ui: ChatUi, private sessions: SessionManager) {}

  /** Handles a revert/transcript message; false when it isn't one. */
  async handle(msg: any): Promise<boolean> {
    switch (msg.type) {
      case 'getRunTranscript': this.sendTranscript(msg.runId); return true;
      case 'revertRun': await this.revertRun(msg.runId); return true;
      case 'getPromptRevertPreview': this.sendPromptPreview(msg.promptId); return true;
      case 'revertPrompt': this.revertPrompt(msg.promptId); return true;
      default: return false;
    }
  }

  private sendTranscript(runId: string): void {
    const session = this.sessions.activeSession;
    if (!session || !runId) return;
    this.ui.say('runTranscript', { runId, entries: this.sessions.readRunTranscript(session.id, runId) });
  }

  private async revertRun(runId: string): Promise<void> {
    const session = this.sessions.activeSession;
    if (!session || !runId) return;
    const entries = this.sessions.readCheckpoint(session.id, runId);
    if (entries.length === 0) return;
    const note = this.sessions.readCompactionState(session.id) ? COMPACTED_NOTE : '';
    const choice = await vscode.window.showWarningMessage(
      `Revert ${entries.length} file(s) to their state before this run? This restores files to their pre-run content — any edits you made to them since (manually or via later runs) will be lost.${note}`,
      { modal: true },
      'Revert Files'
    );
    if (choice !== 'Revert Files') return;
    restoreCheckpointEntries(workspaceRoot(), entries);
    this.ui.say('runReverted', { runId, count: entries.length });
    vscode.window.showInformationMessage(`Frappe Copilot: Reverted ${entries.length} file(s).`);
  }

  private sendPromptPreview(promptId: string): void {
    const session = this.sessions.activeSession;
    if (!session || !promptId) return;
    const entries = this.promptEntries(session.id, promptId);
    if (!entries?.length) return;
    this.ui.say('promptRevertPreview', {
      promptId,
      files: buildRevertPreview(workspaceRoot(), entries),
      compacted: !!this.sessions.readCompactionState(session.id),
    });
  }

  /** Already confirmed in the webview's preview card — no second modal. */
  private revertPrompt(promptId: string): void {
    const session = this.sessions.activeSession;
    if (!session || !promptId) return;
    const entries = this.promptEntries(session.id, promptId);
    if (!entries?.length) return;
    restoreCheckpointEntries(workspaceRoot(), entries);
    this.ui.say('promptReverted', { promptId, count: entries.length });
    vscode.window.showInformationMessage(`Frappe Copilot: Reverted ${entries.length} file(s).`);
  }

  private promptEntries(sessionId: string, promptId: string) {
    return mergePromptCheckpoint(this.sessions.readMessages(sessionId), runId => this.sessions.readCheckpoint(sessionId, runId), promptId);
  }
}
