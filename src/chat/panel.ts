import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { LLMProvider } from '../providers/interface';
import { SessionManager } from '../session/manager';
import { BenchEnvironment, Session } from '../types';
import { ToolExecutor } from '../agents/toolExecutor';
import { MCPManager } from '../mcp/manager';
import { ChatUi } from './chatUi';
import { ApprovalGate, ANSWER_MESSAGES } from './approvals';
import { ModelSettings } from './modelSettings';
import { ProjectContext, frappeCopilotPath, workspaceRoot } from './projectContext';
import { SessionTodos } from './sessionTodos';
import { CompactionController } from './compactionController';
import { SettingsController } from './settingsController';
import { RevertController } from './revertController';
import { prepareAttachment } from './attachments';
import { openFileLink, saveDownload } from './workspaceActions';
import { buildRunSteps } from './runSteps';
import { AgentRuntime } from './runtime/agentRuntime';
import { RunControl } from './runtime/runControl';
import { ReviewController } from '../review/reviewController';
import { handleReviewMessage } from '../review/reviewEditor';

/** The chat webview — in the Secondary Side Bar and/or an editor tab. It
 *  renders sessions and routes webview messages; the agent run itself lives
 *  in ./runtime. */
export class ChatPanel implements vscode.WebviewViewProvider {
  public static readonly viewType = 'frappeCopilot.chat';
  public static readonly sideViewType = 'frappe-copilot.agentChat';

  private panel: vscode.WebviewPanel | null = null;
  private webviewView: vscode.WebviewView | null = null;
  private disposables: vscode.Disposable[] = [];
  private readonly ui = new ChatUi(() => [this.panel?.webview, this.webviewView?.webview]);
  private readonly project: ProjectContext;
  private readonly toolExecutor: ToolExecutor;
  private readonly models: ModelSettings;
  private readonly approvals: ApprovalGate;
  private readonly todos: SessionTodos;
  private readonly control = new RunControl();
  private readonly compaction: CompactionController;
  private readonly settings: SettingsController;
  private readonly reverts: RevertController;
  private readonly runtime: AgentRuntime;

  constructor(
    private readonly extensionPath: string,
    private provider: LLMProvider,
    private sessionManager: SessionManager,
    private benchEnv: BenchEnvironment | null,
    // Shared singleton from extension.ts — each MCP connection is a real
    // child process/socket, so there must only ever be one manager.
    mcpManager: MCPManager | null = null,
    private review: ReviewController | null = null
  ) {
    this.project = new ProjectContext(extensionPath, provider);
    this.toolExecutor = new ToolExecutor(workspaceRoot(), benchEnv, this.project.skillsStore, mcpManager);
    void this.project.attach(this.toolExecutor);
    this.models = new ModelSettings(provider, this.ui);
    this.approvals = new ApprovalGate(this.ui);
    this.todos = new SessionTodos(this.ui);
    this.compaction = new CompactionController(this.ui, sessionManager, provider, this.models);
    this.settings = new SettingsController(provider, this.ui, this.models);
    this.reverts = new RevertController(this.ui, sessionManager);
    this.runtime = new AgentRuntime({
      ui: this.ui, provider, sessions: sessionManager, tools: this.toolExecutor, project: this.project,
      approvals: this.approvals, models: this.models, todos: this.todos, control: this.control,
      compaction: this.compaction, mcp: mcpManager, benchEnv: () => this.benchEnv, review,
    });
    review?.onDidChange(() => this.sendReviewState());
  }

