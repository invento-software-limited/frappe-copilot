import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { LLMProvider } from '../providers/interface';
import { runClaudeOAuthFlow } from '../providers/anthropicOAuth';
import { SessionManager } from '../session/manager';
import { BenchEnvironment, Session, Message, CheckpointEntry, ImageAttachment } from '../types';
import { readIntakeFile } from '../intake/fileReader';
import { ToolExecutor } from '../agents/toolExecutor';
import { buildSystemPrompt } from '../agents/prompts';
import { AgentDefinition, ToolName } from '../agents/types';
import { AGENTS, GENERAL_AGENT } from '../agents/registry';
import { getApprovalMode, isAutoApprove, ApprovalMode } from '../agents/approvalMode';
import { ROUTER_CONTEXT_TURNS } from '../agents/router';
import { routeOrPlan, StagePlan } from '../agents/planner';
import {
  TouchedFile, VerificationOutcome, classifyTouchedFile, buildVerificationPlan,
  VERIFY_MAX_ROUNDS, VERIFY_FIX_STEP_BUDGET, migrateCmd
} from '../agents/verification';
import { VectorStore } from '../agents/vectorStore';
import { GraphStore } from '../agents/graphStore';
import { SkillsStore } from '../agents/skillsStore';
import { MCPManager } from '../mcp/manager';
import { readConfig } from '../workspace/structure';
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
const TOKEN_BUDGET_ESTIMATE = 180000;

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

export class ChatPanel {
  public static readonly viewType = 'frappeCopilot.chat';

