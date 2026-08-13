import * as vscode from 'vscode';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { Message, ChatOptions, ChatResponse, ImageAttachment } from '../types';
import { LLMProvider } from './interface';

const API_KEY_SECRET = 'frappe-copilot.anthropicApiKey';

/** A history message flattened to Anthropic's role model, with any hydrated
 *  image attachments kept alongside the text until content blocks are built. */
interface TransformedMessage {
  role: string;
  content: string;
  images: ImageAttachment[];
}

export class AnthropicProvider implements LLMProvider {
  readonly name = 'Anthropic';
  private endpoint: string = 'https://api.anthropic.com/v1';
  private model: string = 'claude-sonnet-5';
  private temperature: number = 0.7;
  private extendedThinking: boolean = false;
  private thinkingBudgetTokens: number = 10000;
  private secrets: vscode.SecretStorage;
  private _apiKey: string | undefined = undefined;

  constructor(secrets: vscode.SecretStorage) {
    this.secrets = secrets;
    this.refreshConfig();
    this.secrets.get(API_KEY_SECRET).then(key => {
      this._apiKey = key;
      if (!this._apiKey) {
        this.loadApiKeyFromClaudeJson();
      }
    });
  }

  refreshConfig(): void {
    const config = vscode.workspace.getConfiguration('frappe-copilot.anthropic');
    this.endpoint = config.get<string>('endpoint', 'https://api.anthropic.com/v1');
    this.model = config.get<string>('model', 'claude-sonnet-5');
    this.temperature = config.get<number>('temperature', 0.7);
    this.extendedThinking = config.get<boolean>('extendedThinking', false);
    this.thinkingBudgetTokens = config.get<number>('thinkingBudgetTokens', 10000);
  }

  private loadApiKeyFromClaudeJson(): void {
    try {
      let claudeJsonPath = '';
      if (process.env.CLAUDE_CONFIG_DIR) {
        claudeJsonPath = path.join(process.env.CLAUDE_CONFIG_DIR, 'claude.json');
        if (!fs.existsSync(claudeJsonPath)) {
          claudeJsonPath = path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json');
        }
      }
      
      if (!claudeJsonPath || !fs.existsSync(claudeJsonPath)) {
        const homeDir = os.homedir();
        claudeJsonPath = path.join(homeDir, '.claude.json');
      }

      if (fs.existsSync(claudeJsonPath)) {
        const content = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
        if (content.primaryApiKey) {
          this._apiKey = content.primaryApiKey;
        }
      }
    } catch (e) {
      console.warn('Failed to load API key from Claude Code config:', e);
    }
  }

  async hasApiKey(): Promise<boolean> {
    if (this._apiKey) return true;
    this._apiKey = await this.secrets.get(API_KEY_SECRET);
    if (!this._apiKey) {
      this.loadApiKeyFromClaudeJson();
    }
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

  private async refreshAccessToken(refreshToken: string): Promise<string | undefined> {
    try {
      const response = await fetch('https://platform.claude.com/v1/oauth/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
        })
      });

      if (!response.ok) {
        const text = await response.text();
        console.error('Failed to refresh access token:', text);
        return undefined;
      }

      const data = await response.json() as any;
      const accessToken = data.access_token;
      const newRefreshToken = data.refresh_token || refreshToken;
      const expiresIn = data.expires_in || 3600;
      const expiresAt = Date.now() + expiresIn * 1000;

