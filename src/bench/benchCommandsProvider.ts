import * as vscode from 'vscode';
import { BENCH_COMMANDS } from './commands';
import { BenchCommand } from '../types';

/** IDs of frequently used commands to highlight at the top. */
const FREQUENT_COMMAND_IDS = ['clear-cache', 'migrate', 'restart', 'get-app', 'install-app'];

/**
 * TreeDataProvider for the "Bench Commands" view in the sidebar.
 * Displays a quick action to configure/update the bench, a top-level section
 * for frequently used commands, and all available bench commands organized by category.
 */
export class BenchCommandsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (!element) {
      // Root level: Setup/Update action + Frequently Used + Categories list
      const items: vscode.TreeItem[] = [];

      // Setup/Update Bench action item
      const setupItem = new vscode.TreeItem('Configure/Update Bench', vscode.TreeItemCollapsibleState.None);
      setupItem.tooltip = 'Configure or update the Frappe Bench environment path or Docker container';
      setupItem.iconPath = new vscode.ThemeIcon('settings-gear');
      setupItem.command = {
        command: 'frappe-copilot.setupBench',
        title: 'Configure Bench Environment',
      };
      items.push(setupItem);

      // Frequently Used section (expanded by default)
      items.push(new BenchFrequentCategoryItem());

      // Retrieve unique categories and display them
      const categories = [...new Set(BENCH_COMMANDS.map((c) => c.category))];
      for (const cat of categories) {
        items.push(new BenchCategoryItem(cat));
      }

      return items;
    }

    if (element instanceof BenchFrequentCategoryItem) {
      // Return frequently used commands
      const items: vscode.TreeItem[] = [];
      for (const id of FREQUENT_COMMAND_IDS) {
        const cmd = BENCH_COMMANDS.find((c) => c.id === id);
        if (cmd) {
          items.push(new BenchCommandItem(cmd, true));
        }
      }
      return items;
    }

    if (element instanceof BenchCategoryItem) {
      // Leaf level: return commands belonging to the expanded category
      const category = element.category;
      const commands = BENCH_COMMANDS.filter((c) => c.category === category);
      return commands.map((c) => new BenchCommandItem(c, false));
    }

    return [];
  }
}

/** Category icon mapping helper */
function getCategoryIcon(category: string): vscode.ThemeIcon {
  switch (category) {
    case 'init':
      return new vscode.ThemeIcon('rocket');
    case 'app':
      return new vscode.ThemeIcon('package');
    case 'site':
      return new vscode.ThemeIcon('globe');
    case 'backup':
      return new vscode.ThemeIcon('archive');
    case 'config':
      return new vscode.ThemeIcon('gear');
    case 'database':
      return new vscode.ThemeIcon('database');
    case 'doctype':
      return new vscode.ThemeIcon('symbol-class');
    case 'build':
      return new vscode.ThemeIcon('tools');
    case 'test':
      return new vscode.ThemeIcon('beaker');
    case 'scheduler':
      return new vscode.ThemeIcon('history');
    case 'translation':
      return new vscode.ThemeIcon('symbol-string');
    case 'update':
      return new vscode.ThemeIcon('cloud-download');
    case 'setup':
      return new vscode.ThemeIcon('wrench');
    case 'install':
      return new vscode.ThemeIcon('desktop-download');
    case 'network':
      return new vscode.ThemeIcon('radio-tower');
    case 'production':
      return new vscode.ThemeIcon('server');
    case 'utility':
      return new vscode.ThemeIcon('terminal');
    default:
      return new vscode.ThemeIcon('folder');
  }
}

