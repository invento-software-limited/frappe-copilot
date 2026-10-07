import * as vscode from 'vscode';
import { Message, ChatOptions, ChatResponse } from '../types';
import { LLMProvider } from './interface';
import { toOpenAIMessages, toOpenAITools, OpenAIToolAccumulator, samplingParams } from './openaiMessage';
import { openAIUsage } from './tokenUsage';

/** Response shape from OpenAI-compatible /chat/completions endpoint. */
interface OpenCodeZenResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    message?: { role: string; content: string };
    delta?: { role?: string; content?: string; tool_calls?: any[] };
    finish_reason: string | null;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  };
}

const API_KEY_SECRET = 'frappe-copilot.opencodeZenApiKey';

/**
 * OpenCode Zen provider adapter.
 * Uses the OpenAI-compatible /v1/chat/completions API.
 * API key is stored in VS Code SecretStorage, never in settings.
 */
export class OpenCodeZenProvider implements LLMProvider {
  readonly name = 'OpenCode Zen';

  private endpoint: string;
  private model: string;
  private temperature: number;
  private secrets: vscode.SecretStorage;
  private _apiKey: string | undefined = undefined;

  constructor(secrets: vscode.SecretStorage) {
    const config = vscode.workspace.getConfiguration('frappe-copilot.opencodeZen');
    this.endpoint = config.get<string>('endpoint', 'https://opencode.ai/zen/v1');
    this.model = config.get<string>('model', 'deepseek-v4-flash-free');
    this.temperature = config.get<number>('temperature', 0.7);
    this.secrets = secrets;

    // Preload API key on construction
    this.secrets.get(API_KEY_SECRET).then(key => {
      this._apiKey = key;
    });
  }

  /** Reload settings from VS Code configuration. */
  refreshConfig(): void {
    const config = vscode.workspace.getConfiguration('frappe-copilot.opencodeZen');
    this.endpoint = config.get<string>('endpoint', 'https://opencode.ai/zen/v1');
    this.model = config.get<string>('model', 'deepseek-v4-flash-free');
    this.temperature = config.get<number>('temperature', 0.7);
  }

  /** Check if an API key is stored. */
  async hasApiKey(): Promise<boolean> {
    if (this._apiKey) return true;
    this._apiKey = await this.secrets.get(API_KEY_SECRET);
    return !!this._apiKey;
  }

  /** Store an API key (persisted in SecretStorage). */
  async setApiKey(key: string): Promise<void> {
    await this.secrets.store(API_KEY_SECRET, key);
    this._apiKey = key;
  }

  /** Remove the API key from SecretStorage. */
  async clearApiKey(): Promise<void> {
    await this.secrets.delete(API_KEY_SECRET);
    this._apiKey = undefined;
  }

  /** Build the headers for an API request. */
  private async buildHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (!this._apiKey) {
      this._apiKey = await this.secrets.get(API_KEY_SECRET);
    }

    if (this._apiKey) {
      headers['Authorization'] = `Bearer ${this._apiKey}`;
    }

