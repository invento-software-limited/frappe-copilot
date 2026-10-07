import { GraphStore } from '../../agents/graphStore';
import { AgentDefinition } from '../../agents/types';
import { ChatUi } from '../chatUi';
import { PendingToolCall, RunOptions } from './types';

/** The workflow graph panel: a node per agent run and per tool call. Every
 *  method is a no-op when the workspace has no graph store. */
export class RunGraph {
  constructor(private store: GraphStore | null, private ui: ChatUi) {}

  startRun(runId: string, agent: AgentDefinition, opts: RunOptions): void {
    if (!this.store) return;
    if (opts.resetGraph !== false) this.store.init('Workflow Executor');
    this.store.addNode({
      id: runId,
      type: 'reader',
      label: `${opts.graphLabelPrefix ? opts.graphLabelPrefix + ' ' : ''}${agent.icon} ${agent.label}`,
      description: agent.description,
      status: 'running',
      progress: 30,
      agentRunId: runId,
    });
    if (opts.precedingRunId) this.store.addEdge(opts.precedingRunId, runId, 'next stage');
    this.publish();
  }

  finishRun(runId: string, verificationFailed: boolean): void {
    if (!this.store) return;
    this.store.updateNode(runId, {
      status: verificationFailed ? 'failed' : 'completed',
      progress: 100,
      details: verificationFailed ? 'Verification failed' : undefined,
    });
    this.store.get().currentState = 'completed';
    this.publish();
  }

  startSubagent(runId: string, parentRunId: string, agent: AgentDefinition, description: string): void {
    this.store?.addNode({ id: runId, type: 'reader', label: `${agent.icon} ${description}`, description: agent.label, status: 'running', progress: 30, agentRunId: runId });
    this.store?.addEdge(parentRunId, runId, 'task');
  }

  addTool(nodeId: string, runId: string, tool: PendingToolCall): void {
    if (!this.store) return;
    this.store.addNode({
      id: nodeId,
      type: 'chunk',
      label: tool.name,
      description: `Args: ${Object.keys(tool.args).join(', ')}`,
      status: 'running',
      progress: 50,
      agentRunId: runId,
    });
    this.store.addEdge(runId, nodeId);
    this.publish();
  }

  finishNode(nodeId: string, success: boolean, details?: string): void {
    if (!this.store) return;
    this.store.updateNode(nodeId, { status: success ? 'completed' : 'failed', progress: 100, details });
    this.publish();
  }

  private publish(): void {
    this.ui.say('graphUpdated', this.store!.get());
  }
}
