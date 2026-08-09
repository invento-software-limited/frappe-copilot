// ─── Provider Types ───────────────────────────────────────────────────────────

/** Role that an LLM model can serve — used for future per-role routing. */
export type ModelRole = 'chat' | 'planning' | 'coding' | 'vision';

/** An image attached to a user message.
 *
 *  Persisted (in messages.jsonl) as a `path` reference only — base64 for even a
 *  modest screenshot is hundreds of KB, and every session read parses that whole
 *  file. `data` is filled in lazily by ChatPanel.hydrateImages() on the in-memory
 *  copy handed to a provider, and is the only field providers read. */
export interface ImageAttachment {
  /** e.g. 'image/png' — the subset Anthropic accepts (png, jpeg, gif, webp). */
  mediaType: string;
  name?: string;
  /** Absolute path under .frappe-copilot/uploads. Set on persisted messages. */
  path?: string;
  /** Raw base64 (no data: prefix). Set only on the provider-bound copy. */
  data?: string;
}

/** A single message in a chat conversation. */
export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** For a system message: length of the leading slice of `content` that is
   *  static per-agent boilerplate (identity, guidelines, tool docs) as opposed
   *  to per-turn dynamic context (RAG snippets, schema directory, skills/MCP
   *  catalogs) appended after it — see ChatPanel.runOneAgentStep. Providers
   *  that support a cacheable-prefix/dynamic-suffix split in their system
   *  prompt (currently only ClaudeAgentSdkProvider, via the SDK's
   *  SYSTEM_PROMPT_DYNAMIC_BOUNDARY) use this to keep the large static part a
   *  stable cache hit across turns even when the dynamic tail changes.
   *  Providers without that capability just ignore it and use `content` whole. */
  staticPrefixLength?: number;
  /** Images attached to a user message, for vision-capable providers. */
  images?: ImageAttachment[];
  /** Set on the summary message a task-specialized agent leaves in the main
   *  transcript — lets the UI show which specialist handled the turn and
   *  fetch its full step-by-step run via `runId` (see SessionStore.readRunTranscript). */
  agentId?: string;
  runId?: string;
  /** Set alongside `runId` when that run has a revertible file checkpoint. */
  hasCheckpoint?: boolean;
  /** Shared across the user message and every assistant run it spawns (one
   *  user message can fan out into several runs via a multi-stage pipeline).
   *  Lets "revert changes from this prompt" aggregate every checkpoint that
   *  prompt produced, not just a single run's. */
  promptId?: string;
}

/** Options passed to a provider chat call. */
export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  /** Identifies the agent run this call belongs to (see ChatPanel.runOneAgentStep).
   *  Every step of one run — and its verification fix-rounds — shares the same
   *  id. Providers that can resume a server-side session (e.g. the Claude Code
   *  SDK) use it to key that state instead of resending the whole growing
   *  transcript on every tool-call round trip. Providers that don't support
   *  session resume can ignore it. */
  runId?: string;
  /** Called when a transient error triggers a retry (attempt = 1-based retry count, delaySec = wait before next attempt). */
  onRetry?: (attempt: number, delaySec: number, error: string) => void;
}

/** Response from a provider chat call (non-streaming). */
export interface ChatResponse {
  content: string;
  reasoning?: string;
  model: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    /** Tokens served from Anthropic's prompt cache (near-free) vs. freshly written to it. */
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  /** Set on the final chunk of a stream (or the one-shot chat() response) when
   *  the provider cut the turn off because it hit its output-token ceiling —
   *  distinct from the model naturally finishing. Without this, a response
   *  truncated mid-thinking or mid-prose (no dangling tool-call tag to detect)
   *  is indistinguishable from a complete answer and the agent loop silently
   *  ends the run with a chopped-off reply. See ChatPanel.runOneAgentStep. */
  truncated?: boolean;
}

/** Provider interface — all LLM providers implement this. */
export interface LLMProvider {
  readonly name: string;
  chat(messages: Message[], options?: ChatOptions): Promise<ChatResponse>;
  chatStream(messages: Message[], options?: ChatOptions): AsyncIterable<ChatResponse>;
  isAvailable(): Promise<boolean>;
}

// ─── Bench Types ──────────────────────────────────────────────────────────────

/** Result of bench environment detection. */
export type BenchEnvironment =
  | { type: 'host'; benchPath: string; benchDir: string }
  | { type: 'docker'; containerId: string; containerName: string; benchDir: string }
  | { type: 'not-found'; message: string };

/** Category of a bench command. */
export type BenchCommandCategory =
  | 'init'
  | 'site'
  | 'app'
  | 'backup'
  | 'config'
  | 'database'
  | 'doctype'
  | 'build'
  | 'test'
  | 'scheduler'
  | 'translation'
  | 'update'
  | 'setup'
  | 'install'
  | 'utility'
  | 'network'
  | 'production';

/** A pre-configured bench command template. */
export interface BenchCommand {
  id: string;
  name: string;
  description: string;
  template: string;
  category: BenchCommandCategory;
  destructive: boolean;
  requiresSite: boolean;
}

/** A resolved bench command ready for execution. */
export interface ResolvedCommand {
  command: BenchCommand;
  resolvedTemplate: string;
  site?: string;
}

// ─── Session Types ────────────────────────────────────────────────────────────

/** A single chat session. */
export interface Session {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

/** Persisted "summarize and replace" compaction state for a session — the raw
 *  messages.jsonl is never touched; this just tells buildEffectiveHistory()
 *  where to cut over from full history to summary + tail. */
export interface CompactionState {
  compactedThroughCount: number;
  summary: string;
  compactedAt: string;
}

/** Before-image of one file touched by an agent run, for revert. */
export interface CheckpointEntry {
  path: string;
  existedBefore: boolean;
  originalContent?: string;
}

// ─── Workspace Config ─────────────────────────────────────────────────────────

/** Stored workspace configuration (inside .frappe-copilot/config.json). */
export interface WorkspaceConfig {
  bench: BenchEnvironment | null;
  defaultSite: string;
  opencodeZen: {
    endpoint: string;
    model: string;
    temperature: number;
  };
  version: string;
}

// ─── File Intake Types ───────────────────────────────────────────────────────

/** Supported intake file types. */
export type IntakeFileType = 'pdf' | 'html';

/** A file uploaded for analysis. */
export interface IntakeFile {
  name: string;
  type: IntakeFileType;
  size: number;
  content: string;       // extracted text
  originalPath: string;
}

/** Result from one chunk reader agent. */
export interface ChunkAnalysis {
  chunkIndex: number;
  summary: string;
  keyPoints: string[];
  frappeRelevant: string[];
}

/** Final merged understanding from all chunks. */
export interface MergedUnderstanding {
  overallSummary: string;
  requirements: string[];
  frappeDocTypes: string[];
  frappeModules: string[];
  uiComponents: string[];
  dataModels: string[];
  unknowns: string[];
}

// ─── Agent Graph Types ───────────────────────────────────────────────────────

export type GraphNodeType = 'input' | 'splitter' | 'chunk' | 'reader' | 'merger' | 'output';
export type GraphNodeStatus = 'pending' | 'running' | 'completed' | 'failed';
export type GraphState = 'idle' | 'running' | 'completed' | 'failed';

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  label: string;
  description: string;
  status: GraphNodeStatus;
  progress?: number;      // 0-100
  result?: string;
  details?: string;
  agentRunId?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  label?: string;
}

export interface AgentGraph {
  id: string;
  name: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  createdAt: string;
  updatedAt: string;
  currentState: GraphState;
}
