import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { LLMProvider } from '../providers/interface';
import { runClaudeOAuthFlow } from '../providers/anthropicOAuth';
import { SessionManager } from '../session/manager';
import { BenchEnvironment, Session, Message, CheckpointEntry, ImageAttachment, ChatOptions, ChatResponse, ToolCall, ToolResultBlock, ThinkingBlock, ToolSpec } from '../types';
import { readIntakeFile } from '../intake/fileReader';
import { splitContent, splitPagesIntoChunks, MAX_CHUNK_CHARS } from '../intake/splitter';
import { extractContent, renderMergedUnderstandingAsMarkdown } from '../intake/extractor';
import { ToolExecutor } from '../agents/toolExecutor';
import { buildSystemPrompt } from '../agents/prompts';
import { AgentDefinition, ToolName, READ_ONLY_TOOLS } from '../agents/types';
import { buildToolSpecs } from '../agents/tools/schemas';
import { ContextTools, schemaSummary } from '../agents/tools/contextTools';
import { buildSubagent, isParallelSafeTask, SUBAGENT_TYPES } from '../agents/subagents';
import { SkillRouter, SkillPick, RunSkillState } from '../agents/skillRouter';
import { TodoTracker } from '../agents/todos';
import { contextWindowFor, pruneRunHistory } from '../session/contextBudget';
import { capsFor, clampEffort, isEffortLevel, EffortLevel, EFFORT_LEVELS } from '../providers/modelCaps';
import { AGENTS, GENERAL_AGENT } from '../agents/registry';
import { getApprovalMode, isAutoApprove, ApprovalMode } from '../agents/approvalMode';
import { ROUTER_CONTEXT_TURNS } from '../agents/router';
import { routeOrPlan, reviseStagesWithComments, StagePlan } from '../agents/planner';
import { writePlanFile, updatePlanFile, appendPlanDecision, parsePlanComments, deriveTitle } from '../agents/planStore';
import {
  TouchedFile, VerificationOutcome, classifyTouchedFile, buildVerificationPlan,
  VERIFY_MAX_ROUNDS, VERIFY_FIX_STEP_BUDGET, migrateCmd
} from '../agents/verification';
import { VectorStore } from '../agents/vectorStore';
import { GraphStore } from '../agents/graphStore';
import { SkillsStore } from '../agents/skillsStore';
import { MCPManager } from '../mcp/manager';
import { readConfig } from '../workspace/structure';
import { buildCrossAgentContext } from '../workspace/crossAgentMemory';
import { estimateMessagesTokens, buildCompactionPrompt, DEFAULT_COMPACTION_THRESHOLD_TOKENS } from '../session/compaction';
import { diffLines } from 'diff';

const MAX_DIFF_READ_BYTES = 1 * 1024 * 1024;

/** The main task loop has no overall step cap — it runs until the model
 *  naturally stops calling tools. But a model that structurally can't emit
 *  this app's tool-call format (garbled/wrong-syntax output — see the
 *  malformed-tool-call check in runOneAgentStep) will just repeat that
 *  failure forever; more retries won't fix a provider/model bug. Give up
 *  and report honestly after this many *consecutive* malformed attempts. */
const MAX_CONSECUTIVE_MALFORMED_TOOL_CALLS = 5;

/** Each provider already retries a failed request a few times internally
 *  before the promise/generator ever throws (see e.g. openai.ts's own
 *  MAX_RETRIES loop) — so a thrown stream error reaching here has already
 *  survived that. It can still happen for a genuine mid-stream connection
 *  drop (the underlying HTTP/SSE connection dies after some chunks already
 *  arrived, not just on initial connect) — transient, and retrying the same
 *  step recovers cleanly since nothing was persisted yet. Only give up after
 *  this many *consecutive* step-level failures, so a real outage/rate limit
 *  still ends the run rather than spinning forever. */
const MAX_CONSECUTIVE_STREAM_ERRORS = 5;

/** A response cut off by the provider's own output-token ceiling (see
 *  ChatResponse.truncated) is re-prompted with "continue" rather than ended —
 *  see the truncated-response check in runOneAgentStep. Bounded the same way
 *  as the other retry loops in this file so a model/config combo that always
 *  gets cut off (e.g. a thinking budget that leaves no room for the reply)
 *  gives up and says so instead of looping forever. */
const MAX_CONSECUTIVE_TRUNCATIONS = 5;

/** The image formats every vision-capable provider here accepts. An extension
 *  outside this map falls through to the text-extraction path. */
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** Anthropic rejects images over ~5MB. Checked before the request so the user
 *  gets a clear message instead of an opaque 400 mid-run. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Rough, deliberately conservative single default — this codebase has no
 *  per-model context-window registry, and building one is out of scope for a
 *  ballpark usage indicator. */
/** Offer compaction once history passes this share of the context window. */
const OFFER_COMPACT_AT = 0.5;
/** Compact automatically past this share. */
const AUTO_COMPACT_AT = 0.8;

interface RunAgentLoopOptions {
  /** Run bench migrate/tests after this agent finishes, self-correcting on failure. */
  verify?: boolean;
  /** Whether to wipe the cosmetic workflow graph at the start of this run — false when chained as a pipeline stage. */
  resetGraph?: boolean;
  /** Edge this run's parent graph node from a prior stage's run, when chained. */
  precedingRunId?: string;
  /** Cosmetic prefix for this run's graph node label, e.g. "Stage 2/3:". */
  graphLabelPrefix?: string;
  /** Shared id for the user prompt this run was spawned from — see Message.promptId. */
  promptId?: string;
}

interface RunAgentLoopOutcome {
  runId: string;
  done: boolean;
  verification: VerificationOutcome | null;
}

interface AgentStepResult {
  done: boolean;
  assistantText: string;
  /** True when the outer loop should stop even though `done` is false (abort/stream error). */
  stopLoop: boolean;
}

export class ChatPanel implements vscode.WebviewViewProvider {
  public static readonly viewType = 'frappeCopilot.chat';
  public static readonly sideViewType = 'frappe-copilot.agentChat';

  private panel: vscode.WebviewPanel | null = null;
  private webviewView: vscode.WebviewView | null = null;
  private disposables: vscode.Disposable[] = [];
  private vectorStoreWatchers: vscode.Disposable[] = [];
  private uploadsDir: string = '';
  private toolExecutor: ToolExecutor;
  private vectorStore: VectorStore | null = null;
  private graphStore: GraphStore | null = null;
  private skillsStore: SkillsStore | null = null;
  /** Auto-selected skill content for the run in flight — computed once per run
   *  so the system prompt stays cache-stable across its steps. */
  private activeSkillContext = '';
  private skillRouter: SkillRouter | null = null;
  /** Skills loaded or hinted during the current run; preloaded = auto-loaded at its start. */
  private runSkills = new RunSkillState();
  private preloadedSkills: ReadonlySet<string> = new Set();
  private schemaMap: { doctypes: string[], apps: string[] } | null = null;
  private pendingApproval: { resolve: (approved: boolean) => void } | null = null;
  /** Gates a multi-stage plan before ANY of its stages start — kept separate
   *  from pendingApproval (already overloaded between per-tool approval and
   *  the run-verification gate via the same toolApproved/toolRejected
   *  messages) so a third overloaded use doesn't risk the two colliding.
   *  Unlike pendingApproval, nothing here ever checks isAutoApprove() — this
   *  gate is intentionally mode-independent, see requirePlanApproval(). */
  private pendingPlanApproval: { resolve: (result: 'approved' | 'rejected' | 'revise') => void } | null = null;
  private pendingClarification: { resolve: (answers: string) => void } | null = null;
  private pendingOAuthResolver: ((code: string) => void) | null = null;
  private activeModel: string = '';
  /** The agent's task list for the active session (persisted, carried across runs). */
  private todos = new TodoTracker();
  private todosSessionId: string | null = null;
  /** Unfinished list from an earlier run, injected into this run's context. */
  private activeTodoContext = '';
  private abortController: AbortController | null = null;
  private isRunningAgent = false;
  private aborted = false;
  /** Set when the model rejects native tool calling — falls back to the XML protocol. */
  private nativeToolsDisabled = false;
  private contextTools = new ContextTools(() => this.vectorStore, () => this.schemaMap, () => this.refreshSchema());
  /** Prompt tokens of the most recent model call (real usage when reported). */
  private lastPromptTokens = 0;
  private ragCache: { query: string; text: string } | null = null;
  private compacting = false;
  private streamSeq = 0;
  /** Tools the user chose "always allow" for in this session. */
  private alwaysAllowed = new Set<string>();
  private modelCache: { provider: string; models: string[]; fetchedAt: number } | null = null;

  constructor(
    private readonly extensionPath: string,
    private provider: LLMProvider,
    private sessionManager: SessionManager,
    private benchEnv: BenchEnvironment | null,
    // Shared singleton from extension.ts, not constructed here — unlike
    // SkillsStore (cheap file reads), each MCP connection is a real child
    // process/socket, so there must only ever be one manager instance.
    private mcpManager: MCPManager | null = null
  ) {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const fp = this.getFrappeCopilotPath();
    if (fp) {
      this.uploadsDir = path.join(fp, 'uploads');
      this.graphStore = new GraphStore(fp);
      // Built before VectorStore since the knowledge base indexes the skills
      // library too (see VectorStore's 'skill' source type).
      this.skillsStore = new SkillsStore(fp, path.join(extensionPath, 'assets', 'skills'));
      this.skillsStore.migrateLegacyMemoryIfNeeded();
      this.skillRouter = new SkillRouter(this.skillsStore);
      this.vectorStore = new VectorStore(fp, extensionPath, provider, root, this.skillsStore);
      this.vectorStoreWatchers = this.vectorStore.watch();
      this.introspectSchema(fp);
    }

    this.toolExecutor = new ToolExecutor(root, benchEnv, this.skillsStore, this.mcpManager);
  }