    return headers;
  }

  /** Build the request body. */
  private buildBody(
    messages: Message[],
    options?: ChatOptions,
    stream: boolean = false
  ): Record<string, unknown> {
    return {
      model: options?.model || this.model,
      messages: toOpenAIMessages(messages),
      ...samplingParams(options?.model || this.model, options?.temperature ?? this.temperature, options?.effort),
      max_tokens: options?.maxTokens ?? 8192,
      stream,
      ...(options?.tools?.length ? { tools: toOpenAITools(options.tools), tool_choice: 'auto' } : {}),
    };
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<ChatResponse> {
    const url = `${this.endpoint}/chat/completions`;
    const headers = await this.buildHeaders();
    const body = this.buildBody(messages, options, false);

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300000),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`OpenCode Zen API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as OpenCodeZenResponse;

    return {
      content: data.choices[0]?.message?.content || '',
      model: data.model,
      truncated: data.choices[0]?.finish_reason === 'length',
      usage: openAIUsage(data.usage),
    };
  }

  async *chatStream(
    messages: Message[],
    options?: ChatOptions,
    abortSignal?: AbortSignal
  ): AsyncIterable<ChatResponse> {
    const url = `${this.endpoint}/chat/completions`;
    const headers = await this.buildHeaders();
    const body = this.buildBody(messages, options, true);

    const MAX_RETRIES = 3;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (abortSignal?.aborted) { return; }

      if (attempt > 0) {
        const delaySec = Math.pow(2, attempt) * 1.5; // 3s, 6s
        options?.onRetry?.(attempt, delaySec, lastError?.message || 'Server overloaded');
        await new Promise(res => setTimeout(res, delaySec * 1000));
        if (abortSignal?.aborted) { return; }
      }

      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: abortSignal || AbortSignal.timeout(300000),
        });
      } catch (e: any) {
        lastError = e;
        if (e.name === 'AbortError') throw e;
        options?.onRetry?.(attempt + 1, 3, e.message);
        continue; // network error — retry
      }

      // Retry on 503 (overloaded) and 429 (rate limit)
      if (response.status === 503 || response.status === 429) {
        const errorText = await response.text().catch(() => '');
        lastError = new Error(`OpenCode Zen API error (${response.status}): ${errorText}`);
        continue;
      }

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new Error(`OpenCode Zen API error (${response.status}): ${errorText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('Response body is not readable');

      const decoder = new TextDecoder();
      let buffer = '';
      const toolAcc = new OpenAIToolAccumulator();
      let reasoningText = '';
      let lengthCut = false;
      let usage: ChatResponse['usage'];

      try {
        readLoop:
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: ')) continue;

            const dataStr = trimmed.slice(6).trim();
            if (dataStr === '[DONE]') break readLoop;

            try {
              const chunk = JSON.parse(dataStr) as OpenCodeZenResponse;
              const choice = chunk.choices[0];
              const deltaObj = choice?.delta;
              const delta = deltaObj?.content || '';
              const reasoning = (deltaObj as any)?.reasoning_content || '';
              // 'length' means the provider cut the turn off at max_tokens, not
              // that the model finished — without surfacing this, a response
              // truncated mid-thinking or mid-prose (no dangling tool-call tag
              // to catch it) looks like a complete answer and the agent loop
              // silently ends the run with a chopped-off reply.
              const truncated = choice?.finish_reason === 'length';
              toolAcc.add(deltaObj?.tool_calls);
              if (chunk.usage) {
                usage = openAIUsage(chunk.usage);
              }
              reasoningText += reasoning;
              if (truncated) lengthCut = true;
              if (delta || reasoning || truncated) {
                yield {
                  content: delta,
                  reasoning: reasoning,
                  model: chunk.model || this.model,
                  truncated,
                  usage: openAIUsage(chunk.usage),
                };
              }
            } catch {
              // Skip malformed JSON chunks
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
      const toolCalls = toolAcc.finish();
      if (toolCalls.length || usage || (toolAcc.incompleteToolCall && !lengthCut)) {
        yield {
          content: '',
          model: this.model,
          usage,
          truncated: toolAcc.incompleteToolCall,
          toolCalls: toolCalls.length ? toolCalls : undefined,
          thinkingBlocks: toolCalls.length && reasoningText ? [{ thinking: reasoningText }] : undefined,
        };
      }
      return; // success — exit the retry loop
    }

    // All retries exhausted
    throw lastError || new Error('OpenCode Zen API request failed after retries.');
  }

  supportsNativeTools(): boolean {
    return true;
  }

  getModelId(): string {
    return this.model;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const url = `${this.endpoint}/models`;
      const response = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async getModels(): Promise<string[]> {
    try {
      const url = `${this.endpoint}/models`;
      const headers = await this.buildHeaders();
      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) return ['deepseek-v4-flash-free'];

      const data = await response.json() as any;
      if (data && Array.isArray(data.data)) {
        return data.data.map((m: any) => m.id);
      }
    } catch {
      // Fallback on network/fetch error
    }
    return ['deepseek-v4-flash-free'];
  }
}