      if (accessToken) {
        const updatedCreds = JSON.stringify({
          accessToken,
          refreshToken: newRefreshToken,
          expiresAt
        });
        await this.secrets.store(API_KEY_SECRET, updatedCreds);
        this._apiKey = updatedCreds;
        return accessToken;
      }
    } catch (e) {
      console.error('Error during refreshAccessToken:', e);
    }
    return undefined;
  }

  private sessionId = this.generateSessionId();

  private generateSessionId(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  private async buildHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    };

    if (!this._apiKey) {
      this._apiKey = await this.secrets.get(API_KEY_SECRET);
    }
    if (!this._apiKey) {
      this.loadApiKeyFromClaudeJson();
    }

    if (this._apiKey) {
      if (this._apiKey.startsWith('{')) {
        try {
          const creds = JSON.parse(this._apiKey);
          let token = creds.accessToken;
          
          const now = Date.now();
          if (creds.refreshToken && creds.expiresAt && now + 5 * 60 * 1000 >= creds.expiresAt) {
            token = await this.refreshAccessToken(creds.refreshToken);
          }
          
          if (token) {
            headers['Authorization'] = `Bearer ${token}`;
            headers['anthropic-beta'] = 'oauth-2025-04-20';
            headers['x-app'] = 'cli';
            headers['User-Agent'] = 'claude-cli/0.23.0';
            headers['X-Claude-Code-Session-Id'] = this.sessionId;
          }
        } catch (e) {
          console.error('Failed to parse or refresh OAuth credentials:', e);
        }
      } else if (this._apiKey.startsWith('sk-ant-oat')) {
        headers['Authorization'] = `Bearer ${this._apiKey}`;
        headers['anthropic-beta'] = 'oauth-2025-04-20';
        headers['x-app'] = 'cli';
        headers['User-Agent'] = 'claude-cli/0.23.0';
        headers['X-Claude-Code-Session-Id'] = this.sessionId;
      } else {
        headers['x-api-key'] = this._apiKey;
      }
    }

    return headers;
  }

  /** Which credential is actually being used for requests: a real Anthropic API key,
   *  or an OAuth token from the Claude.ai / Claude Code "Login with Claude" flow.
   *  These are two distinct auth systems with different rate limits and API behavior
   *  (OAuth shares quota with other Claude Code sessions on the account), so surfacing
   *  which one is active helps explain rate-limit and parameter errors to the user. */
  async getAuthMode(): Promise<'api-key' | 'oauth' | 'none'> {
    if (!this._apiKey) {
      this._apiKey = await this.secrets.get(API_KEY_SECRET);
      if (!this._apiKey) {
        this.loadApiKeyFromClaudeJson();
      }
    }
    if (!this._apiKey) return 'none';
    return this._apiKey.startsWith('{') || this._apiKey.startsWith('sk-ant-oat') ? 'oauth' : 'api-key';
  }

  /** Reads the `retry-after` header Anthropic sends on 429/503 responses. Returns
   *  undefined if absent or unparseable — callers should fall back to their own backoff. */
  private parseRetryAfterSeconds(response: Response): number | undefined {
    const header = response.headers.get('retry-after');
    if (!header) return undefined;
    const seconds = Number(header);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
  }

  private buildRateLimitHint(mode: 'api-key' | 'oauth' | 'none'): string {
    if (mode === 'oauth') {
      return ' This request already retried automatically and is still rate limited — sending it again right away will not help. You are signed in with your Claude.ai (Pro/Max) subscription via OAuth, which shares rate limits with any other active Claude Code sessions on this account and has lower throughput than a direct Anthropic API key. Wait roughly a minute before retrying, or switch to an API key from console.anthropic.com in Settings for dedicated capacity.';
    }
    return ' This request already retried automatically and is still rate limited. Wait a moment before trying again, or check your usage limits at console.anthropic.com.';
  }

  private transformMessages(messages: Message[]): { system?: string; messages: TransformedMessage[] } {
    const systemMessage = messages.find(m => m.role === 'system');
    const systemPrompt = systemMessage ? systemMessage.content : undefined;

    const filtered = messages
      .filter(m => m.role !== 'system')
      .map(m => {
        let role = m.role;
        if (role !== 'assistant') {
          role = 'user';
        }
        // Only hydrated attachments carry base64; a path-only one (never sent
        // through ChatPanel.hydrateImages, or whose file went missing) is
        // dropped rather than shipped as an invalid empty image block.
        const images = (m.images || []).filter(img => !!img.data);
        return { role, content: m.content, images };
      });

    const merged: TransformedMessage[] = [];
    for (const msg of filtered) {
      const prev = merged[merged.length - 1];
      if (prev && prev.role === msg.role) {
        prev.content += '\n\n' + msg.content;
        prev.images = [...prev.images, ...msg.images];
      } else {
        merged.push({ ...msg });
      }
    }

    return { system: systemPrompt, messages: merged };
  }

  /** Anthropic wants images *before* the text that refers to them. */
  private toContentBlocks(msg: TransformedMessage): any[] {
    const blocks: any[] = msg.images.map(img => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.data },
    }));
    if (msg.content) {
      blocks.push({ type: 'text', text: msg.content });
    }
    return blocks;
  }

  private getFallbackModel(model: string): string {
    const fallbacks: Record<string, string> = {
      'claude-sonnet-5': 'claude-opus-4-8',
      'claude-fable-5': 'claude-sonnet-5',
      'claude-opus-4-8': 'claude-sonnet-5',
      'claude-haiku-4-5-20251001': 'claude-sonnet-5',
      // Legacy aliases, retained in case an older pinned model id 404s.
      'claude-3-5-sonnet-latest': 'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku-latest': 'claude-3-5-haiku-20241022',
      'claude-3-opus-latest': 'claude-3-opus-20240229',
      'claude-3-7-sonnet-latest': 'claude-3-7-sonnet-20250219',
    };
    return fallbacks[model] || model;
  }

  /** Marks the system prompt and the last message as cache breakpoints (Anthropic
   *  prompt caching). The system prompt is near-identical across every step of an
   *  agent run and across turns in the same session; the last message marks the
   *  end of "history so far", so a growing agent loop or conversation resends only
   *  the newest content as fresh input tokens instead of the whole prefix each time.
   *  Breakpoints under the ~1024-token minimum are silently ignored by the API, so
   *  this is always safe to apply. */
  private applyCacheControl(
    system: string | undefined,
    transformed: TransformedMessage[]
  ): { system: any; messages: any[] } {
    const cachedSystem = system
      ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
      : undefined;

    const messages = transformed.map((m, i) => {
      const isLast = i === transformed.length - 1;
      // A message with images always needs block form; a plain one only does
      // when it carries the trailing cache breakpoint.
      if (!isLast && m.images.length === 0) {
        return { role: m.role, content: m.content };
      }
      const blocks = this.toContentBlocks(m);
      if (isLast && blocks.length > 0) {
        blocks[blocks.length - 1].cache_control = { type: 'ephemeral' };
      }
      return { role: m.role, content: blocks };
    });

    return { system: cachedSystem, messages };
  }

  private buildRequestBody(
    model: string,
    system: string | undefined,
    transformed: TransformedMessage[],
    temp: number | undefined,
    maxTokens: number | undefined,
    stream: boolean
  ): any {
    const { system: cachedSystem, messages } = this.applyCacheControl(system, transformed);
    const body: any = {
      model,
      messages,
      system: cachedSystem,
      stream,
    };

    if (this.extendedThinking) {
      // Extended thinking requires max_tokens to exceed the thinking budget,
      // and forbids overriding temperature (the API pins it to 1 internally).
      body.max_tokens = Math.max(maxTokens || 16384, this.thinkingBudgetTokens + 8192);
      body.thinking = { type: 'enabled', budget_tokens: this.thinkingBudgetTokens };
    } else {
      body.max_tokens = maxTokens || 8192;
      if (temp !== undefined) {
        body.temperature = temp;
      }
    }

    return body;
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<ChatResponse> {
    const url = `${this.endpoint}/messages`;
    const headers = await this.buildHeaders();
    const { system, messages: transformed } = this.transformMessages(messages);
    
    let modelToUse = options?.model || this.model;
    let tempToUse: number | undefined = options?.temperature ?? this.temperature;
    let modelFallbackApplied = false;
    let temperatureStripped = false;
    let rateLimitRetries = 0;
    const MAX_RATE_LIMIT_RETRIES = 3;

    const makeRequest = async (model: string, temp: number | undefined): Promise<Response> => {
      const body = this.buildRequestBody(model, system, transformed, temp, options?.maxTokens, false);

      return await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(300000),
      });
    };

    let response: Response;
    while (true) {
      response = await makeRequest(modelToUse, tempToUse);

      if (response.ok) {
        break;
      }

      const errorText = await response.text().catch(() => 'Unknown error');
      let errorObj: any;
      try {
        errorObj = JSON.parse(errorText);
      } catch {}

      const errorMessage = errorObj?.error?.message || errorText;
      const errorType = errorObj?.error?.type;

      // Handle temperature deprecation
      if (response.status === 400 && !temperatureStripped && errorMessage.includes('temperature is deprecated')) {
        console.warn(`Stripping temperature parameter and retrying due to API warning/error: ${errorMessage}`);
        tempToUse = undefined;
        temperatureStripped = true;
        continue;
      }

      // Handle model not found
      if (response.status === 404 && !modelFallbackApplied && (errorType === 'not_found_error' || errorMessage.includes('model:'))) {
        const fallbackModel = this.getFallbackModel(modelToUse);
        if (fallbackModel !== modelToUse) {
          console.warn(`Model ${modelToUse} not found (404), falling back to ${fallbackModel} and retrying...`);
          modelToUse = fallbackModel;
          modelFallbackApplied = true;
          continue;
        }
      }

      // Handle rate limiting / overload. Retry with the server's Retry-After when
      // given; a *missing* Retry-After on a 429 is common for OAuth/subscription
      // rate limits (often short-lived contention with other Claude Code sessions),
      // so still retry with a moderate fixed wait rather than failing immediately.
      // An explicit long Retry-After means further retries won't help — surface it.
      if (response.status === 429 || response.status === 503) {
        const retryAfter = this.parseRetryAfterSeconds(response);
        const longKnownWait = response.status === 429 && retryAfter !== undefined && retryAfter > 20;
        if (!longKnownWait && rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
          rateLimitRetries++;
          await new Promise(res => setTimeout(res, (retryAfter ?? 15) * 1000));
          continue;
        }
        const hint = response.status === 429 ? this.buildRateLimitHint(await this.getAuthMode()) : '';
        throw new Error(`Anthropic API error (${response.status}): ${errorMessage}${hint}`);
      }

      throw new Error(`Anthropic API error (${response.status}): ${errorMessage}`);
    }

    const data = (await response.json()) as any;
    const blocks: any[] = Array.isArray(data.content) ? data.content : [];
    const content = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
    const reasoning = blocks.filter(b => b.type === 'thinking').map(b => b.thinking).join('');
    const usage = data.usage;
    return {
      content,
      reasoning: reasoning || undefined,
      model: data.model || this.model,
      truncated: data.stop_reason === 'max_tokens',
      usage: usage ? {
        promptTokens: usage.input_tokens || 0,
        completionTokens: usage.output_tokens || 0,
        totalTokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
        cacheReadTokens: usage.cache_read_input_tokens || 0,
        cacheWriteTokens: usage.cache_creation_input_tokens || 0,
      } : undefined,
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
    
    let modelToUse = options?.model || this.model;
    let tempToUse: number | undefined = options?.temperature ?? this.temperature;
    let modelFallbackApplied = false;
    let temperatureStripped = false;

    const MAX_RETRIES = 5;
    let lastError: Error | null = null;
    let lastStatus: number | undefined;
    let pendingDelaySec: number | undefined;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (abortSignal?.aborted) { return; }

      if (attempt > 0) {
        const delaySec = pendingDelaySec ?? Math.pow(2, attempt) * 1.5; // server-provided wait, else 3s, 4.5s, 6s
        pendingDelaySec = undefined;
        options?.onRetry?.(attempt, delaySec, lastError?.message || 'Server overloaded');
        await new Promise(res => setTimeout(res, delaySec * 1000));
        if (abortSignal?.aborted) { return; }
      }

      const body = this.buildRequestBody(modelToUse, system, transformed, tempToUse, options?.maxTokens, true);

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
        lastError = new Error(`Anthropic API error (${response.status}): ${errorText}`);
        lastStatus = response.status;
        const retryAfter = this.parseRetryAfterSeconds(response);
        // An explicit long Retry-After means the server told us exactly how long
        // to wait, and it's too long to block the UI for — surface it immediately
        // rather than hammering. A *missing* Retry-After on a 429 is common for
        // OAuth/subscription rate limits (often short-lived contention with other
        // Claude Code sessions on the same account), so still give it a bounded
        // retry with a moderate fixed wait instead of failing on the first try.
        if (response.status === 429 && retryAfter !== undefined && retryAfter > 20) {
          break;
        }
        pendingDelaySec = retryAfter ?? 15;
        continue;
      }

      // Check for structural error 400 (temperature)
      if (response.status === 400 && !temperatureStripped) {
        const errorText = await response.text().catch(() => 'Unknown error');
        let errorObj: any;
        try {
          errorObj = JSON.parse(errorText);
        } catch {}

        const errorMessage = errorObj?.error?.message || errorText;
        if (errorMessage.includes('temperature is deprecated')) {
          console.warn(`Stripping temperature parameter and retrying stream due to API error: ${errorMessage}`);
          tempToUse = undefined;
          temperatureStripped = true;
          attempt--; // Reset attempt so it doesn't count against limit
          continue;
        } else {
          throw new Error(`Anthropic API error (${response.status}): ${errorText}`);
        }
      }

      // Check for structural error 404 (model)
      if (response.status === 404 && !modelFallbackApplied) {
        const errorText = await response.text().catch(() => 'Unknown error');
        let errorObj: any;
        try {
          errorObj = JSON.parse(errorText);
        } catch {}

        const errorMessage = errorObj?.error?.message || errorText;
        const errorType = errorObj?.error?.type;

        if (errorType === 'not_found_error' || errorMessage.includes('model:')) {
          const fallbackModel = this.getFallbackModel(modelToUse);
          if (fallbackModel !== modelToUse) {
            console.warn(`Model ${modelToUse} not found (404), falling back to ${fallbackModel} and retrying stream...`);
            modelToUse = fallbackModel;
            modelFallbackApplied = true;
            attempt--; // Reset attempt so it doesn't count against limit
            continue;
          }
        }
        throw new Error(`Anthropic API error (${response.status}): ${errorText}`);
      }

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new Error(`Anthropic API error (${response.status}): ${errorText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('Response body is not readable');

      const decoder = new TextDecoder();
      let buffer = '';
      let midStreamError: string | null = null;
      // Anthropic sends `message_delta` with `delta.stop_reason` right before
      // the stream closes. 'max_tokens' means the turn was cut off, not that
      // the model finished — without tracking this, a response truncated
      // mid-thinking or mid-prose (no dangling tool-call tag to catch it) is
      // indistinguishable from a complete answer, and the agent loop silently
      // ends the run with a chopped-off reply. See ChatResponse.truncated.
      let stopReason: string | undefined;

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
            try {
              const chunk = JSON.parse(dataStr);
              if (chunk.type === 'error') {
                // Anthropic can send a mid-stream error (e.g. overloaded_error) after
                // already returning 200 OK; without this the stream would otherwise
                // end silently and look like a successful, truncated response.
                midStreamError = chunk.error?.message || JSON.stringify(chunk.error) || 'Unknown stream error';
                break readLoop;
              } else if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
                yield {
                  content: chunk.delta.text || '',
                  model: modelToUse,
                };
              } else if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'thinking_delta') {
                yield {
                  content: '',
                  reasoning: chunk.delta.thinking || '',
                  model: modelToUse,
                };
              } else if (chunk.type === 'message_delta' && chunk.delta?.stop_reason) {
                stopReason = chunk.delta.stop_reason;
              } else if (chunk.type === 'message_start' && chunk.message?.usage) {
                // Surfaces prompt-cache effectiveness for this step: a high
                // cacheReadTokens relative to input_tokens confirms the cache_control
                // breakpoints in buildRequestBody are actually being hit.
                const u = chunk.message.usage;
                if (u.cache_read_input_tokens || u.cache_creation_input_tokens) {
                  console.log(`[Anthropic] cache read=${u.cache_read_input_tokens || 0} write=${u.cache_creation_input_tokens || 0} fresh=${u.input_tokens || 0}`);
                }
              }
            } catch {
              // Skip other stream events
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      if (midStreamError) {
        throw new Error(`Anthropic API stream error: ${midStreamError}`);
      }
      if (stopReason === 'max_tokens') {
        yield { content: '', model: modelToUse, truncated: true };
      }
      return;
    }

    if (lastStatus === 429) {
      const hint = this.buildRateLimitHint(await this.getAuthMode());
      throw new Error(`${lastError?.message || 'Anthropic API error (429): rate limited.'}${hint}`);
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
    return ['claude-sonnet-5', 'claude-opus-4-8', 'claude-haiku-4-5-20251001', 'claude-fable-5'];
  }
}
