import * as vscode from 'vscode';
import { Session, Message, CompactionState, CheckpointEntry } from '../types';
import { SessionStore } from './store';

/**
 * Session Manager — high-level session CRUD.
 *
 * One project has one chat window, but can maintain multiple sessions
 * on the backend. Each session has:
 *   - A context.md file (the persistent, evolving context)
 *   - A messages.jsonl file (conversation history)
 */
export class SessionManager implements vscode.TreeDataProvider<SessionItem> {
  private store: SessionStore;
  private _onDidChangeTreeData = new vscode.EventEmitter<SessionItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _activeSession: Session | null = null;
  private _sessions: Session[] = [];

  constructor(frappeCopilotPath: string) {
    this.store = new SessionStore(frappeCopilotPath);
    this.refresh();
  }

  /** Refresh the session list from disk. */
  refresh(): void {
    this._sessions = this.store.listSessions();
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Get all sessions. */
  get sessions(): Session[] {
    return this._sessions;
  }

  /** Get the currently active session. */
  get activeSession(): Session | null {
    return this._activeSession;
  }

  /** Set the active session. */
  setActiveSession(session: Session | null): void {
    this._activeSession = session;
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Create a new session and set it as active. */
  createSession(name: string): Session {
    const session = this.store.createSession(name);
    this._sessions.unshift(session);
    this._activeSession = session;
    this._onDidChangeTreeData.fire(undefined);
    return session;
  }

  /** Delete a session. */
  deleteSession(sessionId: string): boolean {
    const result = this.store.deleteSession(sessionId);
    if (result) {
      this._sessions = this._sessions.filter(s => s.id !== sessionId);
      if (this._activeSession?.id === sessionId) {
        this._activeSession = this._sessions[0] || null;
      }
      this._onDidChangeTreeData.fire(undefined);
    }
    return result;
  }

  /** Rename a session. */
  renameSession(sessionId: string, newName: string): boolean {
    const result = this.store.renameSession(sessionId, newName);
    if (result) {
      const session = this._sessions.find(s => s.id === sessionId);
      if (session) {
        session.name = newName;
        session.updatedAt = new Date().toISOString();
      }
      this._onDidChangeTreeData.fire(undefined);
    }
    return result;
  }

  /** Append a message to a session's history. */
  appendMessage(sessionId: string, message: Message): boolean {
    const result = this.store.appendMessage(sessionId, message);
    if (result) {
      const session = this._sessions.find(s => s.id === sessionId);
      if (session) {
        session.messageCount++;
        session.updatedAt = new Date().toISOString();
      }
    }
    return result;
  }

  /** Read all messages from a session. */
  readMessages(sessionId: string): Message[] {
    return this.store.readMessages(sessionId);
  }

  /** Generate a new sub-agent run id. */
  generateRunId(): string {
    return this.store.generateRunId();
  }

  /** Persist a sub-agent's full internal transcript as a side file. */
  writeRunTranscript(sessionId: string, runId: string, entries: Message[]): boolean {
    return this.store.writeRunTranscript(sessionId, runId, entries);
  }

  /** Read a sub-agent run's full transcript back (for on-demand UI expansion). */
  readRunTranscript(sessionId: string, runId: string): Message[] {
    return this.store.readRunTranscript(sessionId, runId);
  }

  writeCompactionState(sessionId: string, state: CompactionState): boolean {
    return this.store.writeCompactionState(sessionId, state);
  }

  readCompactionState(sessionId: string): CompactionState | null {
    return this.store.readCompactionState(sessionId);
  }

  writeCheckpoint(sessionId: string, runId: string, entries: CheckpointEntry[]): boolean {
    return this.store.writeCheckpoint(sessionId, runId, entries);
  }

  readCheckpoint(sessionId: string, runId: string): CheckpointEntry[] {
    return this.store.readCheckpoint(sessionId, runId);
  }

  /** The history actually sent to the model: full raw history, unless this
   *  session has been compacted, in which case it's the summary (as a
   *  synthetic system message) followed by only the turns after the
   *  compaction boundary. readMessages()/loadSession() are unaffected — the
   *  full raw record on disk never changes, only what gets SENT shrinks. */
  buildEffectiveHistory(sessionId: string): Message[] {
    const state = this.store.readCompactionState(sessionId);
    const all = this.store.readMessages(sessionId);
    if (!state) return all;
    return [
      { role: 'system', content: `### Prior conversation summary\n${state.summary}` },
      ...all.slice(state.compactedThroughCount)
    ];
  }

  /** Read the context markdown from a session. */
  readContext(sessionId: string): string | null {
    return this.store.readContext(sessionId);
  }

  /** Update the context markdown in a session. */
  updateContext(sessionId: string, content: string): boolean {
    return this.store.updateContext(sessionId, content);
  }

  // ─── TreeDataProvider implementation ───────────────────────────────────────

  getTreeItem(element: SessionItem): vscode.TreeItem {
    return element;
  }

  getChildren(): SessionItem[] {
    return this._sessions.map((session) => {
      const isActive = this._activeSession?.id === session.id;
      const item = new SessionItem(
        session.name,
        session.messageCount,
        isActive,
        session.id
      );
      return item;
    });
  }

  getParent(): vscode.ProviderResult<SessionItem> {
    return null; // flat list, no parent
  }
}

/** Tree item representing a session in the sessions view. */
export class SessionItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly messageCount: number,
    public readonly isActive: boolean,
    public readonly sessionId: string
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);

    this.tooltip = `${label} — ${messageCount} messages`;
    this.description = `${messageCount} msgs`;

    this.contextValue = 'frappeSession';

    // Icon: active session gets a different icon
    this.iconPath = isActive
      ? new vscode.ThemeIcon('symbol-event')
      : new vscode.ThemeIcon('comment-discussion');

    // Click to switch to this session
    this.command = {
      command: 'frappe-copilot.switchSession',
      title: 'Switch to Session',
      arguments: [sessionId],
    };
  }
}
