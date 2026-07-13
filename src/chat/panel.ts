import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { LLMProvider } from '../providers/interface';
import { SessionManager } from '../session/manager';
import { BenchEnvironment, Session } from '../types';
import { readIntakeFile } from '../intake/fileReader';
import { ToolExecutor } from '../agents/toolExecutor';
import { SYSTEM_PROMPT } from '../agents/prompts';
import { VectorStore } from '../agents/vectorStore';
import { GraphStore } from '../agents/graphStore';

export class ChatPanel {
  public static readonly viewType = 'frappeCopilot.chat';

  private panel: vscode.WebviewPanel | null = null;
  private disposables: vscode.Disposable[] = [];
  private uploadsDir: string = '';
  private toolExecutor: ToolExecutor;
  private vectorStore: VectorStore | null = null;
  private graphStore: GraphStore | null = null;
  private schemaMap: { doctypes: string[], apps: string[] } | null = null;
  private pendingApproval: { resolve: (approved: boolean) => void } | null = null;
  private pendingClarification: { resolve: (answers: string) => void } | null = null;
  private activeModel: string = '';
  private todoList: any[] = [];
  private abortController: AbortController | null = null;
  private isRunningAgent = false;
  private aborted = false;

  constructor(
    private readonly extensionPath: string,
    private provider: LLMProvider,
    private sessionManager: SessionManager,
    private benchEnv: BenchEnvironment | null
  ) {
    const fp = this.getFrappeCopilotPath();
    if (fp) {
      this.uploadsDir = path.join(fp, 'uploads');
      this.vectorStore = new VectorStore(fp, extensionPath, provider);
      this.graphStore = new GraphStore(fp);
      this.introspectSchema(fp);
    }
    
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    this.toolExecutor = new ToolExecutor(root, benchEnv);
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
  private say(type: string, data: any) { this.panel?.webview.postMessage({ type, ...(typeof data === 'object' ? data : { status: data }) }); }
  private chat(role: string, content: string) { this.say('addMessage', { message: { role, content } }); }

  close(): void { this.panel?.dispose(); }
  insertCodeMention(mention: any): void {
    this.say('insertCodeMention', { mention });
  }
  loadSession(session: Session): void {
    this.todoList = [];
    this.say('todoListUpdated', { tasks: [] });
    const messages = this.sessionManager.readMessages(session.id);
    this.say('loadSession', {
      sessionName: session.name,
      messages: messages
    });
  }
  setBenchEnv(env: BenchEnvironment | null): void {
    this.benchEnv = env;
    this.say('benchStatus', env?.type || 'unknown');
    this.toolExecutor.setBenchEnv(env);
  }

  private getWebviewContent(): string {
    const p = path.join(this.extensionPath, 'src', 'chat', 'webview', 'chat.html');
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
        break;
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
      case 'setEndpoint':
        if (msg.endpoint && msg.endpoint.trim()) {
          const activeProviderId = vscode.workspace.getConfiguration('frappe-copilot').get<string>('provider', 'opencode-zen');
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
          let endpoint = '';
          if (msg.provider === 'openai') {
            endpoint = vscode.workspace.getConfiguration('frappe-copilot.openai').get<string>('endpoint', 'https://api.openai.com/v1');
          } else if (msg.provider === 'anthropic') {
            endpoint = vscode.workspace.getConfiguration('frappe-copilot.anthropic').get<string>('endpoint', 'https://api.anthropic.com/v1');
          } else {
            endpoint = vscode.workspace.getConfiguration('frappe-copilot.opencodeZen').get<string>('endpoint', 'https://opencode.ai/zen/v1');
          }
          this.say('settingsLoaded', {
            hasKey: !!hasKey,
            endpoint: endpoint,
            provider: msg.provider
          });
          try {
            const models = this.provider.getModels ? await this.provider.getModels() : [];
            this.say('modelsList', { models, activeModel: models[0] });
          } catch {}
          this.say('status', hasKey ? 'ready' : 'no-key');
        }
        break;
      case 'getSettings':
        const activeProviderId = vscode.workspace.getConfiguration('frappe-copilot').get<string>('provider', 'opencode-zen');
        const hasKeyVal = await (this.provider as any).hasApiKey?.();
        let currentEndpoint = '';
        if (activeProviderId === 'openai') {
          currentEndpoint = vscode.workspace.getConfiguration('frappe-copilot.openai').get<string>('endpoint', 'https://api.openai.com/v1');
        } else if (activeProviderId === 'anthropic') {
          currentEndpoint = vscode.workspace.getConfiguration('frappe-copilot.anthropic').get<string>('endpoint', 'https://api.anthropic.com/v1');
        } else {
          currentEndpoint = vscode.workspace.getConfiguration('frappe-copilot.opencodeZen').get<string>('endpoint', 'https://opencode.ai/zen/v1');
        }
        this.say('settingsLoaded', {
          hasKey: !!hasKeyVal,
          endpoint: currentEndpoint,
          provider: activeProviderId
        });
        break;
    }
  }

