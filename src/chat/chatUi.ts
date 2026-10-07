import { LiveRunLog } from './liveRunLog';

/** Anything a message can be posted to — a VS Code webview, or a test double. */
export interface MessageTarget {
  postMessage(message: any): Thenable<boolean> | Promise<boolean> | boolean | void;
}

/** Events about the chat as a whole rather than the session on screen —
 *  always delivered, even while a run in another session is going. */
const GLOBAL_EVENTS: ReadonlySet<string> = new Set([
  'loadSession', 'status', 'benchStatus', 'modelsList', 'effortInfo', 'settingsLoaded', 'apiKeyStatus',
  'approvalMode', 'skillsList', 'skillContent', 'insertCodeMention', 'claudeOAuthStarted', 'reviewState',
]);

/** The one channel every chat event goes through: it fans each message out to
 *  every open chat webview and records the run in flight for replay. A run's
 *  events reach the webview only while its session is the one on screen —
 *  the rest is replayed from the live log when the user switches back. */
export class ChatUi {
  /** Events of the run in flight, replayed into a chat reopened mid-run. */
  readonly liveRun = new LiveRunLog();
  /** The session the webview is showing. */
  private shownSessionId: string | null = null;

  constructor(private targets: () => (MessageTarget | null | undefined)[]) {}

  /** Called when a session is rendered. */
  showingSession(sessionId: string): void {
    this.shownSessionId = sessionId;
  }

  post(message: any): void {
    this.liveRun.record(message);
    const delivered = this.visibleForm(message);
    if (!delivered) return;
    for (const t of this.targets()) t?.postMessage(delivered);
  }

  /** A typed event; a bare string becomes `{ status }`. */
  say(type: string, data: any = {}): void {
    this.post({ type, ...(typeof data === 'object' ? data : { status: data }) });
  }

  /** A transcript bubble — 'user' | 'assistant' | 'system' | 'error'. */
  chat(role: string, content: string): void {
    this.say('addMessage', { message: { role, content } });
  }

  /** Whether a run is going in a session other than the one on screen. */
  runningElsewhere(): boolean {
    const runSession = this.liveRun.activeSessionId;
    return !!runSession && !!this.shownSessionId && runSession !== this.shownSessionId;
  }

  /** The message as the webview should get it, or null to hold it back. */
  private visibleForm(message: any): any | null {
    if (GLOBAL_EVENTS.has(message.type) || !this.runningElsewhere()) return message;
    // The other session still needs to know a run is busy (send button) and when it ends.
    if (message.type === 'agentState') {
      return message.state === 'idle' ? message : { type: 'agentState', state: 'running', background: true };
    }
    return null;
  }
}
