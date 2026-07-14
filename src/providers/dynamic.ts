import * as vscode from 'vscode';
import { Message, ChatOptions, ChatResponse } from '../types';
import { LLMProvider } from './interface';
import { OpenCodeZenProvider } from './opencode-zen';
import { OpenAIProvider } from './openai';
import { AnthropicProvider } from './anthropic';
import { ClaudeAgentSdkProvider } from './claudeAgentSdk';

export class DynamicProvider implements LLMProvider {
  private activeProvider!: LLMProvider;
  private secrets: vscode.SecretStorage;
  private providers: Record<string, LLMProvider> = {};

  constructor(secrets: vscode.SecretStorage) {
    this.secrets = secrets;
    this.providers['opencode-zen'] = new OpenCodeZenProvider(secrets);
    this.providers['openai'] = new OpenAIProvider(secrets);
    this.providers['anthropic'] = new AnthropicProvider(secrets);
    this.providers['claude-code'] = new ClaudeAgentSdkProvider();
    this.refreshConfig();
  }

  get name(): string {
    return this.activeProvider.name;
  }

  refreshConfig(): void {
    const config = vscode.workspace.getConfiguration('frappe-copilot');
    const providerId = config.get<string>('provider', 'opencode-zen');
    this.activeProvider = this.providers[providerId] || this.providers['opencode-zen'];
    this.activeProvider.refreshConfig?.();
  }

  async hasApiKey(): Promise<boolean> {
    return (this.activeProvider as any).hasApiKey();
  }

  async setApiKey(key: string): Promise<void> {
    return (this.activeProvider as any).setApiKey(key);
  }

  async clearApiKey(): Promise<void> {
    return (this.activeProvider as any).clearApiKey();
  }

  async getAuthMode(): Promise<'api-key' | 'oauth' | 'none'> {
    return (await this.activeProvider.getAuthMode?.()) ?? 'none';
  }

  chat(messages: Message[], options?: ChatOptions): Promise<ChatResponse> {
    return this.activeProvider.chat(messages, options);
  }

  chatStream(messages: Message[], options?: ChatOptions, abortSignal?: AbortSignal): AsyncIterable<ChatResponse> {
    return this.activeProvider.chatStream(messages, options, abortSignal);
  }

  isAvailable(): Promise<boolean> {
    return this.activeProvider.isAvailable();
  }

  getEmbeddings(text: string): Promise<number[]> {
    if (!this.activeProvider.getEmbeddings) {
      return Promise.reject(new Error(`${this.activeProvider.name} does not support embeddings.`));
    }
    return this.activeProvider.getEmbeddings(text);
  }

  async getModels(): Promise<string[]> {
    if (this.activeProvider.getModels) {
      return this.activeProvider.getModels();
    }
    return [];
  }
}
