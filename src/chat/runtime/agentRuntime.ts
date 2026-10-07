import { BenchEnvironment } from '../../types';
import { LLMProvider } from '../../providers/interface';
import { SessionManager } from '../../session/manager';
import { ToolExecutor } from '../../agents/toolExecutor';
import { MCPManager } from '../../mcp/manager';
import { ReviewController } from '../../review/reviewController';
import { ChatUi } from '../chatUi';
import { ApprovalGate } from '../approvals';
import { ModelSettings } from '../modelSettings';
import { ProjectContext } from '../projectContext';
import { SessionTodos } from '../sessionTodos';
import { CompactionController } from '../compactionController';
import { RunControl } from './runControl';
import { RunSkills } from './runSkills';
import { RunGraph } from './runGraph';
import { RunBudget } from './runBudget';
import { LlmStreamer } from './llmStream';
import { PromptBuilder } from './promptBuilder';
import { ToolCallRunner } from './toolCallRunner';
import { AgentStepper } from './agentStep';
import { AgentLoop } from './agentLoop';
import { VerificationPhase } from './verificationPhase';
import { SubagentRunner } from './subagentRunner';
import { PipelineRunner } from './pipeline';
import { Orchestrator } from './orchestrator';

/** Everything the agent runtime reads from or acts on outside itself. */
export interface RuntimeDeps {
  ui: ChatUi;
  provider: LLMProvider;
  sessions: SessionManager;
  tools: ToolExecutor;
  project: ProjectContext;
  approvals: ApprovalGate;
  models: ModelSettings;
  todos: SessionTodos;
  control: RunControl;
  compaction: CompactionController;
  mcp: MCPManager | null;
  benchEnv: () => BenchEnvironment | null;
  /** Accept/reject review of the agent's file edits; null when unavailable. */
  review?: ReviewController | null;
}

/** Wires the pieces of an agent run together. Each piece reaches the others
 *  through this object, so the step ↔ tool ↔ sub-agent cycle needs no
 *  constructor juggling. */
export class AgentRuntime {
  readonly skills: RunSkills;
  readonly graph: RunGraph;
  readonly budget: RunBudget;
  readonly streamer = new LlmStreamer(this);
  readonly prompts = new PromptBuilder(this);
  readonly toolCalls = new ToolCallRunner(this);
  readonly steps = new AgentStepper(this);
  readonly loop = new AgentLoop(this);
  readonly verification = new VerificationPhase(this);
  readonly subagents = new SubagentRunner(this);
  readonly pipeline = new PipelineRunner(this);
  readonly orchestrator = new Orchestrator(this);

  constructor(readonly deps: RuntimeDeps) {
    this.skills = new RunSkills(deps.project.skillRouter, deps.project.skillsStore, deps.ui);
    this.graph = new RunGraph(deps.project.graphStore, deps.ui);
    this.budget = new RunBudget(deps.ui);
  }
}
