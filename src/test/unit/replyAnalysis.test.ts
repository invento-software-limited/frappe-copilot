import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { Message } from '../../types';
import {
  batchToolCalls, extractXmlToolCalls, handleNoToolCalls, isPermanentError, looksLikeToolsUnsupported,
  MAX_CONSECUTIVE_TRUNCATIONS, MAX_CONSECUTIVE_MALFORMED_TOOL_CALLS,
} from '../../chat/runtime/replyAnalysis';
import { newLoopState } from '../../chat/runtime/types';

test('a plain reply ends the run', () => {
  const history: Message[] = [];
  const result = handleNoToolCalls('All done.', '', false, true, history, newLoopState());
  assert.deepEqual(result, { done: true, assistantText: 'All done.', stopLoop: true });
  assert.equal(history.length, 0);
});

test('a truncated reply is continued, then given up on', () => {
  const history: Message[] = [];
  const state = newLoopState();
  for (let i = 0; i < MAX_CONSECUTIVE_TRUNCATIONS; i++) {
    const r = handleNoToolCalls('partial', '', true, true, history, state);
    assert.equal(r.done, false);
  }
  assert.equal(history.length, MAX_CONSECUTIVE_TRUNCATIONS);
  assert.match(history[0].content, /cut off by the output length limit/);
  const last = handleNoToolCalls('partial', '', true, true, history, state);
  assert.equal(last.done, true);
  assert.match(last.assistantText, /kept getting cut off/);
});

test('a dangling XML tool call counts as truncation only for the XML protocol', () => {
  const dangling = '<tool_call name="read_file"><path>a.py</path>';
  assert.equal(handleNoToolCalls(dangling, '', false, false, [], newLoopState()).done, false);
  assert.equal(handleNoToolCalls(dangling, '', false, true, [], newLoopState()).done, true);
});

test('a garbled XML tool call is corrected, then given up on', () => {
  const state = newLoopState();
  const history: Message[] = [];
  for (let i = 0; i < MAX_CONSECUTIVE_MALFORMED_TOOL_CALLS; i++) {
    assert.equal(handleNoToolCalls('<invoke name="x"></invoke>', '', false, false, history, state).done, false);
  }
  assert.match(history[0].content, /invalid tool-call format/);
  const last = handleNoToolCalls('<tool_check/>', '', false, false, history, state);
  assert.equal(last.done, true);
  assert.match(last.assistantText, /garbled tool-call format/);
});

test('XML tool calls are parsed, including ones written inside reasoning', () => {
  const history: Message[] = [];
  const calls = extractXmlToolCalls('Reading it.\n<tool_call name="read_file"><path>a.py</path></tool_call>', '', history, 'r-1');
  assert.deepEqual(calls, [{ callId: 'r-1-0', name: 'read_file', args: { path: 'a.py' } }]);
  assert.equal(history[0].role, 'assistant');

  const fromThinking: Message[] = [];
  const recovered = extractXmlToolCalls('Let me check.', '<tool_call name="glob"><pattern>*.py</pattern></tool_call>', fromThinking, 'r-2');
  assert.equal(recovered[0].name, 'glob');
  assert.match(fromThinking[0].content, /Let me check\.\n\n<tool_call name="glob">/);
});

test('consecutive read-only calls run together; others alone', () => {
  const call = (name: string) => ({ callId: name, name, args: {} });
  const batches = batchToolCalls([call('read_file'), call('grep_search'), call('write_file'), call('glob'), call('read_file')]);
  assert.deepEqual(batches.map(b => b.map(c => c.name)), [['read_file', 'grep_search'], ['write_file'], ['glob', 'read_file']]);
});

test('permanent vs retryable errors', () => {
  assert.equal(isPermanentError(new Error('401 authentication failed')), true);
  assert.equal(isPermanentError(new Error('429 rate limit')), false);
  assert.equal(isPermanentError(new Error('socket hang up')), false);
  assert.equal(looksLikeToolsUnsupported(new Error('Request failed (400): tools are not supported')), true);
  assert.equal(looksLikeToolsUnsupported(new Error('Request failed (500): server error')), false);
});
