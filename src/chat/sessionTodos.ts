import * as path from 'path';
import { TodoTracker } from '../agents/todos';
import { Session } from '../types';
import { ChatUi } from './chatUi';
import { frappeCopilotPath } from './projectContext';

/** The agent's task list for the active session — persisted with the
 *  session and carried across runs. */
export class SessionTodos {
  readonly tracker = new TodoTracker();
  private sessionId: string | null = null;

  constructor(private ui: ChatUi) {}

  /** Points the tracker at a session's saved list. */
  bind(session: Session): void {
    if (this.sessionId === session.id) return;
    const fp = frappeCopilotPath();
    this.tracker.load(fp ? path.join(fp, 'sessions', session.id) : null);
    this.sessionId = session.id;
    this.send();
  }

  send(): void {
    this.ui.say('todoListUpdated', this.tracker.snapshot());
  }

  clear(): void {
    this.tracker.clear();
    this.send();
  }
}
