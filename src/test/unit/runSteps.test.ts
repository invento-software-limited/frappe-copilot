import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { Message } from '../../types';
import { buildRunSteps } from '../../chat/runSteps';
import { parseXmlToolCalls } from '../../chat/xmlToolCalls';

test('native transcript becomes text, reasoning and tool steps with results', () => {
  const entries: Message[] = [
    { role: 'assistant', content: 'Reading the file.', thinkingBlocks: [{ thinking: 'need context' }], toolCalls: [{ id: 't1', name: 'read_file', input: { path: 'a.py' } }] },
    { role: 'user', content: '', toolResults: [{ toolCallId: 't1', name: 'read_file', content: '1\tprint()' }] },
    { role: 'assistant', content: 'It prints.' },
  ];
  const steps = buildRunSteps(entries, 'It prints.');
  assert.deepEqual(steps, [
    { kind: 'text', text: 'Reading the file.', thinking: 'need context' },
    { kind: 'tool', id: 't1', name: 'read_file', args: { path: 'a.py' }, output: '1\tprint()', isError: false },
  ]);
});

test('XML transcript results attach to calls in order, one result per message', () => {
  const entries: Message[] = [
    { role: 'assistant', content: '<tool_call name="read_file"><path>a</path></tool_call>\n<tool_call name="read_file"><path>b</path></tool_call>' },
    { role: 'user', content: '<tool_result name="read_file">\nA\n</tool_result>' },
    { role: 'user', content: '<tool_result name="read_file">\nB\n</tool_result>' },
  ];
  const steps = buildRunSteps(entries, '');
  assert.deepEqual(steps.map(s => s.kind === 'tool' ? s.output : null), ['A', 'B']);
});

test('long tool output is capped', () => {
  const entries: Message[] = [
    { role: 'assistant', content: '', toolCalls: [{ id: 'x', name: 'read_file', input: {} }] },
    { role: 'user', content: '', toolResults: [{ toolCallId: 'x', name: 'read_file', content: 'z'.repeat(10000) }] },
  ];
  const [step] = buildRunSteps(entries, '');
  assert.ok(step.kind === 'tool' && step.output!.length < 4100);
});

test('XML parser reads params and CDATA', () => {
  const [call] = parseXmlToolCalls('<tool_call name="write_file"><path>a.py</path><content><![CDATA[x < y]]></content></tool_call>');
  assert.deepEqual(call.args, { path: 'a.py', content: 'x < y' });
});
