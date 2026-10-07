import assert = require('node:assert/strict');
import test = require('node:test');
import { pruneRunHistory } from '../../session/contextBudget';
import { Message } from '../../types';

function resultTurns(count: number): Message[] {
  return Array.from({ length: count }, (_, i) => ({
    role: 'user' as const,
    content: '',
    toolResults: [{ toolCallId: `call-${i}`, name: 'read_file', content: `${i}:${'x'.repeat(1_000)}` }],
  }));
}

test('large-window models prune old tool output at the absolute cost threshold', () => {
  const history = resultTurns(6);
  const freed = pruneRunHistory(history, 90_000, 1_000_000);
  assert.ok(freed > 0);
  assert.match(history[0].toolResults![0].content, /older tool output cleared/);
  assert.match(history[1].toolResults![0].content, /older tool output cleared/);
  assert.doesNotMatch(history[2].toolResults![0].content, /older tool output cleared/);
});

test('large-window models retain full output below the absolute threshold', () => {
  const history = resultTurns(6);
  assert.equal(pruneRunHistory(history, 79_999, 1_000_000), 0);
  assert.doesNotMatch(history[0].toolResults![0].content, /older tool output cleared/);
});

test('aggressive pruning keeps only the newest tool result', () => {
  const history = resultTurns(6);
  pruneRunHistory(history, 160_000, 1_000_000);
  assert.match(history[4].toolResults![0].content, /older tool output cleared/);
  assert.doesNotMatch(history[5].toolResults![0].content, /older tool output cleared/);
});
