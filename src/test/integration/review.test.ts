import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { ReviewController } from '../../review/reviewController';
import { ReviewStore } from '../../review/reviewStore';
import { buildHarness, callTool, say } from '../support/fakes';
import { settings } from '../support/vscodeStub';

/** The agent creates one file and rewrites another (after reading it), with review on. */
async function agentEdits() {
  const h = buildHarness([
    callTool('write_file', { path: 'new.py', content: 'print("new")\n' }, 'w1'),
    callTool('read_file', { path: 'app.py' }, 'r1'),
    callTool('write_file', { path: 'app.py', content: 'x = 1\ny = 20\nz = 3\nw = 4\n' }, 'w2'),
    say('Done.'),
  ]);
  settings.set('frappe-copilot.approvalMode', 'auto');
  fs.writeFileSync(path.join(h.root, 'app.py'), 'x = 1\ny = 2\nz = 3\n');
  const reviewFile = path.join(h.root, '..', 'data', 'review.json');
  const review = new ReviewController(h.root, new ReviewStore(reviewFile));
  (h.runtime.deps as any).review = review;
  await h.runtime.orchestrator.run('edit things');
  const read = (rel: string) => fs.readFileSync(path.join(h.root, rel), 'utf-8');
  return { h, review, read, reviewFile };
}

test('agent edits show up as pending files with line counts', async () => {
  const { h, review, reviewFile } = await agentEdits();
  try {
    assert.deepEqual(review.pending().sort((a, b) => a.path.localeCompare(b.path)), [
      { path: 'app.py', isNew: false, added: 2, removed: 1 },
      { path: 'new.py', isNew: true, added: 1, removed: 0 },
    ]);
    // Pending reviews survive a reload.
    assert.equal(new ReviewController(h.root, new ReviewStore(reviewFile)).pending().length, 2);
  } finally { h.cleanup(); }
});

test('reject all puts files back and deletes the ones the agent created', async () => {
  const { h, review, read } = await agentEdits();
  try {
    await review.rejectAll();
    assert.equal(read('app.py'), 'x = 1\ny = 2\nz = 3\n');
    assert.equal(fs.existsSync(path.join(h.root, 'new.py')), false);
    assert.deepEqual(review.pending(), []);
  } finally { h.cleanup(); }
});

test('hunk by hunk: reject one, accept the other', async () => {
  const { h, review, read } = await agentEdits();
  try {
    assert.equal(review.hunksFor('app.py').length, 2);
    await review.rejectHunk('app.py', 0);          // y = 20 → back to y = 2
    assert.equal(read('app.py'), 'x = 1\ny = 2\nz = 3\nw = 4\n');
    await review.acceptHunk('app.py', 0);          // keep the added w = 4
    assert.equal(review.pending().some(f => f.path === 'app.py'), false);
    review.acceptFile('new.py');
    assert.deepEqual(review.pending(), []);
    assert.equal(read('new.py'), 'print("new")\n');
  } finally { h.cleanup(); }
});

test('a second run keeps the original baseline', async () => {
  const { h, review } = await agentEdits();
  try {
    review.track('app.py', 'x = 1\ny = 999\n');      // later snapshot is ignored
    assert.equal(review.baseline('app.py'), 'x = 1\ny = 2\nz = 3\n');
  } finally { h.cleanup(); }
});

test('review can be turned off', async () => {
  const h = buildHarness([callTool('write_file', { path: 'a.py', content: 'a' }), say('ok')]);
  try {
    settings.set('frappe-copilot.approvalMode', 'auto');
    settings.set('frappe-copilot.reviewChanges', false);
    const review = new ReviewController(h.root, new ReviewStore(null));
    (h.runtime.deps as any).review = review;
    await h.runtime.orchestrator.run('write');
    assert.deepEqual(review.pending(), []);
  } finally { h.cleanup(); }
});
