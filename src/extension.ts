import * as vscode from 'vscode';
import * as path from 'path';
import { DynamicProvider } from './providers/dynamic';
import { BenchDetector } from './bench/detector';
import { BenchExecutor } from './bench/executor';
import { BENCH_COMMANDS, resolveCommand, getCommandById } from './bench/commands';
import { initializeWorkspaceStructure, getFrappeCopilotPath, readConfig, updateBenchConfig, isBenchConfigured, setupBenchWizard, writeConfig } from './workspace/structure';
import { SessionManager } from './session/manager';
import { ChatPanel } from './chat/panel';
import { BenchEnvironment, BenchCommand } from './types';
import { SkillsStore } from './agents/skillsStore';
import { SkillsProvider } from './agents/skillsTreeProvider';
import { BenchCommandsProvider } from './bench/benchCommandsProvider';
import { DatabaseProvider } from './bench/databaseProvider';
import { PlaygroundProvider } from './bench/playgroundProvider';

// ─── Global log channel ───────────────────────────────────────────────────────
export const logChannel = vscode.window.createOutputChannel('Frappe Copilot');

// ─── Global state ─────────────────────────────────────────────────────────────

let provider: DynamicProvider;
let benchDetector: BenchDetector;
let benchExecutor: BenchExecutor | null = null;
let sessionManager: SessionManager | null = null;
let skillsStore: SkillsStore | null = null;
let skillsProvider: SkillsProvider | null = null;
let benchCommandsProvider: BenchCommandsProvider | null = null;
let databaseProvider: DatabaseProvider | null = null;
let playgroundProvider: PlaygroundProvider | null = null;
let chatPanel: ChatPanel | null = null;
let benchEnv: BenchEnvironment | null = null;
let statusBarItem: vscode.StatusBarItem;
let extensionPath: string = '';
let extensionContext: vscode.ExtensionContext;

// ─── Activation ───────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  console.log('Frappe Copilot is now active!');
  extensionContext = context;

  // Initialize provider with SecretStorage for API key
  provider = new DynamicProvider(context.secrets);

  // Create bench detector
  benchDetector = new BenchDetector();

  // Store extension path for later use (e.g., loading webview content)
  extensionPath = context.extensionPath;

  // Initialize workspace structure
  const frappeCopilotPath = initializeWorkspaceStructure();
  if (frappeCopilotPath) {
    sessionManager = new SessionManager(frappeCopilotPath);
    skillsStore = new SkillsStore(frappeCopilotPath, path.join(extensionPath, 'assets', 'skills'));
    skillsStore.migrateLegacyMemoryIfNeeded();
    skillsProvider = new SkillsProvider(skillsStore);
  }

  // Create status bar item (must be before any updateStatusBar calls)
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  statusBarItem.text = '$(circuit-board) Frappe Copilot';
  statusBarItem.tooltip = 'Frappe Copilot — Click to open chat';
  statusBarItem.command = 'frappe-copilot.start';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Load project-level bench config if it exists
  const config = readConfig();
  if (config?.bench && config.bench.type !== 'not-found') {
    benchEnv = config.bench;
    benchExecutor = new BenchExecutor(benchEnv);
    updateStatusBar(benchEnv.type);
  } else {
    updateStatusBar('not-configured');
  }

  // Register all commands
  registerCommands(context);

  // Register tree data providers
  if (sessionManager) {
    vscode.window.registerTreeDataProvider(
      'frappe-copilot.sessions',
      sessionManager
    );
  }
  if (skillsProvider) {
    vscode.window.registerTreeDataProvider(
      'frappe-copilot.skills',
      skillsProvider
    );
  }
  benchCommandsProvider = new BenchCommandsProvider();
  vscode.window.registerTreeDataProvider(
    'frappe-copilot.benchCommands',
    benchCommandsProvider
  );
  databaseProvider = new DatabaseProvider(() => benchExecutor);
  vscode.window.registerTreeDataProvider(
    'frappe-copilot.database',
    databaseProvider
  );

  playgroundProvider = new PlaygroundProvider();
  vscode.window.registerTreeDataProvider(
    'frappe-copilot.playground',
    playgroundProvider
  );

  // Listen for config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('frappe-copilot')) {
        provider.refreshConfig();
      }
    })
  );
}

// ─── Deactivation ─────────────────────────────────────────────────────────────

export function deactivate() {
  chatPanel?.close();
}

// ─── Command Registration ────────────────────────────────────────────────────

function registerCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('frappe-copilot.start', () => {
      openChat();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('frappe-copilot.setupBench', () => {
      runBenchSetupWizard();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('frappe-copilot.setupApiKey', () => {
      runApiKeySetup();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('frappe-copilot.newSession', () => {
      createNewSession();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('frappe-copilot.runBenchCommand', () => {
      runBenchCommand();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('frappe-copilot.showConfig', () => {
      vscode.commands.executeCommand(
        'workbench.action.openSettings',
        '@ext:frappe-copilot'
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('frappe-copilot.mentionCode', async () => {
      await mentionSelectedCode();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('frappe-copilot.switchSession', async (sessionId: string) => {
      if (sessionManager) {
        const session = sessionManager.sessions.find(s => s.id === sessionId);
        if (session) {
          sessionManager.setActiveSession(session);
          await openChat();
          if (chatPanel) {
            chatPanel.loadSession(session);
          }
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'frappe-copilot.executeBenchCommand',
      async (commandId: string) => {
        const command = getCommandById(commandId);
        if (command) {
          await promptAndExecute(command);
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('frappe-copilot.newSkill', async () => {
      await createNewSkill();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('frappe-copilot.openSkill', async (skillId: string) => {
      await openSkill(skillId);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('frappe-copilot.importSkill', async () => {
      await importSkillFromFile();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('frappe-copilot.openConsole', () => {
      openInteractiveConsole('console');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('frappe-copilot.openMariaDB', () => {
      openInteractiveConsole('mariadb');
    })
  );
}

// ─── Initial Setup Wizard ────────────────────────────────────────────────────

/**
 * Run the initial setup when the user opens the chat for the first time.
 * Guides them through:
 *   1. API Key setup (if not configured)
 *   2. Bench environment setup (if not configured)
 */
async function runInitialSetup(): Promise<boolean> {
  // Step 1: API Key
  const hasKey = await provider.hasApiKey();
  if (!hasKey) {
    const setupKey = await vscode.window.showInformationMessage(
      'Frappe Copilot needs an OpenCode Zen API key to get started.',
      { modal: true },
      'Set API Key'
    );
    if (!setupKey) return false;

    const key = await vscode.window.showInputBox({
      prompt: 'Enter your OpenCode Zen API key',
      placeHolder: 'oc-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => value.trim() ? null : 'API key cannot be empty',
    });
    if (!key) return false;

    await provider.setApiKey(key.trim());
    vscode.window.showInformationMessage('API key saved securely!');
  }

  // Step 2: Bench environment
  if (!isBenchConfigured()) {
    const setupBench = await vscode.window.showInformationMessage(
      'Configure your Frappe Bench environment to run commands directly from the chat.',
      { modal: true },
      'Setup Bench',
      'Skip for now'
    );
    if (setupBench === 'Setup Bench') {
      await runBenchSetupWizard();
    }
  }

  return true;
}

/** Standalone wizard: guide the user through bench setup. */
async function runBenchSetupWizard(): Promise<void> {
  const env = await setupBenchWizard();
  if (env) {
    benchEnv = env;
    benchExecutor = new BenchExecutor(env);
    updateStatusBar(env.type);
    if (chatPanel) {
      chatPanel.setBenchEnv(env);
    }
    databaseProvider?.refresh();
  }
}

/** Standalone wizard: guide the user through API key setup. */
async function runApiKeySetup(): Promise<void> {
  const key = await vscode.window.showInputBox({
    prompt: 'Enter your OpenCode Zen API key',
    placeHolder: 'oc-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    password: true,
    ignoreFocusOut: true,
  });
  if (key) {
    await provider.setApiKey(key.trim());
    vscode.window.showInformationMessage('API key saved securely!');
  }
}

// ─── Core Actions ────────────────────────────────────────────────────────────

/** Open the chat panel — runs initial setup first if needed. */
async function openChat() {
  if (!sessionManager) {
    const frappeCopilotPath = initializeWorkspaceStructure();
    if (!frappeCopilotPath) {
      vscode.window.showErrorMessage(
        'Frappe Copilot: Please open a workspace folder first.'
      );
      return;
    }
    sessionManager = new SessionManager(frappeCopilotPath);
    vscode.window.registerTreeDataProvider(
      'frappe-copilot.sessions',
      sessionManager
    );
  }

  // Run initial setup (API key + bench config)
  const setupOk = await runInitialSetup();
  if (!setupOk) {
    // User cancelled setup — still open the chat but with limited functionality
  }

  // Create chat panel if needed
  if (!chatPanel) {
    chatPanel = new ChatPanel(
      extensionPath,
      provider,
      sessionManager,
      benchEnv
    );
  }

  chatPanel.show();
}

/** Detect bench environment and update all services. */
async function detectBenchEnvironment(force: boolean = false): Promise<void> {
  try {
    updateStatusBar('detecting...');
    const env = await benchDetector.detect({ force });

    benchEnv = env;
    updateStatusBar(env.type);

    if (chatPanel) {
      chatPanel.setBenchEnv(env);
    }

    if (env.type !== 'not-found') {
      benchExecutor = new BenchExecutor(env);
      updateBenchConfig(env);
      databaseProvider?.refresh();
    }

    switch (env.type) {
      case 'host':
        vscode.window.showInformationMessage(
          `Frappe Copilot: Bench detected on host at ${env.benchPath}`
        );
        break;
      case 'docker':
        vscode.window.showInformationMessage(
          `Frappe Copilot: Bench detected in Docker container "${env.containerName}" (${env.containerId.slice(0, 12)})`
        );
        break;
      case 'not-found':
        vscode.window.showWarningMessage(
          `Frappe Copilot: ${env.message}`
        );
        break;
    }
  } catch (error: any) {
    vscode.window.showErrorMessage(
      `Frappe Copilot: Bench detection failed — ${error.message}`
    );
  }
}

/** Create a new session. */
async function createNewSession(): Promise<void> {
  if (!sessionManager) {
    vscode.window.showErrorMessage('Frappe Copilot: Workspace not initialized.');
    return;
  }

  const defaultName = 'New Session';
  const session = sessionManager.createSession(defaultName);
  await openChat();
  if (chatPanel) {
    chatPanel.loadSession(session);
  }
}

/** Prompt for a name + one-line description, scaffold the skill file, and open
 *  it in the native editor — skills are edited as plain markdown, not through
 *  an in-webview UI. */
async function createNewSkill(): Promise<void> {
  if (!skillsStore) {
    vscode.window.showErrorMessage('Frappe Copilot: Workspace not initialized.');
    return;
  }

  const name = await vscode.window.showInputBox({
    prompt: 'Skill name',
    placeHolder: 'e.g. Custom Print Format Boilerplate',
    ignoreFocusOut: true,
    validateInput: (v) => v.trim() ? null : 'Name cannot be empty',
  });
  if (!name) return;

  const description = await vscode.window.showInputBox({
    prompt: 'One-line description (shown to the copilot in its skills catalog)',
    placeHolder: 'e.g. Reusable script + JSON template for a custom print format',
    ignoreFocusOut: true,
  });

  const filePath = skillsStore.createSkill(name.trim(), (description || '').trim());
  skillsProvider?.refresh();
  // createSkill returns the file path; its id is the basename minus '.md'.
  chatPanel?.notifySkillCreated(path.basename(filePath, '.md'));
  const doc = await vscode.workspace.openTextDocument(filePath);
  await vscode.window.showTextDocument(doc);
}

/** Opens a skill file in the native editor from a Skills tree item click.
 *  Resolves through SkillsStore so this works for flat, bundle, and builtin skills. */
async function openSkill(skillId: string): Promise<void> {
  if (!skillsStore || !skillId) return;
  const filePath = skillsStore.resolveSkillFilePath(skillId);
  if (!filePath) {
    vscode.window.showErrorMessage(`Frappe Copilot: Could not find skill '${skillId}'.`);
    return;
  }
  try {
    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(doc);
  } catch {
    vscode.window.showErrorMessage(`Frappe Copilot: Could not open skill '${skillId}'.`);
  }
}

/** Opens a file picker for a .md or .zip skill file and imports it — a flat
 *  file for .md, a full skill bundle (SKILL.md + references/assets) for .zip. */
async function importSkillFromFile(): Promise<void> {
  if (!skillsStore) {
    vscode.window.showErrorMessage('Frappe Copilot: Workspace not initialized.');
    return;
  }

  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: 'Import Skill',
    filters: { 'Skill file': ['md', 'zip'] },
  });
  if (!picked || picked.length === 0) return;

  const filePath = picked[0].fsPath;
  const isZip = filePath.toLowerCase().endsWith('.zip');
  const result = isZip ? skillsStore.importZipFile(filePath) : skillsStore.importMarkdownFile(filePath);

  if (result.error) {
    vscode.window.showErrorMessage(`Frappe Copilot: ${result.error}`);
    return;
  }

  skillsProvider?.refresh();
  chatPanel?.notifySkillCreated(result.id!);
  vscode.window.showInformationMessage(`Frappe Copilot: Imported skill '${result.id}'.`);
}

/** Pick and execute a bench command. */
async function runBenchCommand(): Promise<void> {
  if (!benchExecutor) {
    const shouldSetup = await vscode.window.showInformationMessage(
      'Frappe Copilot: No bench environment configured. Set it up now?',
      'Setup Bench'
    );
    if (shouldSetup) {
      await runBenchSetupWizard();
      if (!benchExecutor) return;
    } else {
      return;
    }
  }

  const categories = [...new Set(BENCH_COMMANDS.map((c) => c.category))];
  const category = await vscode.window.showQuickPick(categories, {
    placeHolder: 'Select a command category',
  });
  if (!category) return;

  const commandsInCategory = BENCH_COMMANDS.filter(
    (c) => c.category === category
  );
  const picked = await vscode.window.showQuickPick(
    commandsInCategory.map((c) => ({
      label: c.name,
      description: c.description,
      detail: c.template,
      command: c,
    })),
    { placeHolder: 'Select a bench command' }
  );
  if (!picked) return;

  await promptAndExecute(picked.command);
}

/** Prompt for parameters and execute a bench command. */
async function promptAndExecute(command: BenchCommand): Promise<void> {
  if (!benchExecutor) {
    vscode.window.showErrorMessage('Frappe Copilot: Bench environment not configured.');
    return;
  }

  const values: Record<string, string> = {};

  if (command.requiresSite) {
    const config = readConfig();
    const defaultSite = config?.defaultSite || '';
    let site = '';

    let sites: string[] = [];
    try {
      sites = await benchExecutor.getSites();
    } catch {
      // ignore
    }

    if (sites.length > 0) {
      const items = sites.map((s) => ({
        label: `$(globe) ${s}`,
        value: s,
      }));
      items.push({
        label: '$(pencil) Enter site name manually...',
        value: 'manual',
      });

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: `Select site for "${command.name}"`,
        ignoreFocusOut: true,
      });

      if (!selected) return;

      if (selected.value === 'manual') {
        const manualSite = await vscode.window.showInputBox({
          prompt: `Site name for "${command.name}"`,
          placeHolder: 'e.g., site1.localhost',
          value: defaultSite,
          ignoreFocusOut: true,
        });
        if (!manualSite) return;
        site = manualSite.trim();
      } else {
        site = selected.value;
      }
    } else {
      const manualSite = await vscode.window.showInputBox({
        prompt: `Site name for "${command.name}"`,
        placeHolder: 'e.g., site1.localhost',
        value: defaultSite,
        ignoreFocusOut: true,
      });
      if (!manualSite) return;
      site = manualSite.trim();
    }

    if (site && config) {
      config.defaultSite = site;
      writeConfig(config);
    }
    values['site'] = site;
  }

  const rawPlaceholders = command.template.match(/\{([\w-]+)\}/g) || [];
  const placeholders = [...new Set(rawPlaceholders)];
  for (const ph of placeholders) {
    const key = ph.slice(1, -1);
    if (key === 'site' && command.requiresSite) continue;

    let prompt = `Value for "${key}"`;
    let placeHolder = `Enter ${key}`;
    let defaultValue = '';
    let isPassword = false;

    if (key === 'site') {
      prompt = 'New Site Name';
      placeHolder = 'e.g., site1.localhost';
    } else if (key === 'app-title') {
      prompt = 'App Title (human-readable title)';
      placeHolder = 'e.g., Library Management';
    } else if (key === 'app-description') {
      prompt = 'App Description';
      placeHolder = 'e.g., A library management app for Frappe';
      defaultValue = 'NA';
    } else if (key === 'app-publisher') {
      prompt = 'App Publisher';
      placeHolder = 'e.g., Faris';
    } else if (key === 'app-email') {
      prompt = 'App Email';
      placeHolder = 'e.g., faris@example.com';
    } else if (key === 'app-license') {
      prompt = 'App License (e.g. mit, agpl-3.0, apache-2.0, bsd-3-clause)';
      placeHolder = 'mit';
      defaultValue = 'mit';
    } else if (key === 'github-workflow') {
      prompt = 'Create GitHub Workflow action for unittests (y/N)';
      placeHolder = 'y or N';
      defaultValue = 'y';
    } else if (key === 'branch-name') {
      prompt = 'Branch Name (optional)';
      placeHolder = 'e.g., main';
      defaultValue = 'develop';
    } else if (key === 'app-name') {
      prompt = 'App Name (lowercase, snake_case folder name)';
      placeHolder = 'e.g., library_management';
    } else if (key.includes('password')) {
      isPassword = true;
    }

    const value = await vscode.window.showInputBox({
      prompt: prompt,
      placeHolder: placeHolder,
      value: defaultValue,
      password: isPassword,
      ignoreFocusOut: true,
    });
    if (value === undefined) return;
    values[key] = value;
  }

  const resolved = resolveCommand(command, values);

  if (command.destructive) {
    const confirm = await vscode.window.showWarningMessage(
      `This command is destructive:\n\n${resolved}\n\nContinue?`,
      { modal: true },
      'Yes, run it'
    );
    if (confirm !== 'Yes, run it') return;
  }

  vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: `Running: ${resolved}`,
    },
    async () => {
      const result = await benchExecutor!.execute({
        command,
        resolvedTemplate: resolved,
        site: values['site'],
      });

      if (result.success) {
        vscode.window.showInformationMessage(
          `Command succeeded: ${command.name}`
        );
      } else {
        const showOutput = await vscode.window.showErrorMessage(
          `Command failed: ${result.stderr.slice(0, 200)}`,
          'Show Output'
        );
        if (showOutput) {
          const doc = await vscode.workspace.openTextDocument({
            content: `$ ${result.command}\n\nExit code: ${result.exitCode}\n\nSTDOUT:\n${result.stdout}\n\nSTDERR:\n${result.stderr}`,
            language: 'shell',
          });
          vscode.window.showTextDocument(doc);
        }
      }
    }
  );
}

/** Get selected code from editor and insert as a mention in the active chat panel. */
async function mentionSelectedCode(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('Frappe Copilot: No active text editor found.');
    return;
  }

  const selection = editor.selection;
  const selectedText = editor.document.getText(selection);
  if (!selectedText) {
    vscode.window.showWarningMessage('Frappe Copilot: Please select some code to mention.');
    return;
  }

  // Open/reveal chat panel
  await openChat();

  if (chatPanel) {
    const document = editor.document;
    const filePath = document.uri.fsPath;
    let relativePath = vscode.workspace.asRelativePath(document.uri);
    if (relativePath === filePath && (filePath.includes('/') || filePath.includes('\\'))) {
      relativePath = filePath.split(/[/\\]/).pop() || filePath;
    }

    const startLine = selection.start.line + 1;
    const endLine = selection.end.line + 1;
    const languageId = document.languageId;
    const fileUri = document.uri.toString();

    chatPanel.insertCodeMention({
      relativePath,
      startLine,
      endLine,
      languageId,
      fileUri,
      code: selectedText
    });
  }
}

// ─── Status Bar ──────────────────────────────────────────────────────────────

function updateStatusBar(status: string): void {
  switch (status) {
    case 'host':
      statusBarItem.text = '$(circuit-board) Frappe Copilot (host)';
      statusBarItem.backgroundColor = undefined;
      break;
    case 'docker':
      statusBarItem.text = '$(circuit-board) Frappe Copilot (docker)';
      statusBarItem.backgroundColor = undefined;
      break;
    case 'not-found':
    case 'not-configured':
      statusBarItem.text = '$(warning) Frappe Copilot (no bench)';
      statusBarItem.backgroundColor = new vscode.ThemeColor(
        'statusBarItem.warningBackground'
      );
      break;
    case 'detecting...':
      statusBarItem.text = '$(sync~spin) Frappe Copilot (detecting...)';
      break;
    default:
      statusBarItem.text = '$(circuit-board) Frappe Copilot';
      break;
  }
}

/** Prompt the user to select a site and open an interactive console (bench console or bench mariadb) in a terminal. */
async function openInteractiveConsole(type: 'console' | 'mariadb'): Promise<void> {
  if (!benchExecutor) {
    vscode.window.showErrorMessage('Frappe Copilot: Bench environment not configured.');
    return;
  }

  let sites: string[] = [];
  try {
    sites = await benchExecutor.getSites();
  } catch (err: any) {
    vscode.window.showErrorMessage(`Error loading sites: ${err.message}`);
    return;
  }

  if (sites.length === 0) {
    vscode.window.showErrorMessage('No sites found in this bench.');
    return;
  }

  const selectedSite = await vscode.window.showQuickPick(sites, {
    placeHolder: `Select site to open ${type === 'console' ? 'Bench Console' : 'MariaDB Console'}`,
    ignoreFocusOut: true,
  });

  if (!selectedSite) return;

  const rawCmd = type === 'console' ? `bench --site ${selectedSite} console` : `bench --site ${selectedSite} mariadb`;
  const termName = type === 'console' ? `Bench Console (${selectedSite})` : `MariaDB Console (${selectedSite})`;
  benchExecutor.runInteractive(rawCmd, termName);
}
