import * as vscode from 'vscode';
import { BENCH_COMMANDS } from './commands';
import { BenchCommand } from '../types';

/**
 * TreeDataProvider for the "Bench Commands" view in the sidebar.
 * Displays a quick action to configure/update the bench, along with
 * all available bench commands organized by category.
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
      // Root level: Setup/Update action + Categories list
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

      // Retrieve unique categories and display them
      const categories = [...new Set(BENCH_COMMANDS.map((c) => c.category))];
      for (const cat of categories) {
        items.push(new BenchCategoryItem(cat));
      }

      return items;
    }

    if (element instanceof BenchCategoryItem) {
      // Leaf level: return commands belonging to the expanded category
      const category = element.category;
      const commands = BENCH_COMMANDS.filter((c) => c.category === category);
      return commands.map((c) => new BenchCommandItem(c));
    }

    return [];
  }
}

/** Tree item representing a command category. */
export class BenchCategoryItem extends vscode.TreeItem {
  constructor(public readonly category: string) {
    super(
      category.charAt(0).toUpperCase() + category.slice(1) + ' Commands',
      vscode.TreeItemCollapsibleState.Collapsed
    );
    this.iconPath = new vscode.ThemeIcon('folder');
    this.contextValue = 'benchCategory';
  }
}

/** Tree item representing a single bench command. */
export class BenchCommandItem extends vscode.TreeItem {
  constructor(public readonly commandInfo: BenchCommand) {
    super(commandInfo.name, vscode.TreeItemCollapsibleState.None);
    this.tooltip = commandInfo.description || commandInfo.name;
    this.description = commandInfo.template;
    this.iconPath = new vscode.ThemeIcon('terminal');
    this.contextValue = 'benchCommand';
    this.command = {
      command: 'frappe-copilot.executeBenchCommand',
      title: 'Execute Command',
      arguments: [commandInfo.id],
    };
  }
}
