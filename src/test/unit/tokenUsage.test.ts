import assert = require('node:assert/strict');
import test = require('node:test');
import { anthropicUsage, openAIUsage } from '../../providers/tokenUsage';

test('OpenAI usage separates cached prompt tokens from fresh input', () => {
  assert.deepEqual(openAIUsage({
    prompt_tokens: 20_000,
    completion_tokens: 800,
    total_tokens: 20_800,
    prompt_tokens_details: { cached_tokens: 15_000 },
  }), {
    promptTokens: 20_000,
    completionTokens: 800,
    totalTokens: 20_800,
    freshInputTokens: 5_000,
    cacheReadTokens: 15_000,
    cacheWriteTokens: 0,
  });
});

test('Anthropic usage combines its separate input categories into logical prompt size', () => {
  assert.deepEqual(anthropicUsage({
    input_tokens: 2_000,
    cache_read_input_tokens: 16_000,
    cache_creation_input_tokens: 1_000,
    output_tokens: 700,
  }), {
    promptTokens: 19_000,
    completionTokens: 700,
    totalTokens: 19_700,
    freshInputTokens: 2_000,
    cacheReadTokens: 16_000,
    cacheWriteTokens: 1_000,
  });
});

test('usage normalization clamps invalid provider counters', () => {
  assert.deepEqual(openAIUsage({
    prompt_tokens: 100,
    completion_tokens: -1,
    prompt_tokens_details: { cached_tokens: 150 },
  }), {
    promptTokens: 100,
    completionTokens: 0,
    totalTokens: 100,
    freshInputTokens: 0,
    cacheReadTokens: 100,
    cacheWriteTokens: 0,
  });
});
