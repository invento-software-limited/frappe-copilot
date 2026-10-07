import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChatOptions, ChatResponse, Message } from '../../types';
import { LLMProvider } from '../../providers/interface';
import { SessionManager } from '../../session/manager';
import { ToolExecutor } from '../../agents/toolExecutor';
import { ChatUi } from '../../chat/chatUi';
import { ApprovalGate } from '../../chat/approvals';
import { ModelSettings } from '../../chat/modelSettings';
import { ProjectContext } from '../../chat/projectContext';
import { SessionTodos } from '../../chat/sessionTodos';
import { CompactionController } from '../../chat/compactionController';
import { AgentRuntime } from '../../chat/runtime/agentRuntime';
import { RunControl } from '../../chat/runtime/runControl';
import { resetStub, setWorkspace } from './vscodeStub';

/** One scripted model reply: chunks to stream, or an error to throw. */
export type ScriptedReply = { chunks: Partial<ChatResponse>[] } | { error: string };

/** Replays scripted replies in order and records every request it got. */
export class FakeProvider implements LLMProvider {
  readonly name = 'fake';
  readonly requests: { messages: Message[]; options?: ChatOptions }[] = [];

  constructor(private replies: ScriptedReply[], private native = true) {}

  async chat(): Promise<ChatResponse> {
    return { content: 'summary', model: 'fake-model' };
  }

  async *chatStream(messages: Message[], options?: ChatOptions): AsyncIterable<ChatResponse> {
    this.requests.push({ messages, options });
    const reply = this.replies.shift();
    if (!reply) throw new Error('FakeProvider: no scripted reply left');
    if ('error' in reply) throw new Error(reply.error);
    for (const c of reply.chunks) yield { content: '', model: 'fake-model', ...c };
  }

  async isAvailable(): Promise<boolean> { return true; }
  getModelId(): string { return 'fake-model'; }
  supportsNativeTools(): boolean { return this.native; }
  async hasApiKey(): Promise<boolean> { return true; }
}

/** A text-only reply. */
export const say = (text: string): ScriptedReply => ({ chunks: [{ content: text }] });

/** A reply that calls one native tool. */
export const callTool = (name: string, input: Record<string, any>, id = `call-${name}`): ScriptedReply =>
  ({ chunks: [{ content: '', toolCalls: [{ id, name, input }] }] });

/** Collects every event the runtime posts to the chat. */
export class RecordingTarget {
  readonly events: any[] = [];
  postMessage(m: any): boolean { this.events.push(m); return true; }
  ofType(type: string): any[] { return this.events.filter(e => e.type === type); }
}

export interface Harness {
  root: string;
  runtime: AgentRuntime;
  sessions: SessionManager;
  ui: RecordingTarget;
  approvals: ApprovalGate;
  control: RunControl;
  provider: FakeProvider;
  cleanup(): void;
}

/** A full agent runtime over a temp workspace, with a scripted model. */
export function buildHarness(replies: ScriptedReply[], opts: { native?: boolean } = {}): Harness {
  resetStub();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-test-'));
  // Session data lives outside the workspace, so the workspace has no
  // .frappe-copilot folder and no knowledge base indexes in the background.
  const root = path.join(base, 'workspace');
  const dataDir = path.join(base, 'data');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  setWorkspace(root);

  const target = new RecordingTarget();
  const ui = new ChatUi(() => [target]);
  const provider = new FakeProvider(replies, opts.native ?? true);
  const sessions = new SessionManager(dataDir);
  const tools = new ToolExecutor(root, null);
  const project = new ProjectContext(root, provider);
  const models = new ModelSettings(provider, ui);
  const approvals = new ApprovalGate(ui);
  const control = new RunControl();
  control.sleep = async () => undefined;
  const runtime = new AgentRuntime({
    ui, provider, sessions, tools, project, approvals, models,
    todos: new SessionTodos(ui), control,
    compaction: new CompactionController(ui, sessions, provider, models),
    mcp: null, benchEnv: () => null,
  });
  return {
    root, runtime, sessions, ui: target, approvals, control, provider,
    cleanup: () => {
      project.disposeWatchers();
      setWorkspace(null);
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

/** Resolves once `check` passes — for waiting on a run that's parked. */
export async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
    await new Promise(r => setTimeout(r, 5));
  }
}
