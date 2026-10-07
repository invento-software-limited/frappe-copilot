/** Webview events that wait on the user; dropped from the log once answered
 *  so a replay never re-shows an approval or question that's already settled. */
const INTERACTIVE = new Set(['toolApprovalRequired', 'verifyApprovalRequired', 'planApprovalRequired', 'showClarificationPopup']);

/** Consecutive chunks of the same stream/tool merge into one replayed event. */
const MERGEABLE: Record<string, { key: string; fields: string[] }> = {
  streamChunk: { key: 'messageId', fields: ['chunk', 'reasoning'] },
  toolOutputChunk: { key: 'callId', fields: ['chunk'] },
  verifyOutputChunk: { key: 'runId', fields: ['chunk'] },
};

/** Status updates where only the newest one matters for a replay. */
const LATEST_ONLY = new Set(['runUsage', 'tokenUsage', 'graphUpdated', 'todoListUpdated', 'reviewState']);

export interface LiveRunSnapshot {
  /** Saved messages that existed when the run started; later ones are in `events`. */
  historyCount: number;
  startedAt: number;
  events: any[];
}

/** Every webview event of the run in flight. A chat that is closed and
 *  reopened (or switched away from and back) mid-run replays it after the
 *  saved history, so the live stream picks up where it was. */
export class LiveRunLog {
  private sessionId: string | null = null;
  private snap: LiveRunSnapshot = { historyCount: 0, startedAt: 0, events: [] };

  begin(sessionId: string, historyCount: number): void {
    this.sessionId = sessionId;
    this.snap = { historyCount, startedAt: Date.now(), events: [] };
  }

  end(): void {
    this.sessionId = null;
    this.snap = { historyCount: 0, startedAt: 0, events: [] };
  }

  /** The session the run in flight belongs to, if any. */
  get activeSessionId(): string | null {
    return this.sessionId;
  }

  /** The run's snapshot when it belongs to `sessionId`, else null. */
  snapshotFor(sessionId: string): LiveRunSnapshot | null {
    return this.sessionId === sessionId ? this.snap : null;
  }

  record(msg: any): void {
    if (!this.sessionId || msg.type === 'loadSession' || msg.type === 'replayLive') return;
    const events = this.snap.events;
    const last = events[events.length - 1];
    const merge = MERGEABLE[msg.type];
    if (merge && last?.type === msg.type && last[merge.key] === msg[merge.key]) {
      for (const f of merge.fields) if (msg[f]) last[f] = (last[f] || '') + msg[f];
      return;
    }
    if (LATEST_ONLY.has(msg.type)) this.snap.events = events.filter(e => e.type !== msg.type);
    this.snap.events.push({ ...msg, at: Date.now() });
  }

  /** Called once the user answers whatever the run was waiting on. */
  settleInteractive(): void {
    this.snap.events = this.snap.events.filter(e => !INTERACTIVE.has(e.type));
  }
}