  private async handleSend(text: string): Promise<void> {
    if (!(await this.hasApiKey())) {
      this.chat('assistant', '⚠️ Set your API key via Command Palette → Frappe Copilot: Set API Key');
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
      this.chat('assistant', '⚠️ Set your API key first.');
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

  private async runOrchestrator(userMessage: string): Promise<void> {
    this.aborted = false;
    this.abortController = new AbortController();
    this.isRunningAgent = true;
    this.say('agentState', { state: 'running' });
    const session = this.sessionManager.activeSession || this.sessionManager.createSession('Chat');
    const isFirstMessage = session.messageCount === 0;
    this.sessionManager.appendMessage(session.id, { role: 'user', content: userMessage });

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

    const maxSteps = 10;
    let step = 0;
    let done = false;

    // 1. Initialize Visual Workflow Graph Planner
    if (this.graphStore) {
      this.graphStore.init("Workflow Executor");
      this.graphStore.addNode({
        id: "plan",
        type: "reader",
        label: "Analyzing Requirements",
        description: "Reviewing prompt context, seeding schema directory and scanning vector guides.",
        status: "running",
        progress: 30
      });
      this.say('graphUpdated', this.graphStore.get());
    }

    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

    try {
      while (!done && step < maxSteps) {
        if (this.aborted) {
          this.chat('system', '⏹️ Execution cancelled by user.');
          break;
        }
        step++;
        const history = this.sessionManager.readMessages(session.id);
        
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

        let skillsMemory = '';
        const cpPath = this.getFrappeCopilotPath();
        if (cpPath) {
          const memoryPath = path.join(cpPath, 'skills_memory.md');
          if (fs.existsSync(memoryPath)) {
            try {
              skillsMemory = `\n\n### Persistent Skills Memory\nYou have previously saved the following instructions, patterns, and code checklists. Always adhere to these custom guidelines:\n\n` + 
                             fs.readFileSync(memoryPath, 'utf-8');
            } catch (e) {
              console.error('Failed to read skills memory:', e);
            }
          }
        }

        const messages = [{ role: 'system', content: SYSTEM_PROMPT + ragContext + schemaContext + skillsMemory }, ...history];

        this.say('agentState', { state: 'running', phase: step === 1 ? 'Analyzing request...' : 'Continuing reasoning...' });

        let fullContent = '';
        try {
          fullContent = await this.stream(messages);
        } catch (e: any) {
          this.chat('error', `LLM Stream error: ${e.message || String(e)}`);
          break;
        }

        if (fullContent.trim()) {
          this.sessionManager.appendMessage(session.id, { role: 'assistant', content: fullContent });
        }

        const toolCalls = this.parseToolCalls(fullContent);
        if (toolCalls.length === 0) {
          done = true;
          break;
        }

        for (const tool of toolCalls) {
          // Tell UI we are starting tool call
          this.say('toolCallStarted', { tool: tool.name, args: tool.args });

          // 2. Add node for this step in visual graph
          const nodeId = `tool-${step}-${tool.name}`;
          if (this.graphStore) {
            this.graphStore.addNode({
              id: nodeId,
              type: "chunk",
              label: `${tool.name}`,
              description: `Args: ${Object.keys(tool.args).join(', ')}`,
              status: "running",
              progress: 50
            });
            this.graphStore.addEdge("plan", nodeId);
            this.say('graphUpdated', this.graphStore.get());
          }

          let approved = true;
          const isHighRisk = ['execute_command', 'write_file', 'edit_file'].includes(tool.name);
          if (isHighRisk) {
            this.say('toolApprovalRequired', { tool: tool.name, args: tool.args });
            approved = await this.waitForApproval(tool.name, tool.args);
          }

          let resultOutput = '';
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
            const result = await this.toolExecutor.runTool(tool.name, tool.args);
            resultOutput = result.output;

            // 3. Compile validation & Auto-healing loop
            let validationOutput = '';
            if (result.success && (tool.name === 'write_file' || tool.name === 'edit_file')) {
              const ext = path.extname(tool.args.path);
              if (ext === '.py' || ext === '.js') {
                const absPath = path.resolve(root, tool.args.path);
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

          // Append tool result as a user message (so LLM can read it in the next step)
          const resultMsg = `<tool_result name="${tool.name}">\n${resultOutput}\n</tool_result>`;
          this.sessionManager.appendMessage(session.id, { role: 'user', content: resultMsg });
        }
      }

      // Finalize visual graph
      if (this.graphStore) {
        this.graphStore.updateNode("plan", { status: "completed", progress: 100 });
        this.graphStore.get().currentState = 'completed';
        this.say('graphUpdated', this.graphStore.get());
      }
    } catch (e: any) {
      this.chat('error', `Agent execution failed: ${e.message || String(e)}`);
    } finally {
      this.isRunningAgent = false;
      this.say('agentState', { state: 'idle' });
    }
  }

  private async stream(msgs: { role: string; content: string }[]): Promise<string> {
    var full = '', fullReasoning = '', id = '' + Date.now();
    this.panel?.webview.postMessage({ type: 'startStream', messageId: id });
    try {
      const options: any = {};
      if (this.activeModel) {
        options.model = this.activeModel;
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
        this.panel?.webview.postMessage({ 
          type: 'streamChunk', 
          messageId: id, 
          chunk: c.content,
          reasoning: c.reasoning || ''
        });
      }
    } catch (e) { this.panel?.webview.postMessage({ type: 'streamError', messageId: id, error: String(e) }); throw e; }
    this.panel?.webview.postMessage({ type: 'endStream', messageId: id, fullContent: full, fullReasoning: fullReasoning });
    return full;
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
