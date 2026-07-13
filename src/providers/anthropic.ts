import * as vscode from 'vscode';
import { Message, ChatOptions, ChatResponse } from '../types';
import { LLMProvider } from './interface';

const API_KEY_SECRET = 'frappe-copilot.anthropicApiKey';

export class AnthropicProvider implements LLMProvider {
  readonly name = 'Anthropic';
  private endpoint: string = 'https://api.anthropic.com/v1';
  private model: string = 'claude-3-5-sonnet-latest';
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
    const config = vscode.workspace.getConfiguration('frappe-copilot.anthropic');
    this.endpoint = config.get<string>('endpoint', 'https://api.anthropic.com/v1');
    this.model = config.get<string>('model', 'claude-3-5-sonnet-latest');
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
      'anthropic-version': '2023-06-01',
    };

    if (!this._apiKey) {
      this._apiKey = await this.secrets.get(API_KEY_SECRET);
    }

    if (this._apiKey) {
      headers['x-api-key'] = this._apiKey;
    }

    return headers;
  }

  private transformMessages(messages: Message[]): { system?: string; messages: { role: string; content: string }[] } {
    const systemMessage = messages.find(m => m.role === 'system');
    const systemPrompt = systemMessage ? systemMessage.content : undefined;

    const filtered = messages
      .filter(m => m.role !== 'system')
      .map(m => {
        let role = m.role;
        if (role !== 'assistant') {
          role = 'user';
        }
        return { role, content: m.content };
      });

    const merged: { role: string; content: string }[] = [];
    for (const msg of filtered) {
      if (merged.length > 0 && merged[merged.length - 1].role === msg.role) {
        merged[merged.length - 1].content += '\n\n' + msg.content;
      } else {
        merged.push(msg);
      }
    }

    return { system: systemPrompt, messages: merged };
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<ChatResponse> {
    const url = `${this.endpoint}/messages`;
    const headers = await this.buildHeaders();
    const { system, messages: transformed } = this.transformMessages(messages);
    const body = {
      model: options?.model || this.model,
      messages: transformed,
      system,
      temperature: options?.temperature ?? this.temperature,
      max_tokens: options?.maxTokens || 4096,
      stream: false,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`Anthropic API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as any;
    return {
      content: data.content?.[0]?.text || '',
      model: data.model || this.model,
    };
  }

  async *chatStream(
    messages: Message[],
    options?: ChatOptions,
    abortSignal?: AbortSignal
  ): AsyncIterable<ChatResponse> {
    const url = `${this.endpoint}/messages`;
    const headers = await this.buildHeaders();
    const { system, messages: transformed } = this.transformMessages(messages);
    const body = {
      model: options?.model || this.model,
      messages: transformed,
      system,
      temperature: options?.temperature ?? this.temperature,
      max_tokens: options?.maxTokens || 4096,
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
          signal: abortSignal || AbortSignal.timeout(30000),
        });
      } catch (e: any) {
        lastError = e;
        if (e.name === 'AbortError') throw e;
        options?.onRetry?.(attempt + 1, 3, e.message);
        continue;
      }

      if (response.status === 503 || response.status === 429) {
        const errorText = await response.text().catch(() => '');
        lastError = new Error(`Anthropic API error (${response.status}): ${errorText}`);
        continue;
      }

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new Error(`Anthropic API error (${response.status}): ${errorText}`);
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
            try {
              const chunk = JSON.parse(dataStr);
              if (chunk.type === 'content_block_delta' && chunk.delta?.text) {
                yield {
                  content: chunk.delta.text,
                  model: this.model,
                };
              }
            } catch {
              // Skip other stream events
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
      return;
    }

    throw lastError || new Error('Anthropic API request failed after retries.');
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
            .filter((id: string) => id.startsWith('claude-'));
          if (models.length > 0) {
            return models.sort();
          }
        }
      }
    } catch (e) {
      console.warn('Failed to fetch Anthropic models dynamically:', e);
    }
    return ['claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest', 'claude-3-opus-latest'];
  }
}