  private panel: vscode.WebviewPanel | null = null;
  private webviewView: vscode.WebviewView | null = null;
  private disposables: vscode.Disposable[] = [];
  private uploadsDir: string = '';
  private toolExecutor: ToolExecutor;
  private vectorStore: VectorStore | null = null;
  private graphStore: GraphStore | null = null;
  private skillsStore: SkillsStore | null = null;
  /** Auto-selected skill content for the run in flight — computed once per run
   *  so the system prompt stays cache-stable across its steps. */
  private activeSkillContext = '';
  private schemaMap: { doctypes: string[], apps: string[] } | null = null;
  private pendingApproval: { resolve: (approved: boolean) => void } | null = null;
  private pendingClarification: { resolve: (answers: string) => void } | null = null;
  private pendingOAuthResolver: ((code: string) => void) | null = null;
  private activeModel: string = '';
  private todoList: any[] = [];
  private abortController: AbortController | null = null;
  private isRunningAgent = false;
  private aborted = false;

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
    const fp = this.getFrappeCopilotPath();
    if (fp) {
      this.uploadsDir = path.join(fp, 'uploads');
      this.vectorStore = new VectorStore(fp, extensionPath, provider);
      this.graphStore = new GraphStore(fp);
      this.skillsStore = new SkillsStore(fp, path.join(extensionPath, 'assets', 'skills'));
      this.skillsStore.migrateLegacyMemoryIfNeeded();
      this.introspectSchema(fp);
    }

    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    this.toolExecutor = new ToolExecutor(root, benchEnv, this.skillsStore, this.mcpManager);
  }

  show(): void {
    if (this.panel) { this.panel.reveal(vscode.ViewColumn.Beside); return; }
    this.panel = vscode.window.createWebviewPanel(
      ChatPanel.viewType, 'Frappe Copilot', vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.iconPath = vscode.Uri.file(
      path.join(this.extensionPath, 'assets', 'icon.svg')
    );
    this.panel.webview.html = this.getWebviewContent();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(async (m) => { await this.handleMsg(m); }, null, this.disposables);
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
    this.webviewView?.webview.postMessage(payload);
    this.panel?.webview.postMessage(payload);
  }
  private chat(role: string, content: string) { this.say('addMessage', { message: { role, content } }); }

  close(): void { this.panel?.dispose(); }
  insertCodeMention(mention: any): void {
    this.say('insertCodeMention', { mention });
  }
  loadSession(session: Session): void {
    this.todoList = [];
    this.say('todoListUpdated', { tasks: [] });
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
  private buildAutoSkillContext(userMessage: string): string {
    if (!this.skillsStore) return '';

    let picked: { id: string; name: string; content: string }[] = [];
    try {
      picked = this.skillsStore.suggestSkills(userMessage)
        .map(meta => ({ meta, content: this.skillsStore!.readSkill(meta.id) }))
        .filter(s => !!s.content && !s.content!.startsWith('Error:'))
        .map(s => ({ id: s.meta.id, name: s.meta.name, content: s.content! }));
    } catch (e) {
      console.error('Auto skill selection failed:', e);
      return '';
    }
    if (picked.length === 0) return '';

    for (const s of picked) {
      this.say('skillEvent', { kind: 'loaded', id: s.id, name: s.name, auto: true });
    }

    return `\n\n### Auto-Loaded Skills\nThese were selected automatically as relevant to the request — treat them as authoritative for the topics they cover, and do not call use_skill for them again:\n\n` +
      picked.map(s => `--- [Skill: ${s.id}] ---\n${s.content}`).join('\n\n');
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
        
        try {
          const models = this.provider.getModels ? await this.provider.getModels() : [];
          this.say('modelsList', { models, activeModel: this.activeModel || models[0] });
        } catch (e) {
          console.error('Failed to get models list:', e);
        }

        if (this.sessionManager.activeSession) {
          this.loadSession(this.sessionManager.activeSession);
        }
        this.say('todoListUpdated', { tasks: this.todoList });
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
        break;
      case 'toolApproved':
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
      case 'selectModel':
        this.activeModel = msg.model;
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
          this.say('apiKeyStatus', { ok: true, msg: 'Endpoint saved.' });
        }
        break;
      case 'setProvider':
        if (msg.provider) {
          await vscode.workspace.getConfiguration('frappe-copilot').update('provider', msg.provider, vscode.ConfigurationTarget.Global);
          (this.provider as any).refreshConfig?.();
          const hasKey = await (this.provider as any).hasApiKey?.();
          const endpoint = this.endpointForProvider(msg.provider);
          this.say('settingsLoaded', {
            hasKey: !!hasKey,
            endpoint: endpoint,
            provider: msg.provider,
            authMode: await this.getAuthModeSafe()
          });
          try {
            const models = this.provider.getModels ? await this.provider.getModels() : [];
            this.say('modelsList', { models, activeModel: models[0] });
          } catch {}
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

    // Extract text
    this.chat('system', '📄 Extracting text from ' + fileName + '...');
    let fileContent: string;
    try {
      const intake = await readIntakeFile(filePath);
      fileContent = intake.content;
      this.chat('system', '📖 ' + fileContent.length.toLocaleString() + ' characters extracted');
    } catch (e: any) {
      this.chat('error', 'Failed to read file: ' + e.message);
      return;
    }

    // Build the user message: file content + user prompt
    const userMsg = '**File: ' + fileName + '**\n```\n' + fileContent.slice(0, 50000) + '\n```' +
      (fileContent.length > 50000 ? '\n\n*(file truncated to 50000 chars)*' : '') +
      (userPrompt ? '\n\n**Task:** ' + userPrompt : '');

    await this.runOrchestrator(userMsg);
  }

  private async waitForApproval(tool: string, args: any): Promise<boolean> {
    this.say('agentState', { state: 'paused' });
    return new Promise((resolve) => {
      this.pendingApproval = { resolve };
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
      let firstLine = userMessage.split('\n')[0].trim();
      const mentionIdx = firstLine.indexOf('### Code Mention:');
      if (mentionIdx !== -1) {
        firstLine = firstLine.substring(0, mentionIdx).trim();
      }
      firstLine = firstLine.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
      firstLine = firstLine.replace(/[*_`#]/g, '').trim();

      let autoName = firstLine;
      if (autoName.length > 30) {
        autoName = autoName.slice(0, 30) + '...';
      }
      if (!autoName) {
        autoName = 'Session ' + (this.sessionManager.sessions.length + 1);
      }
      this.sessionManager.renameSession(session.id, autoName);
    }

    const multiAgentEnabled = vscode.workspace.getConfiguration('frappe-copilot').get<boolean>('multiAgent.enabled', false);

    try {
      if (multiAgentEnabled) {
        const recentHistory = this.sessionManager.readMessages(session.id).slice(-ROUTER_CONTEXT_TURNS);
        const route = await routeOrPlan(this.provider, userMessage, recentHistory, AGENTS);

        if (route.kind === 'plan' && route.stages && route.stages.length > 1) {
          await this.runFeaturePipeline(route.stages, session, userMessage, promptId);
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
    this.say('tokenUsage', { estimatedTokens, budget: TOKEN_BUDGET_ESTIMATE });

    const autoOffer = vscode.workspace.getConfiguration('frappe-copilot').get<boolean>('compaction.autoOffer', true);
    const thresholdTokens = vscode.workspace.getConfiguration('frappe-copilot').get<number>('compaction.thresholdTokens', DEFAULT_COMPACTION_THRESHOLD_TOKENS);
    if (autoOffer && estimatedTokens > thresholdTokens) {
      this.say('compactionOffered', { estimatedTokens, thresholdTokens });
    }
  }

  /** "Summarize and replace": one non-streaming LLM call summarizes the full
   *  raw history into session's context.md; messages.jsonl itself is never
   *  touched — only buildEffectiveHistory()'s output (what gets sent to the
   *  model going forward) shrinks. */
  private async runManualCompaction(session: Session): Promise<void> {
    const allMessages = this.sessionManager.readMessages(session.id);
    if (allMessages.length === 0) return;

    this.chat('system', '🗜️ Compacting conversation...');
    try {
      const { system, user } = buildCompactionPrompt(allMessages);
      const response = await this.provider.chat(
        [{ role: 'system', content: system }, { role: 'user', content: user }],
        { maxTokens: 1500, temperature: 0 }
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
    }
  }

  /** Runs an ordered multi-stage plan (see routeOrPlan) sequentially: each
   *  stage is a full runAgentLoop call for its specialist, chained on the same
   *  cosmetic graph (resetGraph only on the first stage) and verified before
   *  the next stage starts. Stops — rather than building further stages on a
   *  broken foundation — if a stage's verification fails or the stage was
   *  aborted/errored before completing. */
  private async runFeaturePipeline(stages: StagePlan[], session: Session, userMessage: string, promptId?: string): Promise<void> {
    const resolved = stages.map(s => ({ agent: AGENTS.find(a => a.id === s.agentId) || GENERAL_AGENT, task: s.task }));
    this.say('featurePlan', {
      stages: resolved.map(s => ({ agentId: s.agent.id, label: s.agent.label, icon: s.agent.icon, task: s.task }))
    });

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
      if (stepResult.stopLoop) break;
    }

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

    if (summaryText.trim()) {
      this.sessionManager.appendMessage(session.id, {
        role: 'assistant',
        content: summaryText,
        agentId: agent.id,
        runId,
        hasCheckpoint: checkpoint.length > 0,
        promptId: opts.promptId
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
    let ragContext = '';
    if (this.vectorStore) {
      try {
        const results = await this.vectorStore.search(userMessage, 3);
        if (results.length > 0) {
          ragContext = `\n\n### Retrieved Documentation Context\nUse the following reference snippets to guide your implementation, ensuring you adhere to correct APIs and patterns:\n\n` +
                       results.map(r => `--- [Source: ${r.source}] ---\n${r.text}`).join('\n\n');
        }
      } catch (e) {
        console.error('Failed to run vector search:', e);
      }
    }

    let schemaContext = '';
    if (this.schemaMap) {
      schemaContext = `\n\n### Active Workspace Schema Directory\nThe active site has the following properties:\n` +
                      `- Installed Apps: ${this.schemaMap.apps.join(', ')}\n` +
                      `- Active DocTypes: ${this.schemaMap.doctypes.join(', ')}\n` +
                      `Verify if DocTypes or apps exist in this directory before proposing references or creating them.`;
    }

    let skillsCatalog = '';
    if (this.skillsStore) {
      const catalog = this.skillsStore.buildCatalog();
      if (catalog) {
        skillsCatalog = `\n\n### Available Skills\nCall 'use_skill' with an id below to load its full content when relevant:\n\n${catalog}`;
      }
    }

    let mcpCatalog = '';
    if (this.mcpManager && agent.allowedTools.includes('call_mcp_tool')) {
      const catalog = this.mcpManager.buildCatalog();
      if (catalog) {
        mcpCatalog = `\n\n### Available MCP Tools\nCall 'call_mcp_tool' with the server id and tool name shown below:\n\n${catalog}`;
      }
    }

    // Static per-agent boilerplate (identity/guidelines/tool docs) vs. the
    // per-turn dynamic tail (RAG/schema/skills/MCP context) — kept as two
    // pieces so a provider that supports a cacheable-prefix split (see
    // Message.staticPrefixLength) doesn't lose its cache hit on the big
    // static part just because the dynamic part changed this turn.
    const staticSystemPart = buildSystemPrompt(agent);
    const dynamicSystemPart = ragContext + schemaContext + skillsCatalog + mcpCatalog + this.activeSkillContext;

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

    let fullContent = '';
    let fullReasoning = '';
    let truncated = false;
    try {
      const streamed = await this.stream(messages, runId);
      fullContent = streamed.content;
      fullReasoning = streamed.reasoning;
      truncated = streamed.truncated;
    } catch (e: any) {
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

    // Tool calls normally arrive in the visible reply, but with extended
    // thinking enabled the model sometimes emits the entire <tool_call> block
    // inside its thinking stream instead. That text never reached the parser
    // (stream() used to discard reasoning), so the step parsed as zero calls,
    // the run ended as "done" mid-task, and the user had to type "continue" to
    // get an already-decided tool call to actually run. Recover it here.
    let toolCalls = this.parseToolCalls(fullContent);
    let transcriptText = fullContent;
    if (toolCalls.length === 0 && fullReasoning.trim()) {
      const recovered = this.parseToolCalls(fullReasoning);
      if (recovered.length > 0) {
        toolCalls = recovered;
        // Fold the recovered calls into the assistant turn so the transcript
        // still shows the call that the tool results below it answer to.
        transcriptText = [fullContent.trim(), ...recovered.map(c => c.raw)]
          .filter(Boolean)
          .join('\n\n');
      }
    }

    if (transcriptText.trim()) {
      localHistory.push({ role: 'assistant', content: transcriptText });
    }

    if (toolCalls.length === 0) {
      // A response can get cut off by the provider's output-length limit mid
      // tool-call (e.g. while streaming a large write_file's <content>). The
      // regex parser needs a matching closing tag, so a truncated call parses
      // as zero calls — without this check that read as "the agent is done"
      // and silently dropped the in-progress work, requiring the user to type
      // "continue" to resume. Detect the dangling opening tag and loop again
      // instead of ending the run.
      // Checked across reply + thinking, since a call can be cut off in either.
      const emitted = `${fullContent}\n${fullReasoning}`;
      const openCount = (emitted.match(/<tool_call\s+name="/g) || []).length;
      const closeCount = (emitted.match(/<\/tool_call>/g) || []).length;
      if (openCount > closeCount) {
        localHistory.push({
          role: 'user',
          content: 'Your previous response was cut off by the output length limit before finishing, so no tool call was executed. Continue and re-send that tool call in full.'
        });
        return { done: false, assistantText: fullContent, stopLoop: false };
      }

      // The provider can also cut a turn off mid-*thinking* or mid-*prose*
      // reply — no dangling tool-call tag for the check above to catch, since
      // there was no tool call in progress at all. Without this, that
      // half-finished text (see ChatResponse.truncated) reads as a genuine,
      // complete answer and the run ends right there — the exact "it just
      // stops" symptom this check exists to close off.
      if (truncated) {
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
          content: 'Your previous response was cut off by the output length limit before finishing (no tool call was in progress). Continue your answer from where it left off.'
        });
        return { done: false, assistantText: fullContent, stopLoop: false };
      }
      loopState.truncatedCount = 0;

      // A model can drift into some other tool-invocation syntax instead of the
      // "<tool_call name=...>" format this app's tool loop actually parses:
      //   - its own native function-calling syntax ("<invoke name=...>
      //     <parameter name=...>"), sometimes with raw undecoded special tokens
      //     (seen in practice as a literal "DSML" placeholder, or stray "|"/"｜"
      //     pipes) spliced into the tag scaffolding — e.g.
      //     "< | DSML | parameter name=\"path\">/</ | DSML | parameter>";
      //   - an invented tag name ("<tool_check><command>ls</command>
      //     </tool_check>") or a "<tool_call>" with the name attribute dropped.
      // None of that matches parseToolCalls, so without this check it was
      // accepted as a genuine finished answer, ending the run mid-task and
      // making the user type "continue". Match loosely (words allowed to trail
      // a "<"/"</" by a few stray characters, not just immediately) and correct
      // the model instead. Scanned across reply *and* thinking, since the model
      // often makes this mistake inside a thinking block.
      const looksLikeMalformedToolCall =
        /<\s*\/?[^a-zA-Z\n]{0,6}(invoke|parameter)\b/i.test(emitted) ||
        /\bDSML\b/i.test(emitted) ||
        // Opening tag only — a bare "</tool_call>" is handled by the truncation
        // check above. The lookahead exempts *only* the exact well-formed
        // "<tool_call name=...>"; a near-miss like "<tool_use name=...>" still
        // gets flagged, since a plausible-looking name attribute doesn't make
        // an invented tag executable.
        /<\s*(?!tool_call\s+name\s*=)(tool[_-]?\w*|function[_-]?call)\b/i.test(emitted);
      if (looksLikeMalformedToolCall) {
        loopState.malformedCount++;
        if (loopState.malformedCount > MAX_CONSECUTIVE_MALFORMED_TOOL_CALLS) {
          // More retries won't fix a model/provider that can't emit the
          // expected format at all — stop and say so plainly instead of
          // spinning silently (distinct from the unbounded main loop, which
          // is fine to keep retrying real, in-progress work indefinitely).
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
    loopState.malformedCount = 0;

    for (let idx = 0; idx < toolCalls.length; idx++) {
      const tool = toolCalls[idx];
      // Tell UI we are starting tool call
      this.say('toolCallStarted', { tool: tool.name, args: tool.args });

      // Add node for this step in visual graph, nested under this run
      const nodeId = `tool-${stepLabel}-${idx}-${tool.name}`;
      if (this.graphStore) {
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

      let resultOutput = '';
      if (!agent.allowedTools.includes(tool.name as ToolName)) {
        // Hard allowlist gate — covers control-flow tools (ask_clarification,
        // update_todo_list) too, not just tools routed through ToolExecutor.
        resultOutput = `Tool '${tool.name}' is not permitted for the ${agent.label} agent. Available tools: ${agent.allowedTools.join(', ')}`;
        if (this.graphStore) {
          this.graphStore.updateNode(nodeId, { status: "failed", details: "Not in this agent's tool allowlist." });
          this.say('graphUpdated', this.graphStore.get());
        }
        this.say('toolFinished', { tool: tool.name, success: false, output: resultOutput });
      } else {
        let approved = true;
        const isHighRisk = agent.highRiskTools.includes(tool.name as ToolName) && !isAutoApprove();
        if (isHighRisk) {
          let diffPayload: { fileExisted?: boolean; diffHunks?: any[] } = {};
          if (tool.name === 'write_file' && tool.args.path) {
            const absPath = path.resolve(root, tool.args.path);
            const fileExisted = fs.existsSync(absPath);
            const oldContent = fileExisted ? (this.readFileCapped(absPath) ?? '') : '';
            diffPayload = { fileExisted, diffHunks: diffLines(oldContent, tool.args.content || '') };
          }
          this.say('toolApprovalRequired', { tool: tool.name, args: tool.args, ...diffPayload });
          approved = await this.waitForApproval(tool.name, tool.args);
        }

        if (tool.name === 'update_todo_list') {
          const tasksText = tool.args.tasks || '';
          const tasks = this.parseTodoList(tasksText);
          this.todoList = tasks;
          this.say('todoListUpdated', { tasks: this.todoList });
          resultOutput = `Todo list updated with ${tasks.length} items.`;

          if (this.graphStore) {
            this.graphStore.updateNode(nodeId, {
              status: "completed",
              progress: 100
            });
            this.say('graphUpdated', this.graphStore.get());
          }
          this.say('toolFinished', { tool: tool.name, success: true, output: resultOutput });
        } else if (tool.name === 'ask_clarification') {
          const questionsText = tool.args.questions || tool.args.question || '';
          this.say('showClarificationPopup', { questions: questionsText });
          this.say('agentState', { state: 'paused' });

          const answersText = await new Promise<string>((resolve) => {
            this.pendingClarification = { resolve };
          });

          resultOutput = answersText;

          if (this.graphStore) {
            this.graphStore.updateNode(nodeId, {
              status: "completed",
              progress: 100
            });
            this.say('graphUpdated', this.graphStore.get());
          }
          this.say('toolFinished', { tool: tool.name, success: true, output: resultOutput });
        } else if (approved) {
          this.say('toolExecuting', { tool: tool.name });

          // Before-image capture for revert — must happen before the write
          // actually executes. Captured unconditionally (even if the write
          // later fails); reverting a no-op change is harmless.
          if ((tool.name === 'write_file' || tool.name === 'edit_file') && tool.args.path) {
            const absPath = path.resolve(root, tool.args.path);
            const existedBefore = fs.existsSync(absPath);
            checkpoint.push({
              path: tool.args.path,
              existedBefore,
              originalContent: existedBefore ? (this.readFileCapped(absPath) ?? undefined) : undefined
            });
          }

          const result = await this.toolExecutor.runTool(tool.name, tool.args, agent.allowedTools);
          resultOutput = result.output;

          if (result.success && tool.name === 'use_skill' && tool.args.id) {
            const meta = this.skillsStore?.listSkills().find(s => s.id === tool.args.id);
            this.say('skillEvent', {
              kind: 'loaded',
              id: tool.args.id,
              name: meta?.name || tool.args.id,
              auto: false
            });
          }

          // Compile validation & touched-file tracking (for the end-of-run verification phase)
          let validationOutput = '';
          if (result.success && (tool.name === 'write_file' || tool.name === 'edit_file')) {
            const absPath = path.resolve(root, tool.args.path);
            touchedFiles.push(classifyTouchedFile(tool.args.path, absPath));

            const ext = path.extname(tool.args.path);
            if (ext === '.py' || ext === '.js') {
              const validateCmd = ext === '.py'
                ? `python -m py_compile "${absPath}"`
                : `node -c "${absPath}"`;

              const valResult = await this.toolExecutor.executeCommand(validateCmd);
              if (!valResult.success) {
                validationOutput = `\n\n[LINTER WARNING] File compiled with error:\n${valResult.output}`;
                this.chat('error', `⚠️ Linter warning on ${tool.args.path}: compilation check failed.`);

                if (this.graphStore) {
                  this.graphStore.updateNode(nodeId, {
                    status: "failed",
                    details: "Compilation validation failed."
                  });
                  this.say('graphUpdated', this.graphStore.get());
                }
              }
            }
          }

          resultOutput += validationOutput;

          if (this.graphStore && !validationOutput) {
            this.graphStore.updateNode(nodeId, {
              status: result.success ? "completed" : "failed",
              progress: 100
            });
            this.say('graphUpdated', this.graphStore.get());
          }

          this.say('toolFinished', { tool: tool.name, success: result.success && !validationOutput, output: resultOutput });
        } else {
          resultOutput = 'Tool execution rejected by the user.';

          if (this.graphStore) {
            this.graphStore.updateNode(nodeId, {
              status: "failed",
              details: "Rejected by user."
            });
            this.say('graphUpdated', this.graphStore.get());
          }

          this.say('toolFinished', { tool: tool.name, success: false, output: resultOutput });
        }
      }

      // Append tool result to this run's own local transcript (not the main session log)
      const resultMsg = `<tool_result name="${tool.name}">\n${resultOutput}\n</tool_result>`;
      localHistory.push({ role: 'user', content: resultMsg });
    }

    return { done: false, assistantText: fullContent, stopLoop: false };
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

    const site = readConfig()?.defaultSite;
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

      if (plan.shouldMigrate) {
        const result = await this.toolExecutor.executeCommand(migrateCmd(site));
        roundOutput += `[migrate]\n${result.output}\n`;
        if (!result.success) roundFailed = true;
      }
      if (!roundFailed) {
        for (const testCmd of plan.testCommands) {
          const result = await this.toolExecutor.executeCommand(testCmd.command(site));
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
  private async stream(msgs: { role: string; content: string }[], runId?: string): Promise<{ content: string; reasoning: string; truncated: boolean }> {
    var full = '', fullReasoning = '', truncated = false, id = '' + Date.now();
    this.postWebviewMessage({ type: 'startStream', messageId: id });
    try {
      const options: any = { maxTokens: 8192 };
      if (this.activeModel) {
        options.model = this.activeModel;
      }
      if (runId) {
        options.runId = runId;
      }
      options.onRetry = (attempt: number, delaySec: number, error: string) => {
        this.say('retryNotice', { attempt, delaySec, error });
      };
      for await (const c of this.provider.chatStream(msgs as any, options, this.abortController?.signal || undefined)) {
        if (this.aborted) {
          throw new Error('Streaming aborted by user.');
        }
        full += c.content;
        fullReasoning += c.reasoning || '';
        if (c.truncated) truncated = true;
        this.postWebviewMessage({
          type: 'streamChunk',
          messageId: id,
          chunk: c.content,
          reasoning: c.reasoning || ''
        });
      }
    } catch (e) { this.postWebviewMessage({ type: 'streamError', messageId: id, error: String(e) }); throw e; }
    this.postWebviewMessage({ type: 'endStream', messageId: id, fullContent: full, fullReasoning: fullReasoning });
    return { content: full, reasoning: fullReasoning, truncated };
  }

  private postWebviewMessage(msg: any) {
    this.webviewView?.webview.postMessage(msg);
    this.panel?.webview.postMessage(msg);
  }

  dispose(): void {
    this.panel = null;
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
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

    try {
      const { readConfig } = require('../workspace/structure');
      const config = readConfig();
      const activeSite = config?.defaultSite;
      if (!activeSite) return;

      const pythonCmd = "import frappe, json; print(json.dumps({'doctypes': frappe.get_all('DocType', pluck='name'), 'apps': frappe.get_installed_apps()}))";
      const command = `bench --site ${activeSite} execute --command "${pythonCmd.replace(/"/g, '\\"')}"`;
      
      const result = await this.toolExecutor.executeCommand(command);
      if (result.success && result.output) {
        const cleanJsonStr = result.output.replace(/^STDOUT:\s*/i, '').trim();
        const parsed = JSON.parse(cleanJsonStr);
        if (parsed.doctypes && parsed.apps) {
          this.schemaMap = parsed;
          fs.writeFileSync(schemaPath, JSON.stringify(parsed, null, 2), 'utf-8');
        }
      }
    } catch (err) {
      console.warn('Dynamic workspace schema introspect failed:', err);
    }
  }

  private parseTodoList(tasksText: string): any[] {
    const items: any[] = [];
    let currentItem: any = null;

    const lines = tasksText.split('\n');
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      const idMatch = line.match(/^-\s+id:\s*(.+)$/) || line.match(/^id:\s*(.+)$/);
      if (idMatch) {
        if (currentItem && currentItem.id && currentItem.label) {
          items.push(currentItem);
        }
        currentItem = {
          id: idMatch[1].trim(),
          label: '',
          status: 'pending'
        };
        continue;
      }

      const inlineMatch = line.match(/id:\s*([^,]+),\s*label:\s*([^,]+),\s*status:\s*(\w+)/);
      if (inlineMatch) {
        if (currentItem && currentItem.id && currentItem.label) {
          items.push(currentItem);
        }
        currentItem = {
          id: inlineMatch[1].trim(),
          label: inlineMatch[2].trim(),
          status: inlineMatch[3].trim()
        };
        continue;
      }

      if (currentItem) {
        const labelMatch = line.match(/^label:\s*(.+)$/);
        if (labelMatch) {
          currentItem.label = labelMatch[1].trim();
          continue;
        }

        const statusMatch = line.match(/^status:\s*(.+)$/);
        if (statusMatch) {
          const statusVal = statusMatch[1].trim();
          if (['pending', 'running', 'completed', 'failed'].includes(statusVal)) {
            currentItem.status = statusVal;
          }
          continue;
        }
      }
    }

    if (currentItem && currentItem.id && currentItem.label) {
      items.push(currentItem);
    }

    return items;
  }
}
