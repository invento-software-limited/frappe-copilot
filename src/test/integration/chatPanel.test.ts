import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChatPanel } from '../../chat/panel';
import { SessionManager } from '../../session/manager';
import { FakeProvider, RecordingTarget, callTool, say, waitFor } from '../support/fakes';
import { resetStub, setWorkspace } from '../support/vscodeStub';

/** A ChatPanel attached to a fake webview, driven by webview messages. */
function openPanel(replies: ConstructorParameters<typeof FakeProvider>[0]) {
  resetStub();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-panel-'));
  const root = path.join(base, 'workspace');
  fs.mkdirSync(root);
  setWorkspace(root);
  const sessions = new SessionManager(path.join(base, 'data'));
  const panel = new ChatPanel(process.cwd(), new FakeProvider(replies), sessions, null);
  const view = new RecordingTarget();
  let onMessage: (m: any) => Promise<void> = async () => undefined;
  panel.resolveWebviewView({
    webview: { options: {}, html: '', postMessage: (m: any) => view.postMessage(m), onDidReceiveMessage: (fn: any) => { onMessage = fn; return { dispose() {} }; } },
    onDidDispose: () => ({ dispose() {} }),
  } as any, {} as any, {} as any);
  return {
    root, sessions, panel, view,
    send: (m: any) => onMessage(m),
    cleanup: () => { setWorkspace(null); fs.rmSync(base, { recursive: true, force: true }); },
  };
}

test('ready → send → answer, then a reopened chat shows the run inline', async () => {
  const p = openPanel([callTool('list_dir', { path: '.' }), say('Empty folder.')]);
  try {
    await p.send({ type: 'ready' });
    assert.equal(p.view.ofType('status')[0].status, 'ready');
    await p.send({ type: 'sendMessage', text: 'what is here?' });

    const session = p.sessions.activeSession!;
    assert.equal(p.sessions.readMessages(session.id).at(-1)!.content, 'Empty folder.');

    p.panel.loadSession(session);
    const loaded = p.view.ofType('loadSession').at(-1);
    const answer = loaded.messages.at(-1);
    assert.equal(answer.steps[0].name, 'list_dir');
    assert.equal(loaded.live, undefined);
  } finally {
    p.cleanup();
  }
});

test('reopening mid-run replays the live events; approval still works', async () => {
  const p = openPanel([callTool('write_file', { path: 'f.txt', content: 'x' }), say('Saved.')]);
  try {
    const run = p.send({ type: 'sendMessage', text: 'save f.txt' });
    await waitFor(() => p.view.ofType('toolApprovalRequired').length === 1);

    p.panel.loadSession(p.sessions.activeSession!);
    const loaded = p.view.ofType('loadSession').at(-1);
    assert.deepEqual(loaded.messages.map((m: any) => m.role), ['user']);
    assert.ok(loaded.live.events.some((e: any) => e.type === 'toolApprovalRequired'));

    await p.send({ type: 'toolApproved' });
    await run;
    assert.equal(fs.readFileSync(path.join(p.root, 'f.txt'), 'utf-8'), 'x');
  } finally {
    p.cleanup();
  }
});

test('a second message while running is refused', async () => {
  const p = openPanel([callTool('write_file', { path: 'f.txt', content: 'x' }), say('done')]);
  try {
    const run = p.send({ type: 'sendMessage', text: 'first' });
    await waitFor(() => p.view.ofType('toolApprovalRequired').length === 1);
    await p.send({ type: 'sendMessage', text: 'second' });
    assert.ok(p.view.ofType('addMessage').some(e => /Another request is currently executing/.test(e.message.content)));
    await p.send({ type: 'abort' });
    await run;
  } finally {
    p.cleanup();
  }
});

test('switching sessions mid-run keeps the run out of the other session', async () => {
  const p = openPanel([callTool('write_file', { path: 'f.txt', content: 'x' }), say('Saved in A.')]);
  try {
    const run = p.send({ type: 'sendMessage', text: 'save f.txt' });
    await waitFor(() => p.view.ofType('toolApprovalRequired').length === 1);
    const sessionA = p.sessions.activeSession!;

    const sessionB = p.sessions.createSession('B');
    p.panel.loadSession(sessionB);
    const before = p.view.events.length;
    await p.send({ type: 'toolApproved' });
    await run;

    const afterSwitch = p.view.events.slice(before).map(e => e.type);
    assert.ok(!afterSwitch.includes('toolFinished'), 'run events stay out of session B');
    assert.ok(!afterSwitch.includes('streamChunk'));
    assert.ok(p.view.events.slice(before).some(e => e.type === 'agentState' && e.state === 'idle'));
    assert.equal(p.sessions.readMessages(sessionA.id).at(-1)!.content, 'Saved in A.');
  } finally {
    p.cleanup();
  }
});

test("a reopened chat shows a sub-agent's own steps inside its task card", async () => {
  const p = openPanel([
    callTool('task', { subagent_type: 'explore', description: 'Look around', prompt: 'List the workspace.' }),
    callTool('list_dir', { path: '.' }, 'sub-1'),
    say('The workspace is empty.'),
    say('Nothing here yet.'),
  ]);
  try {
    await p.send({ type: 'sendMessage', text: 'what is in this project?' });
    p.panel.loadSession(p.sessions.activeSession!);
    const answer = p.view.ofType('loadSession').at(-1).messages.at(-1);
    const task = answer.steps.find((s: any) => s.name === 'task');
    assert.ok(task.subRunId);
    assert.deepEqual(task.children.map((c: any) => c.name), ['list_dir']);
  } finally {
    p.cleanup();
  }
});
