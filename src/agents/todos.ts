import * as fs from 'fs';
import * as path from 'path';
import { asJson } from './tools/args';

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface TodoItem {
  content: string;
  status: TodoStatus;
  /** Present-continuous form shown while in progress ("Running tests"). */
  activeForm?: string;
}

export interface TodoSnapshot {
  items: TodoItem[];
  /** The run that owned the list ended before finishing it. */
  stale: boolean;
}

/** Tool calls without a todo update before the agent is reminded. */
const REMIND_AFTER = 6;

/** The agent's task list for one session: persisted with the session,
 *  reminded when it goes stale mid-run, checked when a run ends, and carried
 *  into the next run when a run stops with work left. */
export class TodoTracker {
  private items: TodoItem[] = [];
  private stale = false;
  private sinceUpdate = 0;
  private nudged = false;
  private file: string | null = null;

  /** Switches to a session's list (or none). */
  load(sessionDir: string | null): void {
    this.file = sessionDir ? path.join(sessionDir, 'todos.json') : null;
    this.items = [];
    this.stale = false;
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8')) as TodoSnapshot;
      this.items = Array.isArray(data.items) ? data.items.filter(isItem) : [];
      this.stale = !!data.stale;
    } catch {
      // A corrupt file just means starting with no list.
    }
  }

  snapshot(): TodoSnapshot {
    return { items: this.items.map(i => ({ ...i })), stale: this.stale };
  }

  /** Called when a run starts. A fully finished list is cleared. */
  beginRun(): void {
    this.sinceUpdate = 0;
    this.nudged = false;
    if (this.items.length && this.open().length === 0) this.replace([]);
  }

  /** Applies an update_todo_list call; returns the tool result text. */
  update(args: Record<string, any>): { ok: boolean; output: string } {
    const items = parseTodos(args);
    if (!items) {
      return { ok: false, output: 'Could not read the todo list. Pass "todos" as an array of {content, status, activeForm} where status is pending, in_progress, completed, or cancelled.' };
    }
    this.replace(items);
    this.stale = false;
    this.sinceUpdate = 0;
    this.persist();
    const active = items.filter(i => i.status === 'in_progress').length;
    const warn = active > 1 ? ' Note: keep exactly one task in_progress at a time.' : '';
    const done = items.filter(i => i.status === 'completed').length;
    return { ok: true, output: `Todo list updated: ${done}/${items.length} completed.${warn}\n${render(items)}` };
  }

  /** Counts a tool call; returns a reminder when the list has gone stale. */
  afterToolCall(tool: string): string | null {
    if (tool === 'update_todo_list') return null;
    this.sinceUpdate++;
    if (this.open().length === 0 || this.sinceUpdate < REMIND_AFTER) return null;
    this.sinceUpdate = 0;
    return `\n\n[Todo reminder] Your todo list hasn't been updated in a while. If you've finished a task, mark it completed now (and set the next one in_progress) with update_todo_list. Open items:\n${render(this.open())}`;
  }

  /** When the agent tries to finish with open items, ask once to reconcile. */
  endOfRunNudge(): string | null {
    const open = this.open();
    if (open.length === 0 || this.nudged) return null;
    this.nudged = true;
    return `Your todo list still has ${open.length} open item(s):\n${render(open)}\nIf this work is done, mark those items completed. If it can't or shouldn't be done, mark them cancelled and say why. If work remains, continue it now. Then give your final answer.`;
  }

  /** The run ended (stopped, errored, or finished) with work still open. */
  markInterrupted(): void {
    if (this.open().length === 0) return;
    this.items = this.items.map(i => (i.status === 'in_progress' ? { ...i, status: 'pending' } : i));
    this.stale = true;
    this.persist();
  }

  /** Unfinished list from an earlier run, for the next run's context. */
  carryOver(): string {
    if (!this.stale || this.open().length === 0) return '';
    return `\n\n### Unfinished Todo List\nA previous run stopped before finishing this list. If the user's new message continues that work, pick up from here and keep the list updated with update_todo_list. If it's unrelated, replace or clear the list (mark items cancelled):\n${render(this.items)}`;
  }

  clear(): void {
    this.replace([]);
    this.stale = false;
    this.persist();
  }

  private open(): TodoItem[] {
    return this.items.filter(i => i.status === 'pending' || i.status === 'in_progress');
  }

  private replace(items: TodoItem[]): void {
    this.items = items;
    if (items.length === 0) this.stale = false;
    this.persist();
  }

  private persist(): void {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.snapshot(), null, 2), 'utf8');
    } catch (e) {
      console.error('Failed to save todo list:', e);
    }
  }
}

