import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { WorkspaceConfig, BenchEnvironment } from '../types';

const FRAPPE_COPILOT_DIR = '.frappe-copilot';

/** Structure of directories to create inside .frappe-copilot/ */
const REQUIRED_DIRECTORIES = [
  '',
  'sessions',
  'docs',
  'agents',
];

/**
 * Initialize the .frappe-copilot workspace directory structure.
 * Returns the root path of the .frappe-copilot folder.
 */
export function initializeWorkspaceStructure(): string | null {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
  if (!workspaceRoot) {
    vscode.window.showWarningMessage(
      'Frappe Copilot: No workspace folder open. Some features will be unavailable.'
    );
    return null;
  }

  const frappeCopilotPath = path.join(workspaceRoot, FRAPPE_COPILOT_DIR);

  // Create required directories
  for (const dir of REQUIRED_DIRECTORIES) {
    const fullPath = path.join(frappeCopilotPath, dir);
    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true });
    }
  }

  // Create default config if it doesn't exist
  const configPath = path.join(frappeCopilotPath, 'config.json');
  if (!fs.existsSync(configPath)) {
    const defaultConfig: WorkspaceConfig = {
      bench: null,
      defaultSite: '',
      opencodeZen: {
        endpoint: 'https://opencode.ai/zen/v1',
        model: 'deepseek-v4-flash-free',
        temperature: 0.7,
      },
      version: '1.0.0',
    };
    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
  }

  return frappeCopilotPath;
}

/** Get the path to the .frappe-copilot directory. */
export function getFrappeCopilotPath(): string | null {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
  if (!workspaceRoot) return null;

  const frappeCopilotPath = path.join(workspaceRoot, FRAPPE_COPILOT_DIR);
  return fs.existsSync(frappeCopilotPath) ? frappeCopilotPath : null;
}

/** Read the workspace config. */
export function readConfig(): WorkspaceConfig | null {
  const frappeCopilotPath = getFrappeCopilotPath();
  if (!frappeCopilotPath) return null;

  const configPath = path.join(frappeCopilotPath, 'config.json');
  if (!fs.existsSync(configPath)) return null;

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(raw) as WorkspaceConfig;
  } catch {
    return null;
  }
}

/** Write/update the workspace config. */
export function writeConfig(config: WorkspaceConfig): boolean {
  const frappeCopilotPath = getFrappeCopilotPath();
  if (!frappeCopilotPath) return false;

  const configPath = path.join(frappeCopilotPath, 'config.json');
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    return true;
  } catch {
    return false;
  }
}

/** Update the bench environment in config. */
export function updateBenchConfig(env: BenchEnvironment): boolean {
  const config = readConfig();
  if (!config) return false;

  config.bench = env;
  return writeConfig(config);
}

/** Check if bench is configured in the project config. */
export function isBenchConfigured(): boolean {
  const config = readConfig();
  return config?.bench !== null && config?.bench !== undefined && config.bench.type !== 'not-found';
}

/**
 * Run a setup wizard that asks the user about their bench environment.
 * Returns the BenchEnvironment, or null if the user cancels.
 */
export async function setupBenchWizard(): Promise<BenchEnvironment | null> {
  const choice = await vscode.window.showQuickPick(
    [
      { label: '$(server) Host machine', description: 'Bench is installed directly on this machine', value: 'host' },
      { label: '$(container) Docker container', description: 'Bench is inside a Frappe Docker container', value: 'docker' },
      { label: '$(circle-slash) Skip', description: 'Configure later — skip bench setup for now', value: 'skip' },
    ],
    { placeHolder: 'Where is Frappe Bench running?', ignoreFocusOut: true }
  );

  if (!choice || choice.value === 'skip') {
    return null;
  }

  if (choice.value === 'host') {
    // Try auto-detecting bench path
    let benchPath = '';
    try {
      const { execSync } = require('child_process');
      const detected = execSync('which bench', { timeout: 5000, stdio: 'pipe' }).toString().trim();
      if (detected) {
        benchPath = detected;
      }
    } catch {
      // Not auto-detected
    }

    if (benchPath) {
      vscode.window.showInformationMessage(`Bench detected at: ${benchPath}`);
    } else {
      const manualPath = await vscode.window.showInputBox({
        prompt: 'Enter the path to the bench executable',
        placeHolder: 'e.g., /usr/local/bin/bench or C:\\frappe-bench\\env\\Scripts\\bench',
        ignoreFocusOut: true,
      });
      if (!manualPath) return null;
      benchPath = manualPath;
    }

    const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || '';
    const env: BenchEnvironment = {
      type: 'host',
      benchPath,
      benchDir: wsPath ? findBenchDir(wsPath) : '',
    };
    updateBenchConfig(env);
    return env;
  }

  if (choice.value === 'docker') {
    const containers = getActiveDockerContainers();

    const items = containers.map((c) => ({
      label: `$(container) ${c.name}`,
      description: `(${c.id.slice(0, 12)})`,
      value: c.id,
      name: c.name,
    }));

    items.push({
      label: '$(pencil) Enter container name or ID manually...',
      description: 'Input a custom container name or ID',
      value: 'manual',
      name: '',
    });

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select the Docker container running Frappe Bench',
      ignoreFocusOut: true,
    });

    if (!selected) {
      return null;
    }

    let containerId = '';
    let containerName = '';

    if (selected.value === 'manual') {
      const manualId = await vscode.window.showInputBox({
        prompt: 'Enter Docker container name or ID',
        placeHolder: 'e.g., my-frappe-container or abc123def456',
        ignoreFocusOut: true,
      });
      if (!manualId) return null;
      containerId = manualId.trim();
      containerName = manualId.trim();
    } else {
      containerId = selected.value;
      containerName = selected.name;
    }

    const env: BenchEnvironment = {
      type: 'docker',
      containerId,
      containerName,
      benchDir: '/home/frappe/frappe-bench',
    };
    updateBenchConfig(env);
    return env;
  }

  return null;
}

/** Check if the current workspace looks like a Frappe bench project. */
export function isFrappeWorkspace(): boolean {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
  if (!workspaceRoot) return false;

  // Check for common Frappe bench markers
  const markers = ['apps', 'sites', 'apps.txt', 'Procfile'];
  return markers.some((marker) => {
    const fullPath = path.join(workspaceRoot, marker);
    return fs.existsSync(fullPath);
  });
}

/** Walk up the directory tree to find the nearest Frappe bench root folder. */
export function findBenchDir(startPath: string): string {
  let current = path.resolve(startPath);
  while (true) {
    const hasApps = fs.existsSync(path.join(current, 'apps'));
    const hasSites = fs.existsSync(path.join(current, 'sites'));
    const hasProcfile = fs.existsSync(path.join(current, 'Procfile'));

    if (hasApps && hasSites && hasProcfile) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return startPath;
}

/** Get a list of all active Docker containers. */
function getActiveDockerContainers(): { id: string; name: string }[] {
  try {
    const { execSync } = require('child_process');
    const output = execSync(
      'docker ps --format "{{.ID}}\\t{{.Names}}"',
      { timeout: 5000, stdio: 'pipe' }
    ).toString().trim();

    if (!output) return [];

    return output.split('\n').map((line: string) => {
      const parts = line.split('\t');
      return {
        id: parts[0],
        name: parts[1] || parts[0],
      };
    });
  } catch {
    return [];
  }
}