  /** Called by VS Code when resolving the WebviewView in the Secondary Side Bar */
  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.webviewView = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(this.extensionPath)]
    };
    webviewView.webview.html = this.getWebviewContent();
    webviewView.onDidDispose(() => {
      this.webviewView = null;
    }, null, this.disposables);
    webviewView.webview.onDidReceiveMessage(
      async (m) => { await this.handleMsg(m); },
      null,
      this.disposables
    );
  }

  /** Reveals or opens the chat. By default focuses the Secondary Side Bar view. */
  show(inTab: boolean = false): void {
    if (inTab) {
      this.showInTab();
      return;
    }
    if (this.webviewView) {
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
    this.panel = vscode.window.createWebviewPanel(
      ChatPanel.viewType,
      'Frappe Copilot',
      vscode.ViewColumn.Two,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.iconPath = vscode.Uri.file(
      path.join(this.extensionPath, 'assets', 'icon.svg')
    );
    this.panel.webview.html = this.getWebviewContent();
    this.panel.onDidDispose(() => {
      this.panel = null;
    }, null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      async (m) => { await this.handleMsg(m); },
      null,
      this.disposables
    );
  }

  /** Whether the Secondary Side Bar agent view is currently visible */
  isViewVisible(): boolean {
    return !!this.webviewView?.visible;
  }

  private async hasApiKey(): Promise<boolean> { try { return await (this.provider as any).hasApiKey(); } catch { return false; } }
  /** 'api-key' | 'oauth' | 'none' | undefined — undefined when the active provider doesn't distinguish auth modes (e.g. OpenAI, OpenCode Zen). */
  private async getAuthModeSafe(): Promise<string | undefined> {
    try { return await (this.provider as any).getAuthMode?.(); } catch { return undefined; }
  }
  /** Claude Code has no direct endpoint — auth and routing are resolved by the SDK itself. */
  private endpointForProvider(providerId: string): string {
    switch (providerId) {
      case 'openai':
        return vscode.workspace.getConfiguration('frappe-copilot.openai').get<string>('endpoint', 'https://api.openai.com/v1');
      case 'anthropic':
        return vscode.workspace.getConfiguration('frappe-copilot.anthropic').get<string>('endpoint', 'https://api.anthropic.com/v1');
      case 'claude-code':
        return '';
      default:
        return vscode.workspace.getConfiguration('frappe-copilot.opencodeZen').get<string>('endpoint', 'https://opencode.ai/zen/v1');
    }
  }
  private say(type: string, data: any) {
    const payload = { type, ...(typeof data === 'object' ? data : { status: data }) };
    this.panel?.webview.postMessage(payload);
    this.webviewView?.webview.postMessage(payload);
  }
  private chat(role: string, content: string) { this.say('addMessage', { message: { role, content } }); }

  close(): void {
    this.panel?.dispose();
    this.panel = null;
  }
  insertCodeMention(mention: any): void {
    this.say('insertCodeMention', { mention });
  }
  loadSession(session: Session): void {
    this.bindTodos(session);
    const messages = this.sessionManager.readMessages(session.id);

    // Flag each user message whose promptId produced a revertible checkpoint
    // in some later run — the webview uses this to decide which historical
    // prompts get a "Revert changes from this prompt" link on reload.
    const promptIdsWithCheckpoint = new Set(
      messages.filter(m => m.hasCheckpoint && m.promptId).map(m => m.promptId)
    );
    const enriched = messages.map(m =>
      m.role === 'user' && m.promptId && promptIdsWithCheckpoint.has(m.promptId)
        ? { ...m, promptHasCheckpoint: true }
        : m
    );

    this.say('loadSession', {
      sessionName: session.name,
      messages: enriched
    });
    this.reportSessionSize(session);
  }
  setBenchEnv(env: BenchEnvironment | null): void {
    this.benchEnv = env;
    this.say('benchStatus', env?.type || 'unknown');
    this.toolExecutor.setBenchEnv(env);
  }

  /** Pushes the current skills catalog to the webview so the "/" picker can
   *  offer direct /skill-id invocation. Called on 'ready' and again whenever
   *  a skill is created/imported from outside the chat panel (extension.ts). */
  notifySkillsChanged(): void {
    if (!this.skillsStore) return;
    const skills = this.skillsStore.listSkills();
    this.say('skillsList', { skills });
  }

  /** Announces a newly created/imported skill in the chat transcript, so the
   *  library growing is visible where the user is actually working rather than
   *  only in the Skills tree. */
  notifySkillCreated(id: string): void {
    const meta = this.skillsStore?.listSkills().find(s => s.id === id);
    this.notifySkillsChanged();
    this.say('skillEvent', {
      kind: 'created',
      id,
      name: meta?.name || id,
      description: meta?.description || ''
    });
  }

  /** Loads the skills whose descriptions match `userMessage` and returns them as
   *  a system-prompt section. Each one is announced in the chat so it is obvious
   *  which guidance the answer was written against. Returns '' when nothing
   *  scores highly enough — the common case for chitchat and short follow-ups. */
  /** Points the todo tracker at a session's saved list. */
  private bindTodos(session: Session): void {
    if (this.todosSessionId === session.id) return;
    const fp = this.getFrappeCopilotPath();
    this.todos.load(fp ? path.join(fp, 'sessions', session.id) : null);
    this.todosSessionId = session.id;
    this.sendTodos();
  }

  private sendTodos(): void {
    this.say('todoListUpdated', this.todos.snapshot());
  }

  /** Preloads the skills (and their relevant reference files) this request
   *  needs, and resets the run's skill tracking for mid-run hints. */
  private buildAutoSkillContext(userMessage: string): string {
    this.runSkills = new RunSkillState();
    this.preloadedSkills = new Set();
    if (!this.skillRouter) return '';

    let picked: SkillPick[] = [];
    try {
      picked = this.skillRouter.selectForRequest(userMessage);
    } catch (e) {
      console.error('Auto skill selection failed:', e);
      return '';
    }
    if (picked.length === 0) return '';

    for (const s of picked) {
      this.runSkills.loaded.add(s.id);
      this.say('skillEvent', { kind: 'loaded', id: s.id, name: s.name, auto: true, reason: s.reason });
    }
    this.preloadedSkills = new Set(this.runSkills.loaded);

    return `\n\n### Auto-Loaded Skills\nSelected for this request — treat them as authoritative for the topics they cover, and don't load them again with use_skill:\n\n` +
      picked.map(s => `--- [${s.id.includes('/') ? 'Skill reference' : 'Skill'}: ${s.id}] (${s.reason}) ---\n${s.content}`).join('\n\n');
  }

  private getWebviewContent(): string {
    const p = path.join(this.extensionPath, 'assets', 'webview', 'chat.html');
    try { if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8'); } catch { }
    return '<!DOCTYPE html><html><body><h1>Frappe Copilot</h1></body></html>';
  }

  private getFrappeCopilotPath(): string | null {
    const r = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
    if (!r) return null;
    const p = path.join(r, '.frappe-copilot');
    return fs.existsSync(p) ? p : null;
  }

  private async handleMsg(msg: any): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.say('status', await this.hasApiKey() ? 'ready' : 'no-key');
        this.say('benchStatus', this.benchEnv?.type || 'unknown');
        
        await this.sendModels(false);

        if (this.sessionManager.activeSession) {
          this.loadSession(this.sessionManager.activeSession);
        }
        this.sendTodos();
        this.notifySkillsChanged();
        break;
      case 'getSkillContent': {
        if (!this.skillsStore || !msg.id) break;
        const skill = this.skillsStore.listSkills().find(s => s.id === msg.id);
        const content = this.skillsStore.readSkill(msg.id);
        if (content) {
          this.say('skillContent', { id: msg.id, name: skill?.name || msg.id, content });
        }
        break;
      }
      case 'sendMessage':
        await this.handleSend(msg.text);
        break;
      case 'sendWithFile':
        await this.handleSendWithFile(msg);
        break;
      case 'abort':
        this.aborted = true;
        this.abortController?.abort();
        this.isRunningAgent = false;
        // A run parked on an approval or question would otherwise wait forever.
        this.pendingApproval?.resolve(false);
        this.pendingApproval = null;
        this.pendingClarification?.resolve('(The user cancelled the run before answering.)');
        this.pendingClarification = null;
        this.toolExecutor.killRunningCommands();
        break;
      case 'toolApproved':
        if (msg.always && typeof msg.tool === 'string') this.alwaysAllowed.add(msg.tool);
        if (this.pendingApproval) {
          this.say('agentState', { state: 'running' });
          this.pendingApproval.resolve(true);
          this.pendingApproval = null;
        }
        break;
      case 'toolRejected':
        if (this.pendingApproval) {
          this.say('agentState', { state: 'running' });
          this.pendingApproval.resolve(false);
          this.pendingApproval = null;
        }
        break;
      case 'planApproved':
        if (this.pendingPlanApproval) {
          this.say('agentState', { state: 'running' });
          this.pendingPlanApproval.resolve('approved');
          this.pendingPlanApproval = null;
        }
        break;
      case 'planRejected':
        if (this.pendingPlanApproval) {
          this.say('agentState', { state: 'running' });
          this.pendingPlanApproval.resolve('rejected');
          this.pendingPlanApproval = null;
        }
        break;
      case 'planRevise':
        // Stays 'paused' rather than 'running' — revision is resolved and
        // re-shown as a fresh approval card in the same paused state, not
        // handed off to the agent loop.
        if (this.pendingPlanApproval) {
          this.pendingPlanApproval.resolve('revise');
          this.pendingPlanApproval = null;
        }
        break;
      case 'openFile':
        try {
          const uri = vscode.Uri.parse(msg.uri);
          const docUri = uri.with({ fragment: '' });
          vscode.workspace.openTextDocument(docUri).then(doc => {
            vscode.window.showTextDocument(doc).then(editor => {
              const fragment = uri.fragment;
              if (fragment) {
                const match = fragment.match(/^L(\d+)(?:-L(\d+))?$/);
                if (match) {
                  const startLine = Math.max(0, parseInt(match[1], 10) - 1);
                  const endLine = match[2] ? Math.max(0, parseInt(match[2], 10) - 1) : startLine;
                  const selection = new vscode.Selection(
                    new vscode.Position(startLine, 0),
                    new vscode.Position(endLine, 1000)
                  );
                  editor.selection = selection;
                  editor.revealRange(selection, vscode.TextEditorRevealType.InCenter);
                }
              }
            });
          });
        } catch (e) {
          console.error('Failed to open file from webview:', e);
        }
        break;
      case 'newSession':
        this.alwaysAllowed.clear();
        vscode.commands.executeCommand('frappe-copilot.newSession');
        break;
      case 'openHistory':
        vscode.commands.executeCommand('frappe-copilot.sessions.focus');
        break;
      case 'runSlashCommand':
        if (msg.command === 'compact') {
          const session = this.sessionManager.activeSession;
          if (session) await this.runManualCompaction(session);
        } else if (msg.command === 'skills') {
          try { await vscode.commands.executeCommand('frappe-copilot.skills.focus'); } catch { /* view not registered yet */ }
        }
        break;
      case 'clarificationSubmitted':
        if (this.pendingClarification) {
          this.say('agentState', { state: 'running' });
          this.pendingClarification.resolve(msg.answers);
          this.pendingClarification = null;
        }
        break;
      case 'setEffort': {
        const level = isEffortLevel(msg.effort) ? msg.effort : '';
        await vscode.workspace.getConfiguration('frappe-copilot').update('effort', level, vscode.ConfigurationTarget.Global);
        this.sendEffort();
        break;
      }
      case 'clearTodos':
        this.todos.clear();
        this.sendTodos();
        break;
      case 'refreshModels':
        await this.sendModels(true);
        break;
      case 'selectModel':
        this.activeModel = msg.model;
        this.sendEffort();
        this.nativeToolsDisabled = false;
        break;
      case 'setApprovalMode': {
        const mode: ApprovalMode = msg.mode === 'auto' ? 'auto' : 'ask';
        // Global rather than workspace scope so the choice isn't silently lost
        // when switching between benches/apps.
        await vscode.workspace.getConfiguration('frappe-copilot')
          .update('approvalMode', mode, vscode.ConfigurationTarget.Global);
        this.say('approvalMode', { mode });
        this.chat('system', mode === 'auto'
          ? '⚡ **Auto mode on.** File writes, edits, commands, and verification will run without asking. Changes are still checkpointed, so a run can be reverted.'
          : '🛡️ **Ask mode on.** High-risk actions will pause for your approval.');
        break;
      }
      case 'getApprovalMode':
        this.say('approvalMode', { mode: getApprovalMode() });
        break;
      case 'saveFile': {
        // A webview iframe is sandboxed without allow-downloads, so the usual
        // blob-URL + anchor.click() trick silently does nothing — the save has
        // to happen on the extension host.
        if (!msg.data) break;
        const defaultName = msg.defaultName || 'download';
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
        const uri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(path.join(root, defaultName)),
          saveLabel: 'Save'
        });
        if (!uri) break;
        try {
          const buffer = msg.encoding === 'base64'
            ? Buffer.from(msg.data, 'base64')
            : Buffer.from(msg.data, 'utf8');
          fs.writeFileSync(uri.fsPath, buffer);
          vscode.window.showInformationMessage(`Frappe Copilot: saved ${path.basename(uri.fsPath)}`);
        } catch (e: any) {
          vscode.window.showErrorMessage(`Frappe Copilot: could not save file — ${e.message || e}`);
        }
        break;
      }
      case 'setApiKey':
        if (msg.key && msg.key.trim()) {
          await (this.provider as any).setApiKey(msg.key.trim());
          this.say('apiKeyStatus', { ok: true, msg: 'API key saved successfully.' });
          this.say('status', 'ready');
          vscode.window.showInformationMessage('Frappe Copilot: API key saved.');
        } else {
          this.say('apiKeyStatus', { ok: false, msg: 'API key cannot be empty.' });
        }
        break;
      case 'startClaudeOAuth':
        try {
          const manualCodePromise = new Promise<string>((resolve) => {
            this.pendingOAuthResolver = resolve;
          });

          const rawKey = await runClaudeOAuthFlow(
            (authUrl) => {
              this.say('claudeOAuthStarted', { authUrl });
            },
            manualCodePromise
          );

          if (rawKey) {
            await (this.provider as any).setApiKey(rawKey);
            this.say('apiKeyStatus', { ok: true, msg: 'OAuth login successful.' });
            this.say('status', 'ready');
            
            // Reload settings to update UI state
            const activeProviderId = vscode.workspace.getConfiguration('frappe-copilot').get<string>('provider', 'opencode-zen');
            const currentEndpoint = this.endpointForProvider(activeProviderId);

            this.say('settingsLoaded', {
              hasKey: true,
              endpoint: currentEndpoint,
              provider: activeProviderId,
              authMode: await this.getAuthModeSafe()
            });

            vscode.window.showInformationMessage('Frappe Copilot: Claude OAuth login successful!');
          }
        } catch (e: any) {
          console.error('Claude OAuth flow failed:', e);
          this.say('apiKeyStatus', { ok: false, msg: `Login failed: ${e.message || e}` });
          vscode.window.showErrorMessage(`Claude OAuth login failed: ${e.message || e}`);
        } finally {
          this.pendingOAuthResolver = null;
        }
        break;
      case 'submitClaudeOAuthCode':
        if (this.pendingOAuthResolver && msg.code) {
          this.pendingOAuthResolver(msg.code.trim());
          this.pendingOAuthResolver = null;
        }
        break;
      case 'cancelClaudeOAuth':
        if (this.pendingOAuthResolver) {
          this.pendingOAuthResolver('');
          this.pendingOAuthResolver = null;
        }
        break;
      case 'setEndpoint':
        if (msg.endpoint && msg.endpoint.trim()) {
          const activeProviderId = vscode.workspace.getConfiguration('frappe-copilot').get<string>('provider', 'opencode-zen');
          if (activeProviderId === 'claude-code') {
            this.say('apiKeyStatus', { ok: true, msg: 'Claude Code resolves its own endpoint — nothing to save.' });
            break;
          }
          const section = activeProviderId === 'openai' ? 'frappe-copilot.openai' : activeProviderId === 'anthropic' ? 'frappe-copilot.anthropic' : 'frappe-copilot.opencodeZen';
          await vscode.workspace.getConfiguration(section).update('endpoint', msg.endpoint.trim(), vscode.ConfigurationTarget.Global);
          (this.provider as any).refreshConfig?.();
          this.nativeToolsDisabled = false;
          this.say('apiKeyStatus', { ok: true, msg: 'Endpoint saved.' });
        }
        break;
      case 'setProvider':
        if (msg.provider) {
          await vscode.workspace.getConfiguration('frappe-copilot').update('provider', msg.provider, vscode.ConfigurationTarget.Global);
          (this.provider as any).refreshConfig?.();
          this.nativeToolsDisabled = false;
          const hasKey = await (this.provider as any).hasApiKey?.();
          const endpoint = this.endpointForProvider(msg.provider);
          this.say('settingsLoaded', {
            hasKey: !!hasKey,
            endpoint: endpoint,
            provider: msg.provider,
            authMode: await this.getAuthModeSafe()
          });
          this.activeModel = '';
          await this.sendModels(true);
          this.say('status', hasKey ? 'ready' : 'no-key');
        }
        break;
      case 'getRunTranscript': {
        const session = this.sessionManager.activeSession;
        if (session && msg.runId) {
          const entries = this.sessionManager.readRunTranscript(session.id, msg.runId);
          this.say('runTranscript', { runId: msg.runId, entries });
        }
        break;
      }
      case 'revertRun': {
        const session = this.sessionManager.activeSession;
        if (!session || !msg.runId) break;
        const entries = this.sessionManager.readCheckpoint(session.id, msg.runId);
        if (entries.length === 0) break;

        const note = this.sessionManager.readCompactionState(session.id)
          ? ' Note: this conversation has since been compacted — the summary may still describe work this revert undoes.'
          : '';
        const choice = await vscode.window.showWarningMessage(
          `Revert ${entries.length} file(s) to their state before this run? This restores files to their pre-run content — any edits you made to them since (manually or via later runs) will be lost.${note}`,
          { modal: true },
          'Revert Files'
        );
        if (choice !== 'Revert Files') break;

        this.restoreCheckpointEntries(entries);
        this.say('runReverted', { runId: msg.runId, count: entries.length });
        vscode.window.showInformationMessage(`Frappe Copilot: Reverted ${entries.length} file(s).`);
        break;
      }
      case 'getPromptRevertPreview': {
        const session = this.sessionManager.activeSession;
        if (!session || !msg.promptId) break;
        const entries = this.getMergedPromptCheckpoint(session.id, msg.promptId);
        if (!entries || entries.length === 0) break;

        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        const files = entries.map(e => {
          const abs = path.resolve(root, e.path);
          if (!e.existedBefore) {
            // The prompt created this file — reverting deletes it entirely, nothing to diff.
            return { path: e.path, willDelete: true, diffHunks: null };
          }
          const currentContent = this.readFileCapped(abs) ?? '';
          return { path: e.path, willDelete: false, diffHunks: diffLines(currentContent, e.originalContent ?? '') };
        });
        this.say('promptRevertPreview', {
          promptId: msg.promptId,
          files,
          compacted: !!this.sessionManager.readCompactionState(session.id)
        });
        break;
      }
      case 'revertPrompt': {
        const session = this.sessionManager.activeSession;
        if (!session || !msg.promptId) break;
        const entries = this.getMergedPromptCheckpoint(session.id, msg.promptId);
        if (!entries || entries.length === 0) break;

        // Confirmation already happened in the webview's own preview card
        // (see getPromptRevertPreview) — no second native modal here.
        this.restoreCheckpointEntries(entries);
        this.say('promptReverted', { promptId: msg.promptId, count: entries.length });
        vscode.window.showInformationMessage(`Frappe Copilot: Reverted ${entries.length} file(s).`);
        break;
      }
      case 'getSettings':
        const activeProviderId = vscode.workspace.getConfiguration('frappe-copilot').get<string>('provider', 'opencode-zen');
        const hasKeyVal = await (this.provider as any).hasApiKey?.();
        const currentEndpoint = this.endpointForProvider(activeProviderId);
        this.say('settingsLoaded', {
          hasKey: !!hasKeyVal,
          endpoint: currentEndpoint,
          provider: activeProviderId,
          authMode: await this.getAuthModeSafe()
        });
        break;
    }
  }

  /** Message shown when the active provider has no usable credentials — worded
   *  per-provider since Claude Code manages its own login outside this extension. */
  private async noAuthMessage(): Promise<string> {
    const providerId = vscode.workspace.getConfiguration('frappe-copilot').get<string>('provider', 'opencode-zen');
    if (providerId === 'claude-code') {
      return '⚠️ Claude Code SDK not available — run `claude` in a terminal once to log in, then try again.';
    }
    return '⚠️ Set your API key via Command Palette → Frappe Copilot: Set API Key';
  }

  private async handleSend(text: string): Promise<void> {
    if (!(await this.hasApiKey())) {
      this.chat('assistant', await this.noAuthMessage());
      return;
    }
    if (this.isRunningAgent) {
      this.chat('system', '⏳ Another request is currently executing. Please wait.');
      return;
    }
    await this.runOrchestrator(text);
  }

  /** Send with file attachment: extract text, then send file content + user prompt to AI. */
  private async handleSendWithFile(msg: any): Promise<void> {
    if (!(await this.hasApiKey())) {
      this.chat('assistant', await this.noAuthMessage());
      return;
    }
    if (this.isRunningAgent) {
      this.chat('system', '⏳ Another request is currently executing. Please wait.');
      return;
    }

    const { text: userPrompt, fileName, data } = msg;

    // Save file to uploads
    if (!this.uploadsDir) {
      const cp = this.getFrappeCopilotPath();
      if (!cp) {
        this.chat('error', 'No workspace open.');
        return;
      }
      this.uploadsDir = path.join(cp, 'uploads');
    }
    if (!fs.existsSync(this.uploadsDir)) fs.mkdirSync(this.uploadsDir, { recursive: true });

    const filePath = path.join(this.uploadsDir, Date.now() + '-' + fileName);
    fs.writeFileSync(filePath, Buffer.from(data, 'base64'));

    // An image can't be text-extracted — it goes to the model as a vision
    // attachment instead, with the file left on disk and only referenced by
    // path (see ImageAttachment) so messages.jsonl stays small.
    const mediaType = IMAGE_MEDIA_TYPES[path.extname(fileName).toLowerCase()];
    if (mediaType) {
      const sizeBytes = Buffer.byteLength(data, 'base64');
      if (sizeBytes > MAX_IMAGE_BYTES) {
        this.chat('error',
          `Image '${fileName}' is ${(sizeBytes / 1024 / 1024).toFixed(1)}MB — the limit is ` +
          `${MAX_IMAGE_BYTES / 1024 / 1024}MB. Resize or screenshot a smaller region and try again.`);
        return;
      }
      await this.runOrchestrator(
        userPrompt || 'Look at the attached image and help me with it.',
        [{ mediaType, name: fileName, path: filePath }]
      );
      return;
    }

    // Extract text (+ any embedded diagram images, for PDFs — see fileReader.ts)
    this.chat('system', '📄 Extracting text from ' + fileName + '...');
    let intake: Awaited<ReturnType<typeof readIntakeFile>>;
    try {
      intake = await readIntakeFile(filePath);
      this.chat('system', '📖 ' + intake.content.length.toLocaleString() + ' characters extracted' +
        (intake.images?.length ? `, ${intake.images.length} diagram/image(s) found` : ''));
    } catch (e: any) {
      this.chat('error', 'Failed to read file: ' + e.message);
      return;
    }

    const attachedImages = intake.images?.map(i => i.image);

    // Small document: fits in one model call — send as-is (no truncation
    // needed, no chunk/reader/merger overhead) but still attach any
    // extracted images so diagrams aren't silently dropped.
    if (intake.content.length <= MAX_CHUNK_CHARS) {
      const userMsg = '**File: ' + fileName + '**\n```\n' + intake.content + '\n```' +
        (userPrompt ? '\n\n**Task:** ' + userPrompt : '');
      await this.runOrchestrator(userMsg, attachedImages);
      return;
    }

    // Large document: run it through the chunk/reader/merger pipeline instead
    // of hard-truncating — each chunk's reader sees a running memory of
    // entities found in earlier chunks (so cross-section connections aren't
    // lost) plus that chunk's own page-range images, and the merger
    // explicitly reasons about relationships spanning sections.
    const chunks = intake.pageTexts
      ? splitPagesIntoChunks(intake.pageTexts, fileName)
      : splitContent(intake.content, fileName);

    this.chat('system', `📚 Document is large (${intake.content.length.toLocaleString()} chars) — analyzing in ${chunks.length} section(s)...`);
    let lastProgressMsg = '';
    const { merged } = await extractContent(this.provider, this.activeModel || undefined, chunks, {
      images: intake.images,
      onProgress: (p) => {
        if (p.message && p.message !== lastProgressMsg) {
          lastProgressMsg = p.message;
          this.chat('system', `${p.phase === 'merging' ? '🧩' : '🔎'} ${p.message}`);
        }
      },
    });

    const userMsg = renderMergedUnderstandingAsMarkdown(merged, fileName) +
      (userPrompt ? `\n\n**Task:** ${userPrompt}` : '');

    await this.runOrchestrator(userMsg);
  }

  private async waitForApproval(tool: string, args: any): Promise<boolean> {
    this.say('agentState', { state: 'paused' });
    return new Promise((resolve) => {
      this.pendingApproval = { resolve };
    });
  }

  /** Blocks until the user approves or rejects a multi-stage plan — fired
   *  once, before stage 1 starts, regardless of the ask/auto approval-mode
   *  setting (that setting only governs individual high-risk tool calls
   *  *inside* a stage once the plan is already running; it says nothing
   *  about whether the plan itself should run at all). This is what makes
   *  "plan needs approval even in auto mode" true. */
  private async requirePlanApproval(payload: { stages: { agentId: string; label: string; icon: string; task: string }[]; planPath: string | null; planFileUri: string | null }): Promise<'approved' | 'rejected' | 'revise'> {
    this.say('planApprovalRequired', payload);
    this.say('agentState', { state: 'paused' });
    return new Promise((resolve) => {
      this.pendingPlanApproval = { resolve };
    });
  }

  /** Loads each attached image's base64 off disk for the provider-bound copy of
   *  the history. Messages persist only a `path` (see ImageAttachment), so this
   *  is the one place the bytes enter memory — and only for the request being
   *  built, never for anything written back to messages.jsonl. An attachment
   *  whose file has since been deleted is dropped with a note in its place,
   *  which is far better than failing the whole run over a stale upload. */
  private hydrateImages(messages: Message[]): Message[] {
    return messages.map(m => {
      if (!m.images?.length) return m;
      const missing: string[] = [];
      const images: ImageAttachment[] = [];
      for (const img of m.images) {
        if (img.data) { images.push(img); continue; }
        try {
          images.push({ ...img, data: fs.readFileSync(img.path!).toString('base64') });
        } catch {
          missing.push(img.name || path.basename(img.path || 'image'));
        }
      }
      const note = missing.length
        ? `\n\n_(attached image${missing.length > 1 ? 's' : ''} no longer available: ${missing.join(', ')})_`
        : '';
      return { ...m, images, content: m.content + note };
    });
  }

  /** Shared by diff preview and checkpoint capture — same 1MB guardrail as
   *  ToolExecutor.readFile, so a huge existing file is never synchronously
   *  read/diffed/held in memory on the extension host thread. */
  private readFileCapped(absPath: string): string | null {
    try {
      const stat = fs.statSync(absPath);
      if (stat.size > MAX_DIFF_READ_BYTES) return null;
      return fs.readFileSync(absPath, 'utf-8');
    } catch {
      return null;
    }
  }

  /** Shared by revertRun and revertPrompt: restores each entry's before-image
   *  (or deletes the file if it didn't exist before the run/prompt started). */
  private restoreCheckpointEntries(entries: CheckpointEntry[]): void {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    for (const e of entries) {
      const abs = path.resolve(root, e.path);
      if (e.existedBefore) {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, e.originalContent ?? '', 'utf-8');
      } else if (fs.existsSync(abs)) {
        fs.rmSync(abs);
      }
    }
  }

  /** Shared by getPromptRevertPreview and revertPrompt: collects every
   *  checkpoint entry from every run this prompt spawned, keeping only the
   *  *earliest* before-image per path (runs are read in chronological order)
   *  so the result reverts a file to how it was before the whole prompt
   *  started, not just before whichever stage touched it last. */
  private getMergedPromptCheckpoint(sessionId: string, promptId: string): CheckpointEntry[] | null {
    const runIds = this.sessionManager.readMessages(sessionId)
      .filter(m => m.promptId === promptId && m.hasCheckpoint && m.runId)
      .map(m => m.runId!);
    if (runIds.length === 0) return null;

    const merged = new Map<string, CheckpointEntry>();
    for (const runId of runIds) {
      for (const entry of this.sessionManager.readCheckpoint(sessionId, runId)) {
        if (!merged.has(entry.path)) merged.set(entry.path, entry);
      }
    }
    return [...merged.values()];
  }

  private parseToolCalls(text: string): { name: string; args: Record<string, string>; raw: string }[] {
    const toolCalls: { name: string; args: Record<string, string>; raw: string }[] = [];
    const regex = /<tool_call\s+name="(\w+)"\s*>([\s\S]*?)<\/tool_call>/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      const name = match[1];
      const body = match[2];
      const args: Record<string, string> = {};

      const paramRegex = /<(\w+)>([\s\S]*?)<\/\1>/g;
      let paramMatch;
      while ((paramMatch = paramRegex.exec(body)) !== null) {
        let val = paramMatch[2].trim();
        if (val.startsWith('<![CDATA[') && val.endsWith(']]>')) {
          val = val.slice(9, -3);
        }
        args[paramMatch[1]] = val;
      }
      toolCalls.push({ name, args, raw: match[0] });
    }
    return toolCalls;
  }

  private async runOrchestrator(userMessage: string, images?: ImageAttachment[]): Promise<void> {
    this.aborted = false;
    this.abortController = new AbortController();
    this.isRunningAgent = true;
    this.say('agentState', { state: 'running' });
    const session = this.sessionManager.activeSession || this.sessionManager.createSession('Chat');
    const isFirstMessage = session.messageCount === 0;
    const promptId = this.sessionManager.generateRunId();
    this.sessionManager.appendMessage(session.id, {
      role: 'user',
      content: userMessage,
      promptId,
      ...(images?.length ? { images } : {})
    });
    // The user's bubble is already rendered locally by the webview before this
    // runs — tag it with promptId now so a later "revert changes from this
    // prompt" affordance (added once we know whether any run produced a
    // checkpoint, in the `finally` below) can find the right bubble.
    this.say('userPromptStarted', { promptId });

    if (isFirstMessage) {
      const title = deriveTitle(userMessage, 30);
      const autoName = title === 'plan' ? 'Session ' + (this.sessionManager.sessions.length + 1) : title;
      this.sessionManager.renameSession(session.id, autoName);
    }

    const multiAgentEnabled = vscode.workspace.getConfiguration('frappe-copilot').get<boolean>('multiAgent.enabled', false);

    try {
      if (multiAgentEnabled) {
        const recentHistory = this.sessionManager.readMessages(session.id).slice(-ROUTER_CONTEXT_TURNS);
        const route = await routeOrPlan(this.provider, userMessage, recentHistory, AGENTS);

        if (route.kind === 'plan' && route.stages && route.stages.length > 1) {
          await this.runApprovedPipeline(route.stages, session, userMessage, promptId);
        } else {
          const agentId = route.kind === 'single' ? route.agentId! : route.stages?.[0]?.agentId ?? 'general';
          const agent = AGENTS.find(a => a.id === agentId) || GENERAL_AGENT;
          this.say('agentRouted', { agentId: agent.id, label: agent.label, icon: agent.icon, reasoning: route.reasoning });
          await this.runAgentLoop(agent, session, userMessage, { verify: true, promptId });
        }
      } else {
        await this.runAgentLoop(GENERAL_AGENT, session, userMessage, { promptId });
      }
    } catch (e: any) {
      this.chat('error', `Agent execution failed: ${e.message || String(e)}`);
    } finally {
      this.isRunningAgent = false;
      this.say('agentState', { state: 'idle' });
      this.reportSessionSize(session);

      const producedCheckpoint = this.sessionManager.readMessages(session.id)
        .some(m => m.promptId === promptId && m.hasCheckpoint);
      if (producedCheckpoint) {
        this.say('promptCheckpointReady', { promptId });
      }
    }
  }

  /** Sends the token-usage badge update and, if the effective (post-compaction)
   *  history has grown past the configured threshold, offers — never forces —
   *  compaction. Called after every turn and after loading/switching a session. */
  private reportSessionSize(session: Session): void {
    const effective = this.sessionManager.buildEffectiveHistory(session.id);
    const estimatedTokens = estimateMessagesTokens(effective);
    const window = contextWindowFor(this.activeModel || this.provider.getModelId?.() || '');
    this.say('tokenUsage', { estimatedTokens, budget: window });

    // History alone past this share of the window leaves too little room for
    // the system prompt and a run's tool output — compact without asking.
    if (estimatedTokens > window * AUTO_COMPACT_AT && !this.compacting) {
      this.chat('system', `🗜️ Conversation is using ${Math.round(estimatedTokens / window * 100)}% of the context window — compacting automatically.`);
      void this.runManualCompaction(session);
      return;
    }
    const cfg = vscode.workspace.getConfiguration('frappe-copilot');
    const autoOffer = cfg.get<boolean>('compaction.autoOffer', true);
    const thresholdTokens = this.compactionThreshold(window);
    if (autoOffer && estimatedTokens > thresholdTokens) {
      this.say('compactionOffered', { estimatedTokens, thresholdTokens });
    }
  }

  /** The user's explicit thresholdTokens setting, else a share of the model's window. */
  private compactionThreshold(window: number): number {
    const inspected = vscode.workspace.getConfiguration('frappe-copilot').inspect<number>('compaction.thresholdTokens');
    const explicit = inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
    return explicit ?? Math.round(window * OFFER_COMPACT_AT);
  }

  /** "Summarize and replace": one non-streaming LLM call summarizes the full
   *  raw history into session's context.md; messages.jsonl itself is never
   *  touched — only buildEffectiveHistory()'s output (what gets sent to the
   *  model going forward) shrinks. */
  private async runManualCompaction(session: Session): Promise<void> {
    const allMessages = this.sessionManager.readMessages(session.id);
    if (allMessages.length === 0 || this.compacting) return;
    this.compacting = true;

    this.chat('system', '🗜️ Compacting conversation...');
    try {
      // ~4 chars/token; leave room for the summary itself.
      const window = contextWindowFor(this.activeModel || this.provider.getModelId?.() || '');
      const { system, user } = buildCompactionPrompt(allMessages, Math.floor(window * 0.6 * 4));
      const response = await this.provider.chat(
        [{ role: 'system', content: system }, { role: 'user', content: user }],
        { maxTokens: 4000, temperature: 0 }
      );
      const summary = response.content.trim();
      if (!summary) {
        this.chat('error', 'Compaction failed: empty summary returned.');
        return;
      }

      this.sessionManager.writeCompactionState(session.id, {
        compactedThroughCount: allMessages.length,
        summary,
        compactedAt: new Date().toISOString()
      });
      this.sessionManager.updateContext(session.id, summary);
      this.say('compactionApplied', { summary });
      this.reportSessionSize(session);
    } catch (e: any) {
      this.chat('error', `Compaction failed: ${e.message || String(e)}`);
    } finally {
      this.compacting = false;
    }
  }

  /** Resolves a StagePlan's bare agentId into the display shape the plan-
   *  approval card and the (now-retired) featurePlan event both used. */
  private toDisplayStages(stages: StagePlan[]): { agentId: string; label: string; icon: string; task: string }[] {
    return stages.map(s => {
      const agent = AGENTS.find(a => a.id === s.agentId) || GENERAL_AGENT;
      return { agentId: agent.id, label: agent.label, icon: agent.icon, task: s.task };
    });
  }

  /** Gate in front of runFeaturePipeline: writes the plan durably to
   *  .frappe-copilot/plans/, then blocks on approval — regardless of the
   *  ask/auto approval-mode setting, see requirePlanApproval — before ANY
   *  stage is allowed to start. Loops on a 'revise' decision: reads back
   *  whatever `COMMENT:` lines the user added under a stage in the plan
   *  file (see planStore.parsePlanComments), asks the model for an updated
   *  stage list from just that feedback, rewrites the same plan file with a
   *  bumped revision counter, and re-shows the approval card — until the
   *  user actually approves or rejects. Only ever calls runFeaturePipeline
   *  (the real execution) once approved. */
  private async runApprovedPipeline(initialStages: StagePlan[], session: Session, userMessage: string, promptId?: string): Promise<void> {
    let stages = initialStages;
    const title = deriveTitle(userMessage);
    const planRecord = writePlanFile({
      kind: 'pipeline',
      title,
      sessionId: session.id,
      sessionName: session.name,
      promptId,
      stages: this.toDisplayStages(stages),
    });
    let revision = 0;
    const planFileUri = planRecord ? vscode.Uri.file(planRecord.absPath).toString() : null;

    while (true) {
      const decision = await this.requirePlanApproval({ stages: this.toDisplayStages(stages), planPath: planRecord?.relPath ?? null, planFileUri });

      if (decision === 'revise') {
        if (!planRecord) {
          this.chat('system', '⚠️ Can\'t revise — the plan file couldn\'t be saved (no workspace open?). Approve or reject to continue.');
          continue;
        }
        const comments = parsePlanComments(planRecord.absPath);
        if (comments.length === 0) {
          this.chat('system', 'ℹ️ No `COMMENT:` lines found in the plan file — add one directly below the stage you want changed, save the file, then click **Revise from comments** again.');
          continue;
        }
        this.chat('system', `🔄 Revising plan from ${comments.length} comment(s)...`);
        const revisedStages = await reviseStagesWithComments(this.provider, stages, comments, AGENTS);
        if (!revisedStages) {
          this.chat('system', '⚠️ Revision failed (unparseable model response) — showing the plan unchanged.');
          continue;
        }
        stages = revisedStages;
        revision++;
        updatePlanFile(planRecord, { title, sessionId: session.id, sessionName: session.name, promptId, stages: this.toDisplayStages(stages) }, revision);
        continue;
      }

      const approved = decision === 'approved';
      if (planRecord) appendPlanDecision(planRecord.absPath, approved ? 'approved' : 'rejected');
      if (!approved) {
        this.chat('system', `🚫 Plan rejected — no stages started.${planRecord ? ` (Saved at \`${planRecord.relPath}\`.)` : ''}`);
        return;
      }
      await this.runFeaturePipeline(stages, session, userMessage, promptId);
      return;
    }
  }

  /** Runs an ordered multi-stage plan (see routeOrPlan) sequentially: each
   *  stage is a full runAgentLoop call for its specialist, chained on the same
   *  cosmetic graph (resetGraph only on the first stage) and verified before
   *  the next stage starts. Stops — rather than building further stages on a
   *  broken foundation — if a stage's verification fails or the stage was
   *  aborted/errored before completing. Only ever reached via
   *  runApprovedPipeline, once the plan has cleared the mandatory approval
   *  gate — this function itself has no approval logic of its own. */
  private async runFeaturePipeline(stages: StagePlan[], session: Session, userMessage: string, promptId?: string): Promise<void> {
    const resolved = stages.map(s => ({ agent: AGENTS.find(a => a.id === s.agentId) || GENERAL_AGENT, task: s.task }));

    let precedingRunId: string | undefined;
    for (let i = 0; i < resolved.length; i++) {
      if (this.aborted) break;
      const { agent, task } = resolved[i];
      this.say('featureStageStarted', { index: i, total: resolved.length, agentId: agent.id, label: agent.label, icon: agent.icon, task });

      // baseHistory naturally carries forward prior stages' summaries once persisted,
      // but nothing else tells the model its OWN stage's scope — this does.
      this.sessionManager.appendMessage(session.id, {
        role: 'user',
        content: `[Pipeline — Stage ${i + 1}/${resolved.length}: ${agent.label}]\n${task}`
      });

      const outcome = await this.runAgentLoop(agent, session, task, {
        verify: true,
        resetGraph: i === 0,
        precedingRunId,
        graphLabelPrefix: `Stage ${i + 1}/${resolved.length}:`,
        promptId
      });
      precedingRunId = outcome.runId;

      this.say('featureStageFinished', {
        index: i, total: resolved.length, agentId: agent.id, label: agent.label,
        verificationPassed: outcome.verification?.passed ?? null
      });

      if (outcome.verification && outcome.verification.ran && !outcome.verification.passed) {
        this.chat('system', `⏹️ Pipeline stopped after stage ${i + 1}/${resolved.length} (${agent.label}) — verification did not pass. Remaining stage(s) not started: ${resolved.slice(i + 1).map(s => s.agent.label).join(', ') || '(none)'}.`);
        this.say('featurePipelineStopped', { atStage: i, reason: 'verification-failed' });
        return;
      }
      if (!outcome.done) {
        this.chat('system', `⏹️ Pipeline stopped after stage ${i + 1}/${resolved.length} (${agent.label}) — it was cancelled or hit a stream error before completing.`);
        this.say('featurePipelineStopped', { atStage: i, reason: 'stage-incomplete' });
        return;
      }
    }
    this.say('featurePipelineFinished', { stages: resolved.length });
  }

  /** Runs one task-specialized agent's tool loop in isolation: its own tool
   *  allowlist and its own in-memory transcript (`localHistory`) that is never
   *  written turn-by-turn into the session's messages.jsonl. The loop keeps
   *  running — with no step cap — until the model stops calling tools, the
   *  user aborts, or a stream error occurs; a truncated response (the
   *  provider's per-call output limit cut it off mid tool-call) is detected
   *  and re-prompted automatically rather than ending the run. Only a single
   *  summarized assistant turn is persisted to
   *  the main session log when the run finishes; the full internal transcript
   *  is written once to a side file for on-demand inspection. When
   *  `opts.verify` is set, a harness-driven verification phase (migrate +
   *  scoped tests, with bounded self-correction) runs before that summary is
   *  finalized — see runVerificationPhase. */
  private async runAgentLoop(
    agent: AgentDefinition,
    session: Session,
    userMessage: string,
    opts: RunAgentLoopOptions = {}
  ): Promise<RunAgentLoopOutcome> {
    const runId = this.sessionManager.generateRunId();
    const baseHistory = this.sessionManager.buildEffectiveHistory(session.id);
    const localHistory: Message[] = [];
    const touchedFiles: TouchedFile[] = [];
    const checkpoint: CheckpointEntry[] = [];
    let lastAssistantText = '';
    let step = 0;
    let done = false;

    // 1. Initialize Visual Workflow Graph Planner — one parent node per agent run.
    if (this.graphStore) {
      if (opts.resetGraph !== false) this.graphStore.init("Workflow Executor");
      this.graphStore.addNode({
        id: runId,
        type: "reader",
        label: `${opts.graphLabelPrefix ? opts.graphLabelPrefix + ' ' : ''}${agent.icon} ${agent.label}`,
        description: agent.description,
        status: "running",
        progress: 30,
        agentRunId: runId
      });
      if (opts.precedingRunId) this.graphStore.addEdge(opts.precedingRunId, runId, 'next stage');
      this.say('graphUpdated', this.graphStore.get());
    }

    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const loopState = { malformedCount: 0, streamErrorCount: 0, truncatedCount: 0 };

    // Auto-load the skills this request obviously calls for, once per run. Doing
    // it here rather than per-step keeps the system prompt byte-identical across
    // the run's steps, so the prompt cache still hits — and it saves the
    // round-trip the model would otherwise spend calling use_skill itself.
    this.activeSkillContext = this.buildAutoSkillContext(userMessage);
    this.bindTodos(session);
    this.activeTodoContext = this.todos.carryOver();
    this.todos.beginRun();
    this.sendTodos();

    while (!done) {
      if (this.aborted) {
        this.chat('system', '⏹️ Execution cancelled by user.');
        break;
      }
      step++;
      const stepResult = await this.runOneAgentStep(
        agent, session, userMessage, baseHistory, localHistory, touchedFiles, checkpoint, runId, root, String(step), loopState
      );
      if (stepResult.assistantText.trim()) {
        lastAssistantText = stepResult.assistantText;
      }
      done = stepResult.done;
      // Finishing with open todos: send the agent back once to reconcile them.
      const nudge = done && !this.aborted && agent.allowedTools.includes('update_todo_list') ? this.todos.endOfRunNudge() : null;
      if (nudge) {
        localHistory.push({ role: 'user', content: nudge });
        done = false;
        continue;
      }
      if (stepResult.stopLoop) break;
    }
    // Whatever is still open survives into the next run instead of lingering forever.
    this.todos.markInterrupted();
    this.sendTodos();

    let verification: VerificationOutcome | null = null;
    if (opts.verify && done && touchedFiles.length > 0) {
      const verifyResult = await this.runVerificationPhase(
        agent, session, userMessage, baseHistory, localHistory, touchedFiles, checkpoint, runId, root, lastAssistantText
      );
      verification = verifyResult.outcome;
      lastAssistantText = verifyResult.lastAssistantText;
    }

    // Finalize visual graph
    if (this.graphStore) {
      const verificationFailed = !!verification && verification.ran && !verification.passed;
      this.graphStore.updateNode(runId, {
        status: verificationFailed ? "failed" : "completed",
        progress: 100,
        details: verificationFailed ? "Verification failed" : undefined
      });
      this.graphStore.get().currentState = 'completed';
      this.say('graphUpdated', this.graphStore.get());
    }

    // Fold the run back into the main transcript as exactly one summarized turn.
    let summaryText = lastAssistantText;
    if (!done) {
      // Always surface *something* here — if the last step produced no text
      // at all (e.g. it failed before any content streamed back), silently
      // persisting nothing left the user staring at a run that just stopped
      // with no explanation.
      summaryText = (summaryText.trim() ? summaryText + '\n\n' : '') +
        `_(execution stopped before completing — cancelled or a stream error occurred; see any error above)_`;
    }
    if (verification?.ran) {
      summaryText += verification.passed
        ? `\n\n---\n**Verification passed** (${verification.roundsUsed} attempt(s)).`
        : `\n\n---\n**Verification FAILED** after ${verification.roundsUsed} attempt(s). Last error:\n\`\`\`\n${(verification.lastError || '').slice(0, 2000)}\n\`\`\``;
    } else if (verification?.skippedReason) {
      summaryText += `\n\n_(Verification skipped: ${verification.skippedReason}.)_`;
    }
    if (verification?.missingTestNotes.length) {
      summaryText += `\n\n${verification.missingTestNotes.map(n => `_${n}_`).join('\n')}`;
    }

    // The architecture agent's whole job is to produce a plan, not a diff —
    // it has no write/execute tools, so there's nothing to gate before
    // "coding" the way the multi-stage pipeline gate works. But its output
    // is exactly the kind of plan the user shouldn't have to re-derive from
    // scratch next session, so it gets the same durable .md treatment.
    let planPath: string | undefined;
    if (agent.id === 'architecture' && done && summaryText.trim()) {
      const record = writePlanFile({
        kind: 'architecture',
        title: deriveTitle(userMessage),
        sessionId: session.id,
        sessionName: session.name,
        promptId: opts.promptId,
        body: summaryText,
      });
      if (record) {
        planPath = record.relPath;
        summaryText += `\n\n---\n📄 Plan saved to \`${record.relPath}\``;
      }
    }

    if (summaryText.trim()) {
      this.sessionManager.appendMessage(session.id, {
        role: 'assistant',
        content: summaryText,
        agentId: agent.id,
        runId,
        hasCheckpoint: checkpoint.length > 0,
        promptId: opts.promptId,
        ...(planPath ? { planPath } : {})
      });
    }
    this.sessionManager.writeRunTranscript(session.id, runId, localHistory);
    if (checkpoint.length > 0) {
      this.sessionManager.writeCheckpoint(session.id, runId, checkpoint);
    }

    return { runId, done, verification };
  }

  /** Runs a single reasoning + tool-dispatch step for one agent run. Extracted
   *  out of runAgentLoop so verification's fix-rounds can reuse the exact same
   *  step logic (approval flow, graph updates, tool allowlist gate) instead of
   *  duplicating it. */
  private async runOneAgentStep(
    agent: AgentDefinition,
    session: Session,
    userMessage: string,
    baseHistory: Message[],
    localHistory: Message[],
    touchedFiles: TouchedFile[],
    checkpoint: CheckpointEntry[],
    runId: string,
    root: string,
    stepLabel: string,
    loopState: { malformedCount: number; streamErrorCount: number; truncatedCount: number }
  ): Promise<AgentStepResult> {
    const native = this.useNativeTools();
    // Native-tool models pull knowledge on demand (search_knowledge); XML-mode
    // models are usually weaker at that, so they still get it injected.
    const ragContext = native ? '' : await this.injectedKnowledge(userMessage);
    const schemaContext = schemaSummary(this.schemaMap);

    let skillsCatalog = '';
    const catalog = this.skillRouter?.buildCatalog(this.preloadedSkills);
    if (catalog) {
      skillsCatalog = `\n\n### Available Skills\nEach line says when the skill applies. Before starting work of a kind listed here, load the matching skill with 'use_skill' (unless it is already loaded below); a skill may list reference files — load only the ones your task needs:\n\n${catalog}`;
    }

    let mcpCatalog = '';
    if (this.mcpManager && agent.allowedTools.includes('call_mcp_tool')) {
      const catalog = this.mcpManager.buildCatalog();
      if (catalog) {
        mcpCatalog = `\n\n### Available MCP Tools\nCheck this list before falling back to grep/read_file/web_search for anything one of these tools already covers — call it proactively via 'call_mcp_tool' with the server id and tool name shown below, don't wait to be asked by name:\n\n${catalog}`;
      }
    }

    // Read-only: whatever other AI agents (e.g. DevMind) have already
    // recorded about this project in their own dot-folders, so this agent
    // doesn't rediscover known issues or contradict past decisions.
    const crossAgentContext = buildCrossAgentContext(root);

    // Static per-agent boilerplate (identity/guidelines/tool docs) vs. the
    // per-turn dynamic tail (RAG/schema/skills/MCP/cross-agent context) —
    // kept as two pieces so a provider that supports a cacheable-prefix
    // split (see Message.staticPrefixLength) doesn't lose its cache hit on
    // the big static part just because the dynamic part changed this turn.
    const staticSystemPart = buildSystemPrompt(agent, native);
    const dynamicSystemPart = ragContext + schemaContext + skillsCatalog + mcpCatalog + crossAgentContext + this.activeSkillContext + this.activeTodoContext;

    const messages = this.hydrateImages([
      {
        role: 'system',
        content: staticSystemPart + dynamicSystemPart,
        staticPrefixLength: staticSystemPart.length
      },
      ...baseHistory,
      ...localHistory
    ]);

    this.say('agentState', { state: 'running', phase: stepLabel === '1' ? 'Analyzing request...' : 'Continuing reasoning...' });

    let streamed: StreamResult;
    try {
      streamed = await this.stream(messages, runId, native ? buildToolSpecs(agent.allowedTools) : undefined, this.effortFor(agent));
    } catch (e: any) {
      if (native && looksLikeToolsUnsupported(e)) {
        // Some OpenAI-compatible models reject the `tools` parameter outright —
        // drop to the XML protocol for the rest of this session and retry.
        this.nativeToolsDisabled = true;
        this.chat('system', '⚠️ This model rejected native tool calling; switching to the text-based tool protocol.');
        return { done: false, assistantText: '', stopLoop: false };
      }
      if (isPermanentError(e)) {
        // Bad model, auth, or malformed request — retrying can't fix these.
        this.chat('error', e.message || String(e));
        return { done: false, assistantText: '', stopLoop: true };
      }
      loopState.streamErrorCount++;
      if (loopState.streamErrorCount > MAX_CONSECUTIVE_STREAM_ERRORS) {
        this.chat('error', `LLM Stream error (gave up after ${loopState.streamErrorCount} consecutive failures): ${e.message || String(e)}`);
        return { done: false, assistantText: '', stopLoop: true };
      }
      this.chat('system', `⚠️ Stream error, retrying (attempt ${loopState.streamErrorCount}/${MAX_CONSECUTIVE_STREAM_ERRORS}): ${e.message || String(e)}`);
      await new Promise(res => setTimeout(res, Math.min(2000 * loopState.streamErrorCount, 10000)));
      return { done: false, assistantText: '', stopLoop: false };
    }
    loopState.streamErrorCount = 0;
    this.trackContextUsage(streamed, messages, localHistory);
    const fullContent = streamed.content;
    const fullReasoning = streamed.reasoning;
    const truncated = streamed.truncated;

    const nativeCalls = streamed.toolCalls || [];
    let toolCalls: PendingToolCall[];
    if (nativeCalls.length > 0) {
      toolCalls = nativeCalls.map(c => ({ callId: c.id, name: c.name, args: c.input || {} }));
      localHistory.push({
        role: 'assistant',
        content: fullContent,
        toolCalls: nativeCalls,
        thinkingBlocks: streamed.thinkingBlocks,
      });
    } else {
      toolCalls = this.extractXmlToolCalls(fullContent, fullReasoning, localHistory, `${runId}-${stepLabel}`);
    }

    if (toolCalls.length === 0) {
      return this.handleNoToolCalls(fullContent, fullReasoning, truncated, native, localHistory, loopState);
    }
    loopState.malformedCount = 0;
    loopState.truncatedCount = 0;

    const results: ToolResultBlock[] = [];
    for (const batch of batchToolCalls(toolCalls)) {
      const outs = await Promise.all(batch.map(call =>
        this.executeToolCall(agent, session, call, stepLabel, runId, root, touchedFiles, checkpoint)
      ));
      batch.forEach((call, k) => results.push({
        toolCallId: call.callId, name: call.name, content: outs[k].output, isError: !outs[k].success,
      }));
    }

    if (nativeCalls.length > 0) {
      localHistory.push({ role: 'user', content: '', toolResults: results });
    } else {
      for (const r of results) {
        localHistory.push({ role: 'user', content: `<tool_result name="${r.name}">\n${r.content}\n</tool_result>` });
      }
    }
    return { done: false, assistantText: fullContent, stopLoop: false };
  }

  /** Parses XML-protocol tool calls from the reply. With extended thinking on,
   *  the model sometimes emits the whole <tool_call> block inside its thinking
   *  stream instead, so fall back to that and fold the recovered calls into
   *  the assistant turn the tool results will answer. */
  private extractXmlToolCalls(content: string, reasoning: string, localHistory: Message[], idPrefix: string): PendingToolCall[] {
    let parsed = this.parseToolCalls(content);
    let transcriptText = content;
    if (parsed.length === 0 && reasoning.trim()) {
      const recovered = this.parseToolCalls(reasoning);
      if (recovered.length > 0) {
        parsed = recovered;
        transcriptText = [content.trim(), ...recovered.map(c => c.raw)].filter(Boolean).join('\n\n');
      }
    }
    if (transcriptText.trim()) {
      localHistory.push({ role: 'assistant', content: transcriptText });
    }
    return parsed.map((c, idx) => ({ callId: `${idPrefix}-${idx}`, name: c.name, args: c.args }));
  }

  /** A step with no tool calls normally ends the run — unless the reply was
   *  cut off by the output limit, or (XML protocol) the model garbled the
   *  tool-call syntax, in which case nudge it and keep looping. */
  private handleNoToolCalls(
    fullContent: string,
    fullReasoning: string,
    truncated: boolean,
    native: boolean,
    localHistory: Message[],
    loopState: { malformedCount: number; streamErrorCount: number; truncatedCount: number }
  ): AgentStepResult {
    const emitted = `${fullContent}\n${fullReasoning}`;
    const openCount = (emitted.match(/<tool_call\s+name="/g) || []).length;
    const closeCount = (emitted.match(/<\/tool_call>/g) || []).length;
    const danglingXmlCall = !native && openCount > closeCount;

    if (truncated || danglingXmlCall) {
      loopState.truncatedCount++;
      if (loopState.truncatedCount > MAX_CONSECUTIVE_TRUNCATIONS) {
        return {
          done: true,
          stopLoop: true,
          assistantText: `${fullContent}\n\n---\n**Stopped:** the response kept getting cut off by the output-length limit ${loopState.truncatedCount} times in a row before finishing. Try a shorter request, a lower extended-thinking budget, or a model with a larger output limit.`
        };
      }
      localHistory.push({
        role: 'user',
        content: 'Your previous response was cut off by the output length limit before finishing, so any tool call in it was NOT executed. Continue from where you left off; if you were writing a large file, split it into smaller write_file/edit_file calls.'
      });
      return { done: false, assistantText: fullContent, stopLoop: false };
    }
    loopState.truncatedCount = 0;

    // A model can drift into another invocation syntax (its own <invoke>/
    // <parameter> scaffolding, stray "DSML" tokens, invented tags like
    // <tool_check>) that parseToolCalls doesn't match. Accepting that as a
    // finished answer would end the run mid-task, so correct the model instead.
    // Only meaningful for the XML protocol.
    const looksLikeMalformedToolCall = !native && (
      /<\s*\/?[^a-zA-Z\n]{0,6}(invoke|parameter)\b/i.test(emitted) ||
      /\bDSML\b/i.test(emitted) ||
      /<\s*(?!tool_call\s+name\s*=)(tool[_-]?\w*|function[_-]?call)\b/i.test(emitted)
    );
    if (looksLikeMalformedToolCall) {
      loopState.malformedCount++;
      if (loopState.malformedCount > MAX_CONSECUTIVE_MALFORMED_TOOL_CALLS) {
        return {
          done: true,
          stopLoop: true,
          assistantText: `${fullContent}\n\n---\n**Stopped:** the model repeated an invalid/garbled tool-call format ${loopState.malformedCount} times in a row instead of using this app's expected format. This usually means the current model doesn't support this app's tool-calling protocol reliably — try switching models (\`/model\`) rather than retrying.`
        };
      }
      localHistory.push({
        role: 'user',
        content: 'Your previous response used an invalid tool-call format (garbled tag, invented tag name such as <tool_check>, or a missing name attribute) and was NOT executed. You must use exactly this format, with no other function-calling syntax, tokens, or extra characters: <tool_call name="TOOL_NAME"><param_name>value</param_name></tool_call> — the literal tag is `tool_call` and the `name` attribute is required. Write it in your visible reply, not inside your reasoning. Retry the tool call now in that exact format.'
      });
      return { done: false, assistantText: fullContent, stopLoop: false };
    }
    loopState.malformedCount = 0;
    return { done: true, assistantText: fullContent, stopLoop: true };
  }

  /** Runs one tool call end to end: allowlist gate, approval, checkpointing,
   *  execution, post-write syntax check, and graph/UI updates. Safe to run
   *  concurrently for READ_ONLY_TOOLS — those never prompt or checkpoint. */
  private async executeToolCall(
    agent: AgentDefinition,
    session: Session,
    tool: PendingToolCall,
    stepLabel: string,
    runId: string,
    root: string,
    touchedFiles: TouchedFile[],
    checkpoint: CheckpointEntry[]
  ): Promise<{ success: boolean; output: string }> {
    const callId = tool.callId;
    const ui = (event: string, payload: Record<string, any> = {}) => this.say(event, { tool: tool.name, callId, ...payload });
    ui('toolCallStarted', { args: tool.args });

    const nodeId = `tool-${stepLabel}-${callId}-${tool.name}`;
    this.graphAdd(nodeId, runId, tool);
    const finish = (success: boolean, output: string, details?: string) => {
      this.graphUpdate(nodeId, success, details);
      ui('toolFinished', { success, output });
      return { success, output };
    };

    if (this.aborted) return finish(false, 'Cancelled by the user before this tool ran.', 'Cancelled.');
    if (!agent.allowedTools.includes(tool.name as ToolName)) {
      // Hard allowlist gate — covers control-flow tools too, not just ToolExecutor ones.
      return finish(false, `Tool '${tool.name}' is not permitted for the ${agent.label} agent. Available tools: ${agent.allowedTools.join(', ')}`, "Not in this agent's tool allowlist.");
    }

    if (agent.highRiskTools.includes(tool.name as ToolName) && !isAutoApprove() && !this.alwaysAllowed.has(tool.name)) {
      ui('toolApprovalRequired', { args: tool.args, ...this.approvalDiff(tool, root) });
      if (!(await this.waitForApproval(tool.name, tool.args))) {
        return finish(false, 'Tool execution rejected by the user.', 'Rejected by user.');
      }
    }

    if (tool.name === 'update_todo_list') {
      const res = this.todos.update(tool.args);
      this.sendTodos();
      return finish(res.ok, res.output);
    }
    if (tool.name === 'ask_clarification') {
      this.say('showClarificationPopup', { questions: String(tool.args.questions || tool.args.question || '') });
      this.say('agentState', { state: 'paused' });
      const answers = await new Promise<string>(resolve => { this.pendingClarification = { resolve }; });
      return finish(true, answers);
    }

    ui('toolExecuting');
    const filePath = typeof tool.args.path === 'string' ? tool.args.path : '';
    const writesFile = FILE_WRITE_TOOLS.has(tool.name) && !!filePath;
    if (writesFile) {
      // Before-image for revert — captured before the write runs, even if it later fails.
      const absPath = path.resolve(root, filePath);
      const existedBefore = fs.existsSync(absPath);
      checkpoint.push({
        path: filePath,
        existedBefore,
        originalContent: existedBefore ? (this.readFileCapped(absPath) ?? undefined) : undefined
      });
    }

    // Stream execute_command's output live into its tool card.
    const onOutputChunk = tool.name === 'execute_command'
      ? (chunk: string) => ui('toolOutputChunk', { chunk })
      : undefined;
    const result = this.contextTools.handles(tool.name)
      ? await this.contextTools.run(tool.name, tool.args)
      : tool.name === 'task'
        ? await this.runSubagent(tool.args, session, runId, root, touchedFiles, checkpoint)
        : await this.toolExecutor.runTool(tool.name, tool.args, agent.allowedTools, onOutputChunk);

    if (result.success && tool.name === 'use_skill' && tool.args.id) {
      const meta = this.skillsStore?.listSkills().find(s => s.id === tool.args.id);
      this.say('skillEvent', { kind: 'loaded', id: tool.args.id, name: meta?.name || tool.args.id, auto: false });
      result.output += this.skillRouter?.adapterFor(String(tool.args.id)) || '';
    }
    // Point the agent at a skill this call just made relevant (test files, git commits, a hard-won fix…).
    const skillHint = this.skillRouter?.observe({ tool: tool.name, args: tool.args, success: result.success }, this.runSkills);
    if (skillHint) result.output += skillHint;
    if (agent.allowedTools.includes('update_todo_list')) {
      result.output += this.todos.afterToolCall(tool.name) || '';
    }

    if (!(result.success && writesFile)) return finish(result.success, result.output);
    const absPath = path.resolve(root, filePath);
    touchedFiles.push(classifyTouchedFile(filePath, absPath));
    const lintError = await this.syntaxCheck(absPath);
    if (!lintError) return finish(true, result.output);
    this.chat('error', `⚠️ Linter warning on ${filePath}: compilation check failed.`);
    return finish(false, `${result.output}\n\n[LINTER WARNING] File compiled with error:\n${lintError}`, 'Compilation validation failed.');
  }

  /** Diff preview for the approval card. */
  private approvalDiff(tool: PendingToolCall, root: string): { fileExisted?: boolean; diffHunks?: any[] } {
    const a = tool.args;
    if (tool.name === 'write_file' && typeof a.path === 'string') {
      const absPath = path.resolve(root, a.path);
      const fileExisted = fs.existsSync(absPath);
      const oldContent = fileExisted ? (this.readFileCapped(absPath) ?? '') : '';
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

  /** Quick compile check after a write — returns the error text, or null. */
  private async syntaxCheck(absPath: string): Promise<string | null> {
    const ext = path.extname(absPath);
    if (ext !== '.py' && ext !== '.js') return null;
    const cmd = ext === '.py' ? `python -m py_compile "${absPath}"` : `node -c "${absPath}"`;
    const res = await this.toolExecutor.executeCommand(cmd);
    return res.success ? null : res.output;
  }

  /** Runs a delegated task (the `task` tool) as an isolated agent run with a
   *  fresh transcript, and returns its final reply as the tool result. File
   *  changes land in the parent's checkpoint so "revert" still covers them. */
  private async runSubagent(
    args: Record<string, any>,
    session: Session,
    parentRunId: string,
    root: string,
    touchedFiles: TouchedFile[],
    checkpoint: CheckpointEntry[]
  ): Promise<{ success: boolean; output: string }> {
    const type = String(args.subagent_type || 'explore');
    const agent = buildSubagent(type);
    if (!agent) return { success: false, output: `Unknown subagent_type '${type}'. Available: ${SUBAGENT_TYPES.map(a => a.id).join(', ')}` };
    const prompt = String(args.prompt || '').trim();
    if (!prompt) return { success: false, output: 'Missing prompt — give the sub-agent a complete task brief.' };
    const description = String(args.description || agent.label);

    const runId = this.sessionManager.generateRunId();
    const history: Message[] = [{ role: 'user', content: prompt }];
    const loopState = { malformedCount: 0, streamErrorCount: 0, truncatedCount: 0 };
    this.chat('system', `${agent.icon} Sub-agent **${agent.label}** started: ${description}`);
    this.graphStore?.addNode({ id: runId, type: 'reader', label: `${agent.icon} ${description}`, description: agent.label, status: 'running', progress: 30, agentRunId: runId });
    this.graphStore?.addEdge(parentRunId, runId, 'task');

    let report = '';
    let done = false;
    for (let step = 1; step <= MAX_SUBAGENT_STEPS && !this.aborted; step++) {
      const r = await this.runOneAgentStep(agent, session, prompt, [], history, touchedFiles, checkpoint, runId, root, `${runId}-${step}`, loopState);
      if (r.assistantText.trim()) report = r.assistantText;
      if (r.done) { done = true; break; }
      if (r.stopLoop) break;
    }
    this.sessionManager.writeRunTranscript(session.id, runId, history);
    this.graphUpdate(runId, done);
    this.chat('system', `${agent.icon} Sub-agent **${agent.label}** ${done ? 'finished' : 'stopped'}: ${description}`);
    if (!done) {
      const why = this.aborted ? 'cancelled by the user' : 'step limit or repeated errors';
      return { success: false, output: `${report ? report + '\n\n' : ''}[Sub-agent stopped before finishing: ${why}.]` };
    }
    return { success: true, output: report || '(sub-agent finished without a report)' };
  }

  /** Records the step's real prompt size (estimated when the provider
   *  doesn't report usage), updates the context badge, and clears older tool
   *  output from the run once it nears the model's context window. */
  private trackContextUsage(streamed: StreamResult, sent: Message[], localHistory: Message[]): void {
    const window = contextWindowFor(this.activeModel || this.provider.getModelId?.() || '');
    const prompt = streamed.usage?.promptTokens || estimateMessagesTokens(sent);
    this.lastPromptTokens = prompt;
    this.say('tokenUsage', { estimatedTokens: prompt, budget: window, live: true });
    // Providers that clear old tool results server-side must get an
    // append-only history — rewriting it invalidates thinking blocks.
    if (this.provider.managesContextServerSide?.()) return;
    const freed = pruneRunHistory(localHistory, prompt + (streamed.usage?.completionTokens || 0), window);
    if (freed > 0) {
      console.log(`[context] cleared ~${Math.round(freed / 4)} tokens of older tool output (${prompt}/${window})`);
    }
  }

  /** Knowledge-base snippets for XML-protocol models, which don't reliably
   *  call search_knowledge themselves. Cached per query so a multi-step run
   *  embeds once and keeps a byte-identical (cacheable) system prompt. */
  private async injectedKnowledge(query: string): Promise<string> {
    if (!this.vectorStore) return '';
    if (this.ragCache?.query === query) return this.ragCache.text;
    let text = '';
    try {
      const results = await this.vectorStore.search(query, 6);
      if (results.length > 0) {
        text = `\n\n### Retrieved Knowledge Base Context\nRetrieved from framework docs, this workspace's own code, your notes, skills, and other agents' memory — use it to follow correct APIs and this project's existing patterns:\n\n` +
          results.map(r => `--- [Source: ${r.source}] ---\n${r.text}`).join('\n\n');
      }
    } catch (e) {
      console.error('Failed to run vector search:', e);
    }
    this.ragCache = { query, text };
    return text;
  }

  private graphAdd(nodeId: string, runId: string, tool: PendingToolCall): void {
    if (!this.graphStore) return;
    this.graphStore.addNode({
      id: nodeId,
      type: "chunk",
      label: `${tool.name}`,
      description: `Args: ${Object.keys(tool.args).join(', ')}`,
      status: "running",
      progress: 50,
      agentRunId: runId
    });
    this.graphStore.addEdge(runId, nodeId);
    this.say('graphUpdated', this.graphStore.get());
  }

  private graphUpdate(nodeId: string, success: boolean, details?: string): void {
    if (!this.graphStore) return;
    this.graphStore.updateNode(nodeId, { status: success ? "completed" : "failed", progress: 100, details });
    this.say('graphUpdated', this.graphStore.get());
  }

  /** Harness-driven verification: runs bench migrate / scoped tests directly
   *  via ToolExecutor (never through the model's own tool-calling — this is
   *  why it applies regardless of whether `agent.allowedTools` includes
   *  execute_command), gated behind one approval prompt per run. On failure,
   *  feeds the real error back into the loop as a synthetic tool result and
   *  gives the agent a small, separate step budget to fix it, up to
   *  VERIFY_MAX_ROUNDS times, before giving up and reporting failure honestly. */
  private async runVerificationPhase(
    agent: AgentDefinition,
    session: Session,
    userMessage: string,
    baseHistory: Message[],
    localHistory: Message[],
    touchedFiles: TouchedFile[],
    checkpoint: CheckpointEntry[],
    runId: string,
    root: string,
    initialLastAssistantText: string
  ): Promise<{ outcome: VerificationOutcome; lastAssistantText: string }> {
    let lastAssistantText = initialLastAssistantText;
    const skip = (reason: string, missingTestNotes: string[] = []): { outcome: VerificationOutcome; lastAssistantText: string } => ({
      outcome: { ran: false, passed: true, roundsUsed: 0, missingTestNotes, skippedReason: reason },
      lastAssistantText
    });

    const site = this.benchEnv && this.benchEnv.type !== 'not-found' ? (await this.toolExecutor.sites.resolve()).site : null;
    if (!site || !this.benchEnv || this.benchEnv.type === 'not-found') {
      return skip('no site or bench environment configured');
    }

    const plan = buildVerificationPlan(touchedFiles, root);
    if (!plan.shouldMigrate && plan.testCommands.length === 0) {
      return { outcome: { ran: false, passed: true, roundsUsed: 0, missingTestNotes: plan.missingTestNotes }, lastAssistantText };
    }

    let approved = true;
    if (!isAutoApprove()) {
      this.say('verifyApprovalRequired', {
        runId,
        willMigrate: plan.shouldMigrate,
        testCommands: plan.testCommands.map(t => t.description)
      });
      approved = await this.waitForApproval('verify_run', { runId });
    }
    if (!approved) {
      return { outcome: { ran: false, passed: true, roundsUsed: 0, missingTestNotes: plan.missingTestNotes, skippedReason: 'declined by user' }, lastAssistantText };
    }

    let roundsUsed = 0;
    let lastError = '';
    let passed = false;
    const loopState = { malformedCount: 0, streamErrorCount: 0, truncatedCount: 0 };

    for (let round = 0; round <= VERIFY_MAX_ROUNDS && !passed; round++) {
      roundsUsed = round + 1;
      this.say('verifyRunning', { runId, round: roundsUsed });

      let roundOutput = '';
      let roundFailed = false;

      // Stream migrate/test output live — these can run long enough that
      // the chat would otherwise look frozen with no feedback at all.
      const onChunk = (chunk: string) => this.say('verifyOutputChunk', { runId, round: roundsUsed, chunk });

      if (plan.shouldMigrate) {
        const migrateCommand = migrateCmd(site);
        onChunk(`$ ${migrateCommand}\n`);
        const result = await this.toolExecutor.executeCommand(migrateCommand, onChunk);
        roundOutput += `[migrate]\n${result.output}\n`;
        if (!result.success) roundFailed = true;
      }
      if (!roundFailed) {
        for (const testCmd of plan.testCommands) {
          const testCommand = testCmd.command(site);
          onChunk(`\n$ ${testCommand}\n`);
          const result = await this.toolExecutor.executeCommand(testCommand, onChunk);
          roundOutput += `[${testCmd.description}]\n${result.output}\n`;
          if (!result.success) { roundFailed = true; break; }
        }
      }

      if (!roundFailed) {
        passed = true;
        break;
      }

      lastError = roundOutput;
      if (round >= VERIFY_MAX_ROUNDS) break;

      const fixPrompt = `<tool_result name="verify_run">\n[VERIFICATION FAILED - round ${roundsUsed}]\n${roundOutput}\nFix the issue above, then finish this turn (no further tool calls) once done. Verification will re-run automatically.\n</tool_result>`;
      localHistory.push({ role: 'user', content: fixPrompt });

      for (let fixStep = 1; fixStep <= VERIFY_FIX_STEP_BUDGET; fixStep++) {
        if (this.aborted) break;
        const stepResult = await this.runOneAgentStep(
          agent, session, userMessage, baseHistory, localHistory, touchedFiles, checkpoint, runId, root, `fix-${roundsUsed}-${fixStep}`, loopState
        );
        if (stepResult.assistantText.trim()) lastAssistantText = stepResult.assistantText;
        if (stepResult.done) break;
      }
      if (this.aborted) break;
    }

    const outcome: VerificationOutcome = {
      ran: true,
      passed,
      roundsUsed,
      missingTestNotes: plan.missingTestNotes,
      lastError: passed ? undefined : lastError
    };
    this.say('verifyResult', {
      runId, passed: outcome.passed, roundsUsed: outcome.roundsUsed,
      missingTestNotes: outcome.missingTestNotes, lastError: outcome.lastError
    });
    return { outcome, lastAssistantText };
  }

  /** Returns the visible reply *and* the thinking stream. Callers need both:
   *  with extended thinking on, the model sometimes emits a whole <tool_call>
   *  block inside its thinking instead of the reply, and that call still has
   *  to be found and executed (see runOneAgentStep). `truncated` is set when
   *  any chunk reported the provider cut the turn off at its output-token
   *  ceiling — see ChatResponse.truncated and the caller's handling of it. */
  private async stream(msgs: Message[], runId?: string, tools?: ToolSpec[], effort?: EffortLevel): Promise<StreamResult> {
    let full = '', fullReasoning = '', truncated = false;
    let toolCalls: ToolCall[] | undefined;
    let thinkingBlocks: ThinkingBlock[] | undefined;
    let usage: ChatResponse['usage'];
    // Unique even for parallel sub-agent streams started in the same millisecond.
    const id = `${Date.now()}-${++this.streamSeq}`;
    this.postWebviewMessage({ type: 'startStream', messageId: id });
    try {
      const options: ChatOptions = { maxTokens: 16384 };
      if (this.activeModel) options.model = this.activeModel;
      if (runId) options.runId = runId;
      if (tools?.length) options.tools = tools;
      if (effort) options.effort = effort;
      options.onRetry = (attempt: number, delaySec: number, error: string) => {
        this.say('retryNotice', { attempt, delaySec, error });
      };
      for await (const c of this.provider.chatStream(msgs, options, this.abortController?.signal || undefined)) {
        if (this.aborted) {
          throw new Error('Streaming aborted by user.');
        }
        full += c.content;
        fullReasoning += c.reasoning || '';
        if (c.truncated) truncated = true;
        if (c.toolCalls?.length) toolCalls = [...(toolCalls || []), ...c.toolCalls];
        if (c.thinkingBlocks?.length) thinkingBlocks = [...(thinkingBlocks || []), ...c.thinkingBlocks];
        if (c.usage?.promptTokens) usage = c.usage;
        if (c.content || c.reasoning) {
          this.postWebviewMessage({
            type: 'streamChunk',
            messageId: id,
            chunk: c.content,
            reasoning: c.reasoning || ''
          });
        }
      }
    } catch (e) { this.postWebviewMessage({ type: 'streamError', messageId: id, error: String(e) }); throw e; }
    this.postWebviewMessage({ type: 'endStream', messageId: id, fullContent: full, fullReasoning: fullReasoning });
    return { content: full, reasoning: fullReasoning, truncated, toolCalls, thinkingBlocks, usage };
  }

  /** Sends the provider's model list to the picker. Cached per provider so
   *  reopening the panel is instant; `force` pulls a fresh list from the API. */
  private async sendModels(force: boolean): Promise<void> {
    const provider = this.provider.name;
    if (force || !this.modelCache || this.modelCache.provider !== provider) {
      try {
        const models = this.provider.getModels ? await this.provider.getModels() : [];
        this.modelCache = { provider, models, fetchedAt: Date.now() };
      } catch (e: any) {
        this.say('modelsList', { models: this.modelCache?.models || [], error: e.message || String(e) });
        return;
      }
    }
    const { models, fetchedAt } = this.modelCache;
    const configured = this.provider.getModelId?.();
    const activeModel = this.activeModel || (configured && models.includes(configured) ? configured : configured || models[0]);
    this.say('modelsList', { models, activeModel, fetchedAt, provider });
    this.sendEffort();
  }

  /** The model being used right now — the picker's choice, else the provider default. */
  private currentModel(): string {
    return this.activeModel || this.provider.getModelId?.() || '';
  }

  /** The user's effort choice, or undefined to use the model's default. */
  private effortSetting(): EffortLevel | undefined {
    const v = vscode.workspace.getConfiguration('frappe-copilot').get<string>('effort', '');
    return isEffortLevel(v) ? v : undefined;
  }

  /** Effort for one agent run: the user's choice (or the model default),
   *  capped by the agent — read-only explore sub-agents don't need depth. */
  private effortFor(agent: AgentDefinition): EffortLevel | undefined {
    const caps = capsFor(this.currentModel());
    const chosen = this.effortSetting();
    if (!agent.maxEffort) return chosen;
    const base = chosen ?? caps.defaultEffort;
    if (!base) return chosen;
    return EFFORT_LEVELS.indexOf(base) > EFFORT_LEVELS.indexOf(agent.maxEffort) ? clampEffort(agent.maxEffort, caps) : chosen;
  }

  /** What the effort picker should offer for the current model. */
  private sendEffort(): void {
    const caps = capsFor(this.currentModel());
    this.say('effortInfo', {
      levels: caps.effortLevels,
      recommended: caps.defaultEffort || null,
      effort: this.effortSetting() || null,
    });
  }

  /** Native tool calling when the provider supports it and the user hasn't
   *  opted out; otherwise the XML text protocol. */
  private useNativeTools(): boolean {
    if (this.nativeToolsDisabled) return false;
    const enabled = vscode.workspace.getConfiguration('frappe-copilot').get<boolean>('nativeToolCalling', true);
    return enabled && !!this.provider.supportsNativeTools?.();
  }

  private postWebviewMessage(msg: any) {
    this.panel?.webview.postMessage(msg);
    this.webviewView?.webview.postMessage(msg);
  }

  dispose(): void {
    this.panel = null;
    this.webviewView = null;
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
  }

  /** Stops the knowledge-base file watcher. Deliberately NOT called from
   *  dispose() above — that fires whenever just the webview tab is closed,
   *  while this ChatPanel object (and its VectorStore) lives on for a later
   *  show() to reuse. Only extension deactivation should actually tear the
   *  watcher down. */
  /** Kills commands the agent started with run_in_background. */
  disposeBackgroundCommands(): void {
    this.toolExecutor.background.disposeAll();
  }

  disposeVectorStoreWatchers(): void {
    this.vectorStoreWatchers.forEach(d => d.dispose());
    this.vectorStoreWatchers = [];
  }

  /** Loads the site's apps and DocType names (for list_doctypes and the
   *  prompt's site summary) and caches them next to the session data. */
  private async refreshSchema(schemaPath?: string): Promise<void> {
    try {
      const schema = await this.toolExecutor.fetchSchema();
      if (!schema) return;
      this.schemaMap = { doctypes: schema.doctypes, apps: schema.apps };
      const target = schemaPath || (this.getFrappeCopilotPath() ? path.join(this.getFrappeCopilotPath()!, 'schema_index.json') : null);
      if (target) fs.writeFileSync(target, JSON.stringify(this.schemaMap, null, 2), 'utf-8');
    } catch (err) {
      console.warn('Workspace schema introspection failed:', err);
    }
  }

  private async introspectSchema(fp: string): Promise<void> {
    const schemaPath = path.join(fp, 'schema_index.json');
    if (fs.existsSync(schemaPath)) {
      try {
        const raw = fs.readFileSync(schemaPath, 'utf-8');
        this.schemaMap = JSON.parse(raw);
      } catch (err) {
        console.error('Failed to parse cached schema index:', err);
      }
    }

    await this.refreshSchema(schemaPath);
  }

}

/** A tool call from either protocol, normalized for execution. */
interface PendingToolCall {
  callId: string;
  name: string;
  args: Record<string, any>;
}

interface StreamResult {
  content: string;
  reasoning: string;
  truncated: boolean;
  toolCalls?: ToolCall[];
  thinkingBlocks?: ThinkingBlock[];
  usage?: ChatResponse['usage'];
}

/** A sub-agent that hasn't finished by now is stuck or over-scoped. */
const MAX_SUBAGENT_STEPS = 40;

const FILE_WRITE_TOOLS: ReadonlySet<string> = new Set(['write_file', 'edit_file', 'multi_edit']);

/** Groups consecutive read-only calls so they run concurrently; anything with
 *  side effects (or an approval prompt) runs alone, in order. */
function batchToolCalls(calls: PendingToolCall[]): PendingToolCall[][] {
  const batches: PendingToolCall[][] = [];
  for (const call of calls) {
    const last = batches[batches.length - 1];
    if (isParallelSafe(call) && last && isParallelSafe(last[0])) last.push(call);
    else batches.push([call]);
  }
  return batches;
}

function isParallelSafe(call: PendingToolCall): boolean {
  return READ_ONLY_TOOLS.has(call.name) || (call.name === 'task' && isParallelSafeTask(call.args));
}

/** Client-side errors (unsupported model, bad credentials, invalid request)
 *  that will fail identically on every retry. Overload/rate-limit/network
 *  errors stay retryable. */
function isPermanentError(e: any): boolean {
  const msg = String(e?.message || e);
  if (/overloaded|rate.?limit|timed? ?out|ECONNRESET|ETIMEDOUT|socket hang up|\b(429|5\d\d)\b/i.test(msg)) return false;
  return /does not support this model|or newer is required|\b(400|401|403|404)\b|invalid[_ ]request|authentication|invalid (x-)?api.?key/i.test(msg);
}

/** Heuristic for "this endpoint/model doesn't accept the tools parameter". */
function looksLikeToolsUnsupported(e: any): boolean {
  const msg = String(e?.message || e);
  return /\((400|404|422)\)/.test(msg) && /tool|function/i.test(msg) && /support|invalid|unknown|unrecognized|not allowed|extra/i.test(msg);
}
