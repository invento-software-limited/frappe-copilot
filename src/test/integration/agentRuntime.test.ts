import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { buildHarness, callTool, say, waitFor, Harness } from '../support/fakes';
import { promptAnswers, settings } from '../support/vscodeStub';

async function withHarness(replies: Parameters<typeof buildHarness>[0], body: (h: Harness) => Promise<void>, native = true): Promise<void> {
  const h = buildHarness(replies, { native });
  try { await body(h); } finally { h.cleanup(); }
}

function savedAssistant(h: Harness) {
  const session = h.sessions.activeSession!;
  return h.sessions.readMessages(session.id).filter(m => m.role === 'assistant');
}

test('reads a file with a native tool call, then answers', () => withHarness(
  [callTool('read_file', { path: 'hello.py' }), say('hello.py prints hi.')],
  async h => {
    fs.writeFileSync(path.join(h.root, 'hello.py'), 'print("hi")\n');
    await h.runtime.orchestrator.run('What does hello.py do?');

    const [answer] = savedAssistant(h);
    assert.equal(answer.content, 'hello.py prints hi.');
    assert.ok(answer.runId);
    const transcript = h.sessions.readRunTranscript(h.sessions.activeSession!.id, answer.runId!);
    assert.match(transcript[1].toolResults![0].content, /print\("hi"\)/);
    // The model saw the file contents on its second call.
    const second = h.provider.requests[1].messages;
    assert.ok(second.some(m => m.toolResults?.[0]?.content.includes('print("hi")')));
    assert.deepEqual(h.ui.ofType('toolFinished').map(e => e.success), [true]);
    assert.equal(h.ui.ofType('agentState').pop().state, 'idle');
  }
));

test('runs the XML tool protocol when native tools are off', () => withHarness(
  [say('<tool_call name="list_dir"><path>.</path></tool_call>'), say('Listed.')],
  async h => {
    fs.writeFileSync(path.join(h.root, 'x.txt'), '');
    await h.runtime.orchestrator.run('list files');
    assert.equal(h.provider.requests[0].options?.tools, undefined);
    assert.match(h.provider.requests[1].messages.at(-1)!.content, /<tool_result name="list_dir">[\s\S]*x\.txt/);
    assert.equal(savedAssistant(h)[0].content, 'Listed.');
  },
  false
));

test('a high-risk write waits for approval and is checkpointed', () => withHarness(
  [callTool('write_file', { path: 'out.txt', content: 'data' }), say('Wrote it.')],
  async h => {
    const run = h.runtime.orchestrator.run('write out.txt');
    await waitFor(() => h.ui.ofType('toolApprovalRequired').length === 1);
    assert.equal(fs.existsSync(path.join(h.root, 'out.txt')), false);
    h.approvals.answer({ type: 'toolApproved' });
    await run;

    assert.equal(fs.readFileSync(path.join(h.root, 'out.txt'), 'utf-8'), 'data');
    const [answer] = savedAssistant(h);
    assert.equal(answer.hasCheckpoint, true);
    const checkpoint = h.sessions.readCheckpoint(h.sessions.activeSession!.id, answer.runId!);
    assert.deepEqual(checkpoint, [{ path: 'out.txt', existedBefore: false }]);
  }
));

test('a rejected write is reported back to the model and not run', () => withHarness(
  [callTool('write_file', { path: 'out.txt', content: 'data' }), say('Okay, skipped.')],
  async h => {
    const run = h.runtime.orchestrator.run('write out.txt');
    await waitFor(() => h.ui.ofType('toolApprovalRequired').length === 1);
    h.approvals.answer({ type: 'toolRejected' });
    await run;
    assert.equal(fs.existsSync(path.join(h.root, 'out.txt')), false);
    assert.match(h.provider.requests[1].messages.at(-1)!.toolResults![0].content, /rejected by the user/);
  }
));

