import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { diffLines } from 'diff';
import { ToolName } from '../../agents/types';
import { isAutoApprove } from '../../agents/approvalMode';
import { classifyTouchedFile } from '../../agents/verification';
import { captureBeforeImage, readFileCapped } from '../checkpoints';
import type { AgentRuntime } from './agentRuntime';
import { PendingToolCall, RunScope, ToolOutcome } from './types';

export const FILE_WRITE_TOOLS: ReadonlySet<string> = new Set(['write_file', 'edit_file', 'multi_edit']);

/** Runs one tool call end to end: allowlist gate, approval, checkpointing,
 *  execution, post-write syntax check, and graph/UI updates. Safe to run
 *  concurrently for read-only tools — those never prompt or checkpoint. */
export class ToolCallRunner {
  constructor(private rt: AgentRuntime) {}

  async run(scope: RunScope, tool: PendingToolCall, stepLabel: string): Promise<ToolOutcome> {
    const { ui, control, approvals } = this.rt.deps;
    const { agent } = scope;
    const event = (type: string, payload: Record<string, any> = {}) => ui.say(type, { tool: tool.name, callId: tool.callId, ...payload });
    event('toolCallStarted', { args: tool.args });

    const nodeId = `tool-${stepLabel}-${tool.callId}-${tool.name}`;
    this.rt.graph.addTool(nodeId, scope.runId, tool);
    const finish = (success: boolean, output: string, details?: string, extra: Pick<ToolOutcome, 'images' | 'subRunId'> = {}): ToolOutcome => {
      this.rt.graph.finishNode(nodeId, success, details);
      event('toolFinished', { success, output, ...(extra.images?.length ? { imageCount: extra.images.length } : {}) });
      const outcome: ToolOutcome = { success, output };
      if (extra.images?.length) outcome.images = extra.images;
      if (extra.subRunId) outcome.subRunId = extra.subRunId;
      return outcome;
    };

    if (control.aborted) return finish(false, 'Cancelled by the user before this tool ran.', 'Cancelled.');
    if (!agent.allowedTools.includes(tool.name as ToolName)) {
      // Hard allowlist gate — covers control-flow tools too, not just ToolExecutor ones.
      return finish(false, `Tool '${tool.name}' is not permitted for the ${agent.label} agent. Available tools: ${agent.allowedTools.join(', ')}`, "Not in this agent's tool allowlist.");
    }
    if (agent.highRiskTools.includes(tool.name as ToolName) && !isAutoApprove() && !approvals.isAlwaysAllowed(tool.name)) {
      event('toolApprovalRequired', { args: tool.args, ...approvalDiff(tool, scope.root) });
      if (!(await approvals.waitForTool())) return finish(false, 'Tool execution rejected by the user.', 'Rejected by user.');
    }

    const answered = await this.runControlTool(tool);
    if (answered) return finish(answered.success, answered.output);

    event('toolExecuting');
    const filePath = typeof tool.args.path === 'string' ? tool.args.path : '';
    const writesFile = FILE_WRITE_TOOLS.has(tool.name) && !!filePath;
    if (writesFile) this.recordBeforeImage(scope, filePath);

    const result = await this.dispatch(scope, tool, chunk => event('toolOutputChunk', { chunk }));
    result.output += this.rt.skills.afterToolCall(tool.name, tool.args, result.success);
    if (agent.allowedTools.includes('update_todo_list')) {
      result.output += this.rt.deps.todos.tracker.afterToolCall(tool.name) || '';
    }

    if (writesFile) this.rt.deps.review?.refresh();
    if (!(result.success && writesFile)) return finish(result.success, result.output, undefined, result);
    const absPath = path.resolve(scope.root, filePath);
    scope.touchedFiles.push(classifyTouchedFile(filePath, absPath));
    const lintError = await this.syntaxCheck(absPath);
    if (!lintError) return finish(true, result.output);
    ui.chat('error', `⚠️ Linter warning on ${filePath}: compilation check failed.`);
    return finish(false, `${result.output}\n\n[LINTER WARNING] File compiled with error:\n${lintError}`, 'Compilation validation failed.');
  }

  /** Snapshots the file for revert and for accept/reject review. */
  private recordBeforeImage(scope: RunScope, filePath: string): void {
    const before = captureBeforeImage(scope.root, filePath);
    scope.checkpoint.push(before);
    if (reviewEnabled()) this.rt.deps.review?.track(filePath, before.existedBefore ? before.originalContent : null);
  }

  /** Tools the chat itself answers (the task list, a question to the user). */
  private async runControlTool(tool: PendingToolCall): Promise<ToolOutcome | null> {
    const { todos, approvals } = this.rt.deps;
    if (tool.name === 'update_todo_list') {
      const res = todos.tracker.update(tool.args);
      todos.send();
      return { success: res.ok, output: res.output };
    }
    if (tool.name === 'ask_clarification') {
      const answers = await approvals.ask(String(tool.args.questions || tool.args.question || ''));
      return { success: true, output: answers };
    }
    return null;
  }

  private async dispatch(scope: RunScope, tool: PendingToolCall, onChunk: (chunk: string) => void): Promise<ToolOutcome> {
    const { project, tools } = this.rt.deps;
    if (project.contextTools.handles(tool.name)) return project.contextTools.run(tool.name, tool.args);
    if (tool.name === 'task') return this.rt.subagents.run(scope, tool.args);
    // Stream execute_command's output live into its tool card.
    const streamOutput = tool.name === 'execute_command' ? onChunk : undefined;
    return tools.runTool(tool.name, tool.args, scope.agent.allowedTools, streamOutput);
  }

  /** Quick compile check after a write — returns the error text, or null. */
  private async syntaxCheck(absPath: string): Promise<string | null> {
    const ext = path.extname(absPath);
    if (ext !== '.py' && ext !== '.js') return null;
    const cmd = ext === '.py' ? `python -m py_compile "${absPath}"` : `node -c "${absPath}"`;
    const res = await this.rt.deps.tools.executeCommand(cmd);
    return res.success ? null : res.output;
  }
}

/** Diff preview for the approval card. */
export function approvalDiff(tool: PendingToolCall, root: string): { fileExisted?: boolean; diffHunks?: any[] } {
  const a = tool.args;
  if (tool.name === 'write_file' && typeof a.path === 'string') {
    const absPath = path.resolve(root, a.path);
    const fileExisted = fs.existsSync(absPath);
    const oldContent = fileExisted ? (readFileCapped(absPath) ?? '') : '';
    return { fileExisted, diffHunks: diffLines(oldContent, String(a.content || '')) };
  }
  if (tool.name === 'edit_file') {
    return { fileExisted: true, diffHunks: diffLines(String(a.search ?? ''), String(a.replace ?? '')) };
  }
  if (tool.name === 'multi_edit') {
    let edits: any[] = [];
    try { edits = typeof a.edits === 'string' ? JSON.parse(a.edits) : (a.edits || []); } catch { /* shown without a diff */ }
    if (!Array.isArray(edits)) return {};
    return { fileExisted: true, diffHunks: edits.flatMap((e: any) => diffLines(String(e.search ?? ''), String(e.replace ?? ''))) };
  }
  return {};
}

/** Whether agent edits go through accept/reject review (on by default). */
function reviewEnabled(): boolean {
  return vscode.workspace.getConfiguration('frappe-copilot').get<boolean>('reviewChanges', true);
}
