import { ChatResponse, CheckpointEntry, ImageAttachment, Message, Session, ThinkingBlock, ToolCall } from '../../types';
import { AgentDefinition } from '../../agents/types';
import { TouchedFile, VerificationOutcome } from '../../agents/verification';

/** A tool call from either protocol, normalized for execution. */
export interface PendingToolCall {
  callId: string;
  name: string;
  args: Record<string, any>;
}

export interface StreamResult {
  content: string;
  reasoning: string;
  truncated: boolean;
  toolCalls?: ToolCall[];
  thinkingBlocks?: ThinkingBlock[];
  usage?: ChatResponse['usage'];
}

export interface StepResult {
  done: boolean;
  assistantText: string;
  /** The outer loop should stop even though `done` is false (abort/stream error). */
  stopLoop: boolean;
}

export interface ToolOutcome {
  success: boolean;
  output: string;
  /** Images for the model to look at, sent with the tool results. */
  images?: ImageAttachment[];
  /** Set by a `task` call: the sub-agent run that produced the result. */
  subRunId?: string;
}

/** Consecutive-failure counters, reset whenever a step makes progress. */
export interface LoopState {
  malformedCount: number;
  streamErrorCount: number;
  truncatedCount: number;
  emptyCount: number;
}

export function newLoopState(): LoopState {
  return { malformedCount: 0, streamErrorCount: 0, truncatedCount: 0, emptyCount: 0 };
}

/** Everything one agent run carries between its steps. */
export interface RunScope {
  agent: AgentDefinition;
  session: Session;
  userMessage: string;
  runId: string;
  root: string;
  /** Saved conversation before this run — fixed for the run's duration. */
  baseHistory: Message[];
  /** This run's own transcript, never written turn-by-turn into messages.jsonl. */
  localHistory: Message[];
  touchedFiles: TouchedFile[];
  checkpoint: CheckpointEntry[];
  loopState: LoopState;
}

export interface RunOptions {
  /** Run bench migrate/tests after this agent finishes, self-correcting on failure. */
  verify?: boolean;
  /** Wipe the workflow graph first — false when chained as a pipeline stage. */
  resetGraph?: boolean;
  /** Edge this run's graph node from a prior stage's run, when chained. */
  precedingRunId?: string;
  /** Prefix for this run's graph node label, e.g. "Stage 2/3:". */
  graphLabelPrefix?: string;
  /** Shared id for the user prompt this run was spawned from — see Message.promptId. */
  promptId?: string;
}

export interface RunOutcome {
  runId: string;
  done: boolean;
  verification: VerificationOutcome | null;
}
