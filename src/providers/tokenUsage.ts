import { TokenUsage } from '../types';

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** Normalizes OpenAI-compatible usage, where cached tokens are included in prompt_tokens. */
export function openAIUsage(raw: OpenAIUsage | undefined): TokenUsage | undefined {
  if (!raw) return undefined;
  const promptTokens = positive(raw.prompt_tokens);
  const completionTokens = positive(raw.completion_tokens);
  const cacheReadTokens = Math.min(promptTokens, positive(raw.prompt_tokens_details?.cached_tokens));
  const cacheWriteTokens = Math.min(promptTokens - cacheReadTokens, positive(raw.prompt_tokens_details?.cache_write_tokens));
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    freshInputTokens: promptTokens - cacheReadTokens - cacheWriteTokens,
    cacheReadTokens,
    cacheWriteTokens,
  };
}

/** Normalizes Anthropic usage, where fresh, cache-read and cache-write input are separate. */
export function anthropicUsage(raw: AnthropicUsage | undefined): TokenUsage | undefined {
  if (!raw) return undefined;
  const freshInputTokens = positive(raw.input_tokens);
  const cacheReadTokens = positive(raw.cache_read_input_tokens);
  const cacheWriteTokens = positive(raw.cache_creation_input_tokens);
  const completionTokens = positive(raw.output_tokens);
  const promptTokens = freshInputTokens + cacheReadTokens + cacheWriteTokens;
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    freshInputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  };
}

function positive(value: number | undefined): number {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : 0;
}