  /** Called by VS Code when resolving the WebviewView in the Secondary Side Bar */
  resolveWebviewView(webviewView: vscode.WebviewView, _context: vscode.WebviewViewResolveContext, _token: vscode.CancellationToken): void {
    this.webviewView = webviewView;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.file(this.extensionPath)] };
    webviewView.webview.html = this.getWebviewContent();
    webviewView.onDidDispose(() => { this.webviewView = null; }, null, this.disposables);
    webviewView.webview.onDidReceiveMessage(m => this.handleMsg(m), null, this.disposables);
  }

  /** Reveals or opens the chat. By default focuses the Secondary Side Bar view. */
  show(inTab: boolean = false): void {
    if (inTab) {
      this.showInTab();
    } else if (this.webviewView) {
      this.webviewView.show(false);
    } else {
      vscode.commands.executeCommand('frappe-copilot.agentChat.focus');
    }
  }

  /** Explicitly opens/reveals the chat as an editor tab (ViewColumn.Two) */
  showInTab(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Two, false);
      return;
    }
    this.panel = vscode.window.createWebviewPanel(ChatPanel.viewType, 'Frappe Copilot', vscode.ViewColumn.Two, { enableScripts: true, retainContextWhenHidden: true });
    this.panel.iconPath = vscode.Uri.file(path.join(this.extensionPath, 'assets', 'icon.svg'));
    this.panel.webview.html = this.getWebviewContent();
    this.panel.onDidDispose(() => { this.panel = null; }, null, this.disposables);
    this.panel.webview.onDidReceiveMessage(m => this.handleMsg(m), null, this.disposables);
  }

  /** Brings the chat into view where it already is — the visible side bar,
   *  else its editor tab, else the side bar — without closing anything. */
  reveal(): void {
    if (this.webviewView?.visible) return;
    if (this.panel) {
      this.panel.reveal(this.panel.viewColumn, true);
    } else if (this.webviewView) {
      this.webviewView.show(true);
    } else {
      void vscode.commands.executeCommand('frappe-copilot.agentChat.focus');
    }
  }

  /** Whether the Secondary Side Bar agent view is currently visible */
  isViewVisible(): boolean {
    return !!this.webviewView?.visible;
  }

  close(): void {
    this.panel?.dispose();
    this.panel = null;
  }

  insertCodeMention(mention: any): void {
    this.ui.say('insertCodeMention', { mention });
  }

  /** Renders a session: saved messages with each run's steps inline, plus —
   *  when a run is still going — the live events so far, replayed. */
  loadSession(session: Session): void {
    this.ui.showingSession(session.id);
    this.todos.bind(session);
    const messages = this.sessionManager.readMessages(session.id);
    // Prompts whose runs left a checkpoint get a "revert this prompt" link.
    const revertable = new Set(messages.filter(m => m.hasCheckpoint && m.promptId).map(m => m.promptId));
    const live = this.ui.liveRun.snapshotFor(session.id);
    const visible = live ? messages.slice(0, live.historyCount) : messages;
    const enriched = visible.map(m => {
      if (m.role === 'user' && m.promptId && revertable.has(m.promptId)) return { ...m, promptHasCheckpoint: true };
      if (m.role === 'assistant' && m.runId) {
        const read = (runId: string) => this.sessionManager.readRunTranscript(session.id, runId);
        return { ...m, steps: buildRunSteps(read(m.runId), m.content, read) };
      }
      return m;
    });
    this.ui.say('loadSession', {
      sessionName: session.name,
      messages: enriched,
      ...(live ? { live: { startedAt: live.startedAt, events: live.events } } : {}),
    });
    // A run in another session keeps the send button busy here too.
    if (this.ui.runningElsewhere()) this.ui.say('agentState', { state: 'running' });
    this.compaction.reportSessionSize(session);
  }

  setBenchEnv(env: BenchEnvironment | null): void {
    this.benchEnv = env;
    this.ui.say('benchStatus', env?.type || 'unknown');
    this.toolExecutor.setBenchEnv(env);
  }

  /** Pushes the skills catalog to the webview's "/" picker. */
  notifySkillsChanged(): void {
    const store = this.project.skillsStore;
    if (store) this.ui.say('skillsList', { skills: store.listSkills() });
  }

  /** Announces a newly created/imported skill in the chat transcript. */
  notifySkillCreated(id: string): void {
    const meta = this.project.skillsStore?.listSkills().find(s => s.id === id);
    this.notifySkillsChanged();
    this.ui.say('skillEvent', { kind: 'created', id, name: meta?.name || id, description: meta?.description || '' });
  }

  dispose(): void {
    this.panel = null;
    this.webviewView = null;
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
  }

  /** Kills commands the agent started with run_in_background, and its browser. */
  disposeBackgroundCommands(): void {
    this.toolExecutor.background.disposeAll();
    this.toolExecutor.browser.dispose().catch(() => { /* best-effort on shutdown */ });
  }

  /** Not part of dispose() — that fires when only the webview closes, while
   *  this object (and its knowledge base) lives on for the next show(). */
  disposeVectorStoreWatchers(): void {
    this.project.disposeWatchers();
  }

  private async handleMsg(msg: any): Promise<void> {
    if (ANSWER_MESSAGES.has(msg.type)) this.ui.liveRun.settleInteractive();
    if (this.approvals.answer(msg)) return;
    if (await this.settings.handle(msg)) return;
    if (await this.reverts.handle(msg)) return;
    if (this.review && await handleReviewMessage(this.review, msg)) return;
    switch (msg.type) {
      case 'ready': return this.onReady();
      case 'sendMessage': return this.send(msg.text, msg.skills);
      case 'sendWithFile': return this.sendWithFile(msg);
      case 'abort': return this.abort();
      case 'openFile': return openFileLink(msg.uri);
      case 'saveFile': return saveDownload(msg);
      case 'newSession':
        this.approvals.clearAlwaysAllowed();
        void vscode.commands.executeCommand('frappe-copilot.newSession');
        return;
      case 'openHistory':
        void vscode.commands.executeCommand('frappe-copilot.sessions.focus');
        return;
      case 'runSlashCommand': return this.runSlashCommand(msg.command);
      case 'setEffort': return this.models.setEffort(msg.effort);
      case 'clearTodos': return this.todos.clear();
      case 'refreshModels': return this.models.sendModels(true);
      case 'selectModel': return this.models.select(msg.model);
    }
  }

  private async onReady(): Promise<void> {
    this.ui.say('status', await this.settings.hasApiKey() ? 'ready' : 'no-key');
    this.ui.say('benchStatus', this.benchEnv?.type || 'unknown');
    await this.models.sendModels(false);
    if (this.sessionManager.activeSession) this.loadSession(this.sessionManager.activeSession);
    this.todos.send();
    this.notifySkillsChanged();
    this.sendReviewState();
  }

  /** The review bar: files with agent changes not yet accepted or rejected. */
  private sendReviewState(): void {
    this.ui.say('reviewState', { files: this.review?.pending() ?? [] });
  }

  /** Checks the run can start; reports why not otherwise. */
  private async canStartRun(): Promise<boolean> {
    if (!(await this.settings.hasApiKey())) {
      this.ui.chat('assistant', this.settings.noAuthMessage());
      return false;
    }
    if (this.control.running) {
      this.ui.chat('system', '⏳ Another request is currently executing. Please wait.');
      return false;
    }
    return true;
  }

  private async send(text: string, skills: unknown): Promise<void> {
    if (await this.canStartRun()) await this.runtime.orchestrator.run(text, undefined, skills);
  }

  private async sendWithFile(msg: any): Promise<void> {
    if (!(await this.canStartRun())) return;
    const fp = frappeCopilotPath();
    if (!fp) {
      this.ui.chat('error', 'No workspace open.');
      return;
    }
    const prepared = await prepareAttachment(msg, path.join(fp, 'uploads'), this.provider, this.models.selectedModel || undefined, this.ui);
    if (prepared) await this.runtime.orchestrator.run(prepared.message, prepared.images, msg.skills);
  }

  private abort(): void {
    this.control.abort();
    // A run parked on an approval or question would otherwise wait forever.
    this.approvals.cancelAll();
    this.toolExecutor.killRunningCommands();
  }


  private async runSlashCommand(command: string): Promise<void> {
    if (command === 'compact') {
      const session = this.sessionManager.activeSession;
      if (session) await this.compaction.compact(session);
    } else if (command === 'skills') {
      try { await vscode.commands.executeCommand('frappe-copilot.skills.focus'); } catch { /* view not registered yet */ }
    }
  }

  private getWebviewContent(): string {
    const p = path.join(this.extensionPath, 'assets', 'webview', 'chat.html');
    try {
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8');
    } catch (e) {
      console.error('Failed to read chat.html:', e);
    }
    return '<!DOCTYPE html><html><body><h1>Frappe Copilot</h1></body></html>';
  }
}
