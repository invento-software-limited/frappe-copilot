import * as vscode from 'vscode';
import { Message, ChatOptions, ChatResponse } from '../types';
import { LLMProvider } from './interface';
import { toOpenAIMessage } from './openaiMessage';

const API_KEY_SECRET = 'frappe-copilot.openaiApiKey';

export class OpenAIProvider implements LLMProvider {
  readonly name = 'OpenAI';
  private endpoint: string = 'https://api.openai.com/v1';
  private model: string = 'gpt-4o';
  private temperature: number = 0.7;
  private secrets: vscode.SecretStorage;
  private _apiKey: string | undefined = undefined;

  constructor(secrets: vscode.SecretStorage) {
    this.secrets = secrets;
    this.refreshConfig();
    this.secrets.get(API_KEY_SECRET).then(key => {
      this._apiKey = key;
    });
  }

  refreshConfig(): void {
    const config = vscode.workspace.getConfiguration('frappe-copilot.openai');
    this.endpoint = config.get<string>('endpoint', 'https://api.openai.com/v1');
    this.model = config.get<string>('model', 'gpt-4o');
    this.temperature = config.get<number>('temperature', 0.7);
  }

  async hasApiKey(): Promise<boolean> {
    if (this._apiKey) return true;
    this._apiKey = await this.secrets.get(API_KEY_SECRET);
    return !!this._apiKey;
  }

  async setApiKey(key: string): Promise<void> {
    await this.secrets.store(API_KEY_SECRET, key);
    this._apiKey = key;
  }

  async clearApiKey(): Promise<void> {
    await this.secrets.delete(API_KEY_SECRET);
    this._apiKey = undefined;
  }

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

  async chat(messages: Message[], options?: ChatOptions): Promise<ChatResponse> {
    const url = `${this.endpoint}/chat/completions`;
    const headers = await this.buildHeaders();
    const body = {
      model: options?.model || this.model,
      messages: messages.map(toOpenAIMessage),
      temperature: options?.temperature ?? this.temperature,
      stream: false,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300000),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as any;
    return {
      content: data.choices?.[0]?.message?.content || '',
      model: data.model || this.model,
      truncated: data.choices?.[0]?.finish_reason === 'length',
    };
  }

  async *chatStream(
    messages: Message[],
    options?: ChatOptions,
    abortSignal?: AbortSignal
  ): AsyncIterable<ChatResponse> {
    const url = `${this.endpoint}/chat/completions`;
    const headers = await this.buildHeaders();
    const body = {
      model: options?.model || this.model,
      messages: messages.map(toOpenAIMessage),
      temperature: options?.temperature ?? this.temperature,
      stream: true,
    };

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
        continue;
      }

      if (response.status === 503 || response.status === 429) {
        const errorText = await response.text().catch(() => '');
        lastError = new Error(`OpenAI API error (${response.status}): ${errorText}`);
        continue;
      }

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('Response body is not readable');

      const decoder = new TextDecoder();
      let buffer = '';

      try {
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
            if (dataStr === '[DONE]') return;

            try {
              const chunk = JSON.parse(dataStr);
              const choice = chunk.choices?.[0];
              const deltaObj = choice?.delta;
              const delta = deltaObj?.content || '';
              const reasoning = (deltaObj as any)?.reasoning_content || '';
              // 'length' means the API cut the turn off at max_tokens, not that
              // the model finished — without this, a response truncated
              // mid-thinking or mid-prose (no dangling tool-call tag to catch
              // it) looks like a complete answer and the agent loop silently
              // ends the run with a chopped-off reply.
              const truncated = choice?.finish_reason === 'length';
              if (delta || reasoning || truncated) {
                yield {
                  content: delta,
                  reasoning: reasoning,
                  model: chunk.model || this.model,
                  truncated,
                };
              }
            } catch {
              // Skip malformed chunks
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
      return;
    }

    throw lastError || new Error('OpenAI API request failed after retries.');
  }

  async isAvailable(): Promise<boolean> {
    return this.hasApiKey();
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

      if (response.ok) {
        const data = await response.json() as any;
        if (data && Array.isArray(data.data)) {
          const models = data.data
            .map((m: any) => m.id)
            .filter((id: string) => id.startsWith('gpt-') || id.startsWith('o1-') || id.startsWith('o3-'));
          if (models.length > 0) {
            return models.sort();
          }
        }
      }
    } catch (e) {
      console.warn('Failed to fetch OpenAI models dynamically:', e);
    }
    return ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'];
  }
}