test('auto mode skips the approval prompt', () => withHarness(
  [callTool('write_file', { path: 'auto.txt', content: 'x' }), say('Done.')],
  async h => {
    settings.set('frappe-copilot.approvalMode', 'auto');
    await h.runtime.orchestrator.run('write');
    assert.equal(h.ui.ofType('toolApprovalRequired').length, 0);
    assert.equal(fs.existsSync(path.join(h.root, 'auto.txt')), true);
  }
));

test('a transient stream error is retried; a permanent one ends the run', async () => {
  await withHarness([{ error: 'socket hang up' }, say('Recovered.')], async h => {
    await h.runtime.orchestrator.run('hi');
    assert.equal(savedAssistant(h)[0].content, 'Recovered.');
    assert.ok(h.ui.ofType('addMessage').some(e => /retrying \(attempt 1\/5\)/.test(e.message.content)));
  });
  await withHarness([{ error: '401 invalid api key' }], async h => {
    await h.runtime.orchestrator.run('hi');
    assert.match(savedAssistant(h)[0].content, /execution stopped before completing/);
    assert.equal(h.provider.requests.length, 1);
  });
});

test('a model that rejects native tools falls back to XML', () => withHarness(
  [{ error: 'Request failed (400): tools are not supported by this model' }, say('Plain answer.')],
  async h => {
    await h.runtime.orchestrator.run('hi');
    assert.ok(h.provider.requests[0].options?.tools?.length);
    assert.equal(h.provider.requests[1].options?.tools, undefined);
    assert.equal(savedAssistant(h)[0].content, 'Plain answer.');
  }
));

test('a truncated reply is continued in the next step', () => withHarness(
  [{ chunks: [{ content: 'Part one', truncated: true }] }, say('Part two.')],
  async h => {
    await h.runtime.orchestrator.run('long answer');
    assert.match(h.provider.requests[1].messages.at(-1)!.content, /cut off by the output length limit/);
    assert.equal(savedAssistant(h)[0].content, 'Part two.');
  }
));

test('stopping a run parked on approval ends it cleanly', () => withHarness(
  [callTool('write_file', { path: 'never.txt', content: 'x' })],
  async h => {
    const run = h.runtime.orchestrator.run('write');
    await waitFor(() => h.ui.ofType('toolApprovalRequired').length === 1);
    h.control.abort();
    h.approvals.cancelAll();
    await run;
    assert.equal(fs.existsSync(path.join(h.root, 'never.txt')), false);
    assert.equal(h.control.running, false);
    assert.match(savedAssistant(h)[0].content, /execution stopped before completing/);
  }
));

test('the live log covers the run in flight and is cleared after', () => withHarness(
  [callTool('write_file', { path: 'a.txt', content: 'x' }), say('ok')],
  async h => {
    const run = h.runtime.orchestrator.run('write');
    await waitFor(() => h.ui.ofType('toolApprovalRequired').length === 1);
    const sessionId = h.sessions.activeSession!.id;
    const snap = h.runtime.deps.ui.liveRun.snapshotFor(sessionId)!;
    assert.equal(snap.historyCount, 1);
    assert.ok(snap.events.some(e => e.type === 'toolApprovalRequired'));
    h.approvals.answer({ type: 'toolApproved' });
    await run;
    assert.equal(h.runtime.deps.ui.liveRun.snapshotFor(sessionId), null);
  }
));

const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

test('an image a tool returns is shown to the model on the next call', () => withHarness(
  [callTool('read_file', { path: 'shot.png' }), say('A single pixel.')],
  async h => {
    fs.writeFileSync(path.join(h.root, 'shot.png'), PNG_1x1);
    await h.runtime.orchestrator.run('what is in shot.png?');
    const resultsTurn = h.provider.requests[1].messages.at(-1)!;
    assert.equal(resultsTurn.toolResults![0].content, "Image 'shot.png' is attached below.");
    assert.equal(resultsTurn.images![0].mediaType, 'image/png');
    assert.equal(resultsTurn.images![0].data, PNG_1x1.toString('base64'));
  }
));

