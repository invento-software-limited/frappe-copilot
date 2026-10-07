import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { LiveRunLog } from '../../chat/liveRunLog';
import { ChatUi } from '../../chat/chatUi';
import { ApprovalGate } from '../../chat/approvals';
import { RecordingTarget } from '../support/fakes';

test('live log records only while a run is active, merging stream chunks', () => {
  const log = new LiveRunLog();
  log.record({ type: 'streamChunk', messageId: 'a', chunk: 'ignored' });
  log.begin('s1', 3);
  log.record({ type: 'startStream', messageId: 'a' });
  log.record({ type: 'streamChunk', messageId: 'a', chunk: 'Hel', reasoning: 'r1' });
  log.record({ type: 'streamChunk', messageId: 'a', chunk: 'lo', reasoning: '' });
  log.record({ type: 'loadSession' });

  const snap = log.snapshotFor('s1')!;
  assert.equal(snap.historyCount, 3);
  assert.deepEqual(snap.events.map(e => e.type), ['startStream', 'streamChunk']);
  assert.equal(snap.events[1].chunk, 'Hello');
  assert.equal(snap.events[1].reasoning, 'r1');
  assert.equal(log.snapshotFor('other'), null);

  log.end();
  assert.equal(log.snapshotFor('s1'), null);
});

test('answered approvals are dropped from the live log', () => {
  const log = new LiveRunLog();
  log.begin('s1', 0);
  log.record({ type: 'toolCallStarted', callId: 'c' });
  log.record({ type: 'toolApprovalRequired', callId: 'c' });
  log.settleInteractive();
  assert.deepEqual(log.snapshotFor('s1')!.events.map(e => e.type), ['toolCallStarted']);
});

test('chat UI fans out to every open target and feeds the live log', () => {
  const a = new RecordingTarget();
  const b = new RecordingTarget();
  const ui = new ChatUi(() => [a, null, b]);
  ui.liveRun.begin('s', 0);
  ui.chat('system', 'hi');
  ui.say('status', 'ready');
  assert.deepEqual(a.events, b.events);
  assert.deepEqual(a.events[1], { type: 'status', status: 'ready' });
  assert.equal(ui.liveRun.snapshotFor('s')!.events.length, 2);
});

test('approval gate resolves the matching wait only', async () => {
  const target = new RecordingTarget();
  const gate = new ApprovalGate(new ChatUi(() => [target]));

  const tool = gate.waitForTool();
  assert.equal(gate.answer({ type: 'planApproved' }), true);
  gate.answer({ type: 'toolApproved', always: true, tool: 'write_file' });
  assert.equal(await tool, true);
  assert.equal(gate.isAlwaysAllowed('write_file'), true);

  const plan = gate.requirePlan({ stages: [], planPath: null, planFileUri: null });
  gate.answer({ type: 'planRevise' });
  assert.equal(await plan, 'revise');

  const question = gate.ask('Which site?');
  gate.cancelAll();
  assert.match(await question, /cancelled/);
  assert.equal(gate.answer({ type: 'sendMessage' }), false);
  assert.ok(target.ofType('showClarificationPopup').length === 1);
});
