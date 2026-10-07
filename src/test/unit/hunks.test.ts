import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { acceptHunk, changeStats, computeHunks, rejectHunk, splitLines } from '../../review/hunks';

const BASE = 'import frappe\n\ndef a():\n    return 1\n\ndef b():\n    return 2\n';
const CURRENT = 'import frappe\nimport json\n\ndef a():\n    return 10\n\ndef b():\n    return 2\n\ndef c():\n    pass\n';

test('hunks group each contiguous change', () => {
  const hunks = computeHunks(BASE, CURRENT);
  assert.equal(hunks.length, 3);
  assert.deepEqual(hunks[0], { baseStart: 1, baseLines: [], currentStart: 1, currentLines: ['import json\n'] });
  assert.deepEqual(hunks[1], { baseStart: 3, baseLines: ['    return 1\n'], currentStart: 4, currentLines: ['    return 10\n'] });
  assert.deepEqual(changeStats(hunks), { added: 5, removed: 1 });
});

test('rejecting every hunk one at a time restores the baseline', () => {
  let current = CURRENT;
  while (computeHunks(BASE, current).length) current = rejectHunk(current, computeHunks(BASE, current)[0]);
  assert.equal(current, BASE);
});

test('accepting every hunk one at a time makes the baseline the current text', () => {
  let base = BASE;
  for (let i = 0; i < 10 && computeHunks(base, CURRENT).length; i++) base = acceptHunk(base, computeHunks(base, CURRENT).at(-1)!);
  assert.equal(base, CURRENT);
});

test('rejecting one hunk leaves the others pending', () => {
  const [, middle] = computeHunks(BASE, CURRENT);
  const after = rejectHunk(CURRENT, middle);
  assert.match(after, /return 1\n/);
  assert.match(after, /import json/);
  assert.equal(computeHunks(BASE, after).length, 2);
});

test('a new file is one all-added hunk, and line endings survive', () => {
  assert.deepEqual(computeHunks('', 'a\r\nb'), [{ baseStart: 0, baseLines: [], currentStart: 0, currentLines: ['a\r\n', 'b'] }]);
  assert.deepEqual(splitLines('x\r\ny\n'), ['x\r\n', 'y\n']);
  assert.equal(rejectHunk('a\r\nb', computeHunks('', 'a\r\nb')[0]), '');
});
