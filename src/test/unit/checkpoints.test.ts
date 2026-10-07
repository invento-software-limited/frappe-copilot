import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Message } from '../../types';
import {
  buildRevertPreview, captureBeforeImage, mergePromptCheckpoint, readFileCapped, restoreCheckpointEntries,
} from '../../chat/checkpoints';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fc-ckpt-'));
}

test('restoring a checkpoint undoes edits and removes created files', () => {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'a.py'), 'original');
  const edited = captureBeforeImage(root, 'a.py');
  const created = captureBeforeImage(root, 'new/b.py');
  fs.writeFileSync(path.join(root, 'a.py'), 'changed');
  fs.mkdirSync(path.join(root, 'new'));
  fs.writeFileSync(path.join(root, 'new/b.py'), 'brand new');

  const preview = buildRevertPreview(root, [edited, created]);
  assert.equal(preview[1].willDelete, true);
  assert.ok(preview[0].diffHunks!.some(h => h.added && h.value.includes('original')));

  restoreCheckpointEntries(root, [edited, created]);
  assert.equal(fs.readFileSync(path.join(root, 'a.py'), 'utf-8'), 'original');
  assert.equal(fs.existsSync(path.join(root, 'new/b.py')), false);
  fs.rmSync(root, { recursive: true });
});

test('a prompt checkpoint keeps the earliest before-image per file', () => {
  const messages: Message[] = [
    { role: 'user', content: 'go', promptId: 'p' },
    { role: 'assistant', content: 'stage 1', promptId: 'p', runId: 'r1', hasCheckpoint: true },
    { role: 'assistant', content: 'stage 2', promptId: 'p', runId: 'r2', hasCheckpoint: true },
    { role: 'assistant', content: 'other', promptId: 'q', runId: 'r3', hasCheckpoint: true },
  ];
  const byRun: Record<string, any[]> = {
    r1: [{ path: 'a.py', existedBefore: true, originalContent: 'v0' }],
    r2: [{ path: 'a.py', existedBefore: true, originalContent: 'v1' }, { path: 'b.py', existedBefore: false }],
  };
  const merged = mergePromptCheckpoint(messages, id => byRun[id] || [], 'p')!;
  assert.deepEqual(merged.map(e => [e.path, e.originalContent]), [['a.py', 'v0'], ['b.py', undefined]]);
  assert.equal(mergePromptCheckpoint(messages, () => [], 'none'), null);
});

test('readFileCapped returns null for missing files', () => {
  assert.equal(readFileCapped(path.join(os.tmpdir(), 'definitely-missing-file.txt')), null);
});
