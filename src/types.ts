// ─── Provider Types ───────────────────────────────────────────────────────────

/** Role that an LLM model can serve — used for future per-role routing. */
export type ModelRole = 'chat' | 'planning' | 'coding' | 'vision';

/** A single message in a chat conversation. */
export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Options passed to a provider chat call. */
export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
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
  };
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
