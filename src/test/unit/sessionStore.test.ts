import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionStore } from '../../session/store';

test('a corrupt line in the history is skipped, not the whole session', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-store-'));
  const store = new SessionStore(dir);
  const session = store.createSession('Test');
  store.appendMessage(session.id, { role: 'user', content: 'first' });
  fs.appendFileSync(path.join(dir, 'sessions', session.id, 'messages.jsonl'), '{"role":"assistant","content":"cut of\n');
  store.appendMessage(session.id, { role: 'user', content: 'third' });

  const warnings: unknown[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    assert.deepEqual(store.readMessages(session.id).map(m => m.content), ['first', 'third']);
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 1);
  fs.rmSync(dir, { recursive: true });
});
