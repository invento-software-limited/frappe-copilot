import { Message, ChatOptions, ChatResponse } from '../types';

/** Unified LLM provider interface.
 *  Every provider (OpenCode Zen, OpenAI, Anthropic, etc.) implements this. */
export interface LLMProvider {
  /** Human-readable provider name. */
  readonly name: string;

  /** Send messages and get a complete response. */
  chat(messages: Message[], options?: ChatOptions): Promise<ChatResponse>;

  /** Stream a response chunk by chunk. */
  chatStream(messages: Message[], options?: ChatOptions, abortSignal?: AbortSignal): AsyncIterable<ChatResponse>;

  /** Check if the provider is reachable and configured. */
  isAvailable(): Promise<boolean>;

  /** Optional: Generate vector embeddings for a given input text. */
  getEmbeddings?(text: string): Promise<number[]>;

  /** Optional: Fetch list of available model names dynamically from the API. */
  getModels?(): Promise<string[]>;

  /** Optional: Reload provider configuration from workspace settings. */
  refreshConfig?(): void;

  /** Optional: the model id requests go to by default — used to size the context window. */
  getModelId?(): string;

  /** Optional: true when the provider clears old tool results server-side,
   *  so the caller must not trim history itself. */
  managesContextServerSide?(): boolean;

  /** Optional: true when chatStream honors ChatOptions.tools and yields
   *  structured toolCalls. Providers without it get the XML tool protocol. */
  supportsNativeTools?(): boolean;

  /** Optional: Report which credential type is active — lets the UI show
   *  whether requests are billed against an API key or a Claude.ai subscription. */
  getAuthMode?(): Promise<'api-key' | 'oauth' | 'none'>;
}