/** Specific command icon mapping helper */
function getCommandIcon(cmd: BenchCommand, isFrequent: boolean): vscode.ThemeIcon {
  if (isFrequent) {
    switch (cmd.id) {
      case 'clear-cache':
        return new vscode.ThemeIcon('zap');
      case 'migrate':
        return new vscode.ThemeIcon('sync');
      case 'restart':
        return new vscode.ThemeIcon('refresh');
      case 'get-app':
        return new vscode.ThemeIcon('cloud-download');
      case 'install-app':
        return new vscode.ThemeIcon('plug');
    }
  }

  if (cmd.id.includes('cache')) return new vscode.ThemeIcon('zap');
  if (cmd.id.includes('database') || cmd.id.includes('mariadb') || cmd.id.includes('postgres') || cmd.id.includes('sqlite')) return new vscode.ThemeIcon('database');
  if (cmd.id.includes('console') || cmd.id.includes('jupyter')) return new vscode.ThemeIcon('terminal');
  if (cmd.id.includes('test')) return new vscode.ThemeIcon('beaker');
  if (cmd.id.includes('backup') || cmd.id.includes('restore')) return new vscode.ThemeIcon('archive');
  if (cmd.id.includes('new') || cmd.id.includes('add') || cmd.id.includes('create')) return new vscode.ThemeIcon('add');
  if (cmd.id.includes('remove') || cmd.id.includes('drop') || cmd.id.includes('uninstall')) return new vscode.ThemeIcon('trash');
  if (cmd.id.includes('list') || cmd.id.includes('show') || cmd.id.includes('find')) return new vscode.ThemeIcon('list-unordered');
  if (cmd.id.includes('password') || cmd.id.includes('perms') || cmd.id.includes('sudoers')) return new vscode.ThemeIcon('key');
  if (cmd.id.includes('build') || cmd.id.includes('watch') || cmd.id.includes('serve')) return new vscode.ThemeIcon('tools');
  if (cmd.id.includes('setup') || cmd.id.includes('config')) return new vscode.ThemeIcon('gear');
  if (cmd.id.includes('restart') || cmd.id.includes('reload')) return new vscode.ThemeIcon('refresh');
  if (cmd.id.includes('get') || cmd.id.includes('download') || cmd.id.includes('install')) return new vscode.ThemeIcon('cloud-download');

  return getCategoryIcon(cmd.category);
}

/** Tree item representing the "Frequently Used" top category. */
export class BenchFrequentCategoryItem extends vscode.TreeItem {
  constructor() {
    super('⚡ Frequently Used', vscode.TreeItemCollapsibleState.Expanded);
    this.iconPath = new vscode.ThemeIcon('zap');
    this.tooltip = 'Quick access to most commonly executed Bench commands';
    this.contextValue = 'benchFrequentCategory';
  }
}

/** Tree item representing a command category. */
export class BenchCategoryItem extends vscode.TreeItem {
  constructor(public readonly category: string) {
    super(
      category.charAt(0).toUpperCase() + category.slice(1) + ' Commands',
      vscode.TreeItemCollapsibleState.Collapsed
    );
    this.iconPath = getCategoryIcon(category);
    this.contextValue = 'benchCategory';
  }
}

/** Tree item representing a single bench command. */
export class BenchCommandItem extends vscode.TreeItem {
  constructor(
    public readonly commandInfo: BenchCommand,
    public readonly isFrequent: boolean = false
  ) {
    const title = isFrequent ? `⚡ ${commandInfo.name}` : commandInfo.name;
    super(title, vscode.TreeItemCollapsibleState.None);

    this.description = commandInfo.template;
    this.iconPath = getCommandIcon(commandInfo, isFrequent);
    this.contextValue = isFrequent ? 'benchFrequentCommand' : 'benchCommand';

    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**${commandInfo.name}**\n\n`);
    if (commandInfo.description) {
      tooltip.appendMarkdown(`${commandInfo.description}\n\n`);
    }
    tooltip.appendMarkdown(`\`${commandInfo.template}\`\n\n`);
    if (commandInfo.destructive) {
      tooltip.appendMarkdown(`⚠️ *Destructive command — prompts for confirmation*\n\n`);
    }
    if (commandInfo.requiresSite) {
      tooltip.appendMarkdown(`🌐 *Requires site selection*\n`);
    }
    this.tooltip = tooltip;

    this.command = {
      command: 'frappe-copilot.executeBenchCommand',
      title: 'Execute Command',
      arguments: [commandInfo.id],
    };
  }
}

