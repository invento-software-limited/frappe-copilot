import * as fs from 'fs';
import * as path from 'path';
import { Message, Session } from '../types';

const SESSIONS_DIR = 'sessions';

/** File-based session persistence. All data stored in .frappe-copilot/sessions/. */
export class SessionStore {
  constructor(private frappeCopilotPath: string) {}

  /** Get the full path to the sessions directory. */
  private get sessionsDir(): string {
    return path.join(this.frappeCopilotPath, SESSIONS_DIR);
  }

  /** Get a unique session ID. */
  private generateId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 6);
    return `session-${timestamp}-${random}`;
  }

  /** List all sessions sorted by updatedAt (most recent first). */
  listSessions(): Session[] {
    const dir = this.sessionsDir;
    if (!fs.existsSync(dir)) return [];

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const sessions: Session[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sessionDir = path.join(dir, entry.name);
      const contextPath = path.join(sessionDir, 'context.md');
      const messagesPath = path.join(sessionDir, 'messages.jsonl');

      if (!fs.existsSync(contextPath)) continue;

      try {
        // Read session metadata from context file
        const contextContent = fs.readFileSync(contextPath, 'utf-8');
        const firstLine = contextContent.split('\n')[0] || '';
        const name = firstLine.startsWith('# ')
          ? firstLine.slice(2).trim()
          : entry.name;

        // Count messages
        let messageCount = 0;
        if (fs.existsSync(messagesPath)) {
          const msgContent = fs.readFileSync(messagesPath, 'utf-8').trim();
          messageCount = msgContent ? msgContent.split('\n').length : 0;
        }

        const stat = fs.statSync(contextPath);

        sessions.push({
          id: entry.name,
          name,
          createdAt: stat.birthtime.toISOString(),
          updatedAt: stat.mtime.toISOString(),
          messageCount,
        });
      } catch {
        // Skip malformed sessions
        continue;
      }
    }

    // Sort by updatedAt descending
    sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return sessions;
  }

  /** Create a new session with the given name. */
  createSession(name: string): Session {
    const id = this.generateId();
    const sessionDir = path.join(this.sessionsDir, id);

    // Create session directory
    fs.mkdirSync(sessionDir, { recursive: true });

    // Create context.md with title header
    const contextContent = `# ${name}\n\nCreated: ${new Date().toISOString()}\n\n`;
    fs.writeFileSync(path.join(sessionDir, 'context.md'), contextContent);

    // Create empty messages file
    fs.writeFileSync(path.join(sessionDir, 'messages.jsonl'), '');

    const now = new Date().toISOString();
    return {
      id,
      name,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
    };
  }

  /** Delete a session and all its files. */
  deleteSession(sessionId: string): boolean {
    const sessionDir = path.join(this.sessionsDir, sessionId);
    if (!fs.existsSync(sessionDir)) return false;

    try {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  /** Rename a session. */
  renameSession(sessionId: string, newName: string): boolean {
    const contextPath = path.join(this.sessionsDir, sessionId, 'context.md');
    if (!fs.existsSync(contextPath)) return false;

    try {
      const content = fs.readFileSync(contextPath, 'utf-8');
      const lines = content.split('\n');
      if (lines.length > 0 && lines[0].startsWith('# ')) {
        lines[0] = `# ${newName}`;
        fs.writeFileSync(contextPath, lines.join('\n'));
        return true;
      }
    } catch {
      // fall through
    }
    return false;
  }

  // ─── Message persistence ──────────────────────────────────────────────────

  /** Get the path to a session's messages file. */
  private messagesPath(sessionId: string): string {
    return path.join(this.sessionsDir, sessionId, 'messages.jsonl');
  }

  /** Get the path to a session's context file. */
  private contextPath(sessionId: string): string {
    return path.join(this.sessionsDir, sessionId, 'context.md');
  }

  /** Append a message to the session's message log. */
  appendMessage(sessionId: string, message: Message): boolean {
    const msgPath = this.messagesPath(sessionId);
    if (!fs.existsSync(msgPath)) return false;

    try {
      const line = JSON.stringify(message) + '\n';
      fs.appendFileSync(msgPath, line, 'utf-8');
      return true;
    } catch {
      return false;
    }
  }

  /** Read all messages for a session. */
  readMessages(sessionId: string): Message[] {
    const msgPath = this.messagesPath(sessionId);
    if (!fs.existsSync(msgPath)) return [];

    try {
      const content = fs.readFileSync(msgPath, 'utf-8').trim();
      if (!content) return [];

      return content.split('\n').map((line) => JSON.parse(line) as Message);
    } catch {
      return [];
    }
  }

  /** Read the context markdown for a session. */
  readContext(sessionId: string): string | null {
    const ctxPath = this.contextPath(sessionId);
    if (!fs.existsSync(ctxPath)) return null;
    try {
      return fs.readFileSync(ctxPath, 'utf-8');
    } catch {
      return null;
    }
  }

  /** Update the context markdown for a session. */
  updateContext(sessionId: string, content: string): boolean {
    const ctxPath = this.contextPath(sessionId);
    if (!fs.existsSync(ctxPath)) return false;

    // Preserve the first line (title) if it exists
    const existing = fs.readFileSync(ctxPath, 'utf-8');
    const existingLines = existing.split('\n');
    const titleLine = existingLines[0]?.startsWith('# ') ? existingLines[0] : null;

    try {
      const newContent = titleLine
        ? `${titleLine}\n\n${content}`
        : content;
      fs.writeFileSync(ctxPath, newContent, 'utf-8');
      return true;
    } catch {
      return false;
    }
  }
}