const STATUS_ALIASES: Record<string, TodoStatus> = {
  pending: 'pending', todo: 'pending', open: 'pending',
  in_progress: 'in_progress', 'in-progress': 'in_progress', running: 'in_progress', active: 'in_progress', doing: 'in_progress',
  completed: 'completed', complete: 'completed', done: 'completed',
  cancelled: 'cancelled', canceled: 'cancelled', failed: 'cancelled', skipped: 'cancelled',
};

/** Accepts the structured `todos` array (native tool calling or JSON in
 *  XML), or the legacy `tasks` YAML/markdown text. */
export function parseTodos(args: Record<string, any>): TodoItem[] | null {
  const structured = asJson<any[]>(args.todos);
  if (Array.isArray(structured)) {
    const items = structured.map(toItem).filter((i): i is TodoItem => !!i);
    return items.length || structured.length === 0 ? items : null;
  }
  if (typeof args.tasks === 'string') return parseLegacy(args.tasks);
  return null;
}

function toItem(raw: any): TodoItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const content = String(raw.content ?? raw.label ?? raw.title ?? '').trim();
  if (!content) return null;
  const status = STATUS_ALIASES[String(raw.status || 'pending').toLowerCase()] || 'pending';
  const activeForm = typeof raw.activeForm === 'string' && raw.activeForm.trim() ? raw.activeForm.trim() : undefined;
  return { content, status, activeForm };
}

/** "- id: x / label: y / status: z" blocks, or "- [x] text" checklists. */
function parseLegacy(text: string): TodoItem[] {
  const items: TodoItem[] = [];
  let cur: Record<string, string> | null = null;
  const flush = () => { const it = cur && toItem(cur); if (it) items.push(it); cur = null; };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const check = line.match(/^[-*]\s*\[( |x|X|~|-)\]\s*(.+)$/);
    if (check) {
      flush();
      const mark = check[1].toLowerCase();
      items.push({ content: check[2].trim(), status: mark === 'x' ? 'completed' : mark === '~' ? 'in_progress' : mark === '-' ? 'cancelled' : 'pending' });
      continue;
    }
    if (/\b(label|content):/.test(line) && line.includes(',')) {
      flush();
      const pairs: Record<string, string> = {};
      for (const part of line.replace(/^-\s*/, '').split(',')) {
        const m = part.match(/^\s*(\w+):\s*(.*)$/);
        if (m) pairs[m[1]] = m[2].trim();
      }
      const it = toItem(pairs);
      if (it) items.push(it);
      continue;
    }
    const kv = line.replace(/^-\s*/, '').match(/^(id|label|content|title|status|activeForm):\s*(.*)$/);
    if (kv) {
      if (line.startsWith('-') || (kv[1] === 'id' && cur)) flush();
      cur = cur || {};
      cur[kv[1]] = kv[2].trim();
    }
  }
  flush();
  return items;
}

function render(items: TodoItem[]): string {
  const mark: Record<TodoStatus, string> = { pending: '[ ]', in_progress: '[~]', completed: '[x]', cancelled: '[-]' };
  return items.map(i => `${mark[i.status]} ${i.content}`).join('\n');
}

function isItem(v: any): v is TodoItem {
  return v && typeof v.content === 'string' && typeof v.status === 'string';
}