test('a model that rejects images continues without them', () => withHarness(
  [callTool('read_file', { path: 'shot.png' }), { error: 'Request failed (400): this model does not support image input' }, say('Could not view it.')],
  async h => {
    fs.writeFileSync(path.join(h.root, 'shot.png'), PNG_1x1);
    await h.runtime.orchestrator.run('look at shot.png');
    assert.equal(h.provider.requests.length, 3);
    assert.equal(h.provider.requests[2].messages.some(m => m.images?.length), false);
    assert.equal(h.runtime.deps.models.toolImagesEnabled(), false);
    assert.equal(savedAssistant(h)[0].content, 'Could not view it.');
  }
));

test('a run that hits the step limit stops when the user says Stop', () => withHarness(
  [callTool('list_dir', { path: '.' }, 'a'), callTool('list_dir', { path: '.' }, 'b'), say('never reached')],
  async h => {
    settings.set('frappe-copilot.runLimits.pauseAfterSteps', 1);
    promptAnswers.warning = 'Stop';
    await h.runtime.orchestrator.run('loop');
    assert.equal(h.provider.requests.length, 1);
    assert.ok(h.ui.ofType('addMessage').some(e => /Stopped at your request/.test(e.message.content)));
    const usage = h.ui.ofType('runUsage').at(-1);
    assert.equal(usage.calls, 1);
    assert.ok(usage.promptTokens > 0);
  }
));

test('run usage preserves fresh and cached input categories', () => withHarness(
  [{ chunks: [{ content: 'done', usage: {
    promptTokens: 20_000,
    completionTokens: 500,
    totalTokens: 20_500,
    freshInputTokens: 4_000,
    cacheReadTokens: 15_000,
    cacheWriteTokens: 1_000,
  } }] }],
  async h => {
    await h.runtime.orchestrator.run('report usage');
    const usage = h.ui.ofType('runUsage').at(-1);
    assert.equal(usage.promptTokens, 20_000);
    assert.equal(usage.completionTokens, 500);
    assert.equal(usage.freshInputTokens, 4_000);
    assert.equal(usage.cacheReadTokens, 15_000);
    assert.equal(usage.cacheWriteTokens, 1_000);
  }
));

test('conversation compaction is offered at the 40k default on large-window models', () => withHarness(
  [],
  async h => {
    settings.set('frappe-copilot.contextWindowTokens', 1_000_000);
    const session = h.sessions.createSession('Long chat');
    h.sessions.appendMessage(session.id, { role: 'user', content: 'x'.repeat(180_000) });
    h.runtime.deps.compaction.reportSessionSize(session);
    const offer = h.ui.ofType('compactionOffered').at(-1);
    assert.equal(offer.thresholdTokens, 40_000);
    assert.ok(offer.estimatedTokens > offer.thresholdTokens);
  }
));

test('Continue doubles the limit and lets the run finish', () => withHarness(
  [callTool('list_dir', { path: '.' }, 'a'), callTool('list_dir', { path: '.' }, 'b'), say('finished')],
  async h => {
    settings.set('frappe-copilot.runLimits.pauseAfterSteps', 1);
    promptAnswers.warning = 'Continue';
    await h.runtime.orchestrator.run('loop');
    assert.equal(savedAssistant(h)[0].content, 'finished');
    // Paused after step 1, then not again until step 2 (limit doubled to 2).
    assert.equal(h.ui.ofType('addMessage').filter(e => /Paused after/.test(e.message.content)).length, 2);
  }
));

test('tool calls in the <invoke> dialect run without a correction round trip', () => withHarness(
  [say('<invoke name="list_dir">\n<parameter name="path">.</parameter>\n</invoke>'), say('Listed.')],
  async h => {
    fs.writeFileSync(path.join(h.root, 'x.txt'), '');
    await h.runtime.orchestrator.run('list files');
    assert.equal(h.provider.requests.length, 2);
    assert.match(h.provider.requests[1].messages.at(-1)!.content, /<tool_result name="list_dir">[\s\S]*x\.txt/);
    assert.ok(!h.provider.requests[1].messages.some(m => /invalid tool-call format/.test(m.content)));
  },
  false
));
