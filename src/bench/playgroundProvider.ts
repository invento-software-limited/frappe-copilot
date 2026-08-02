import * as vscode from 'vscode';

/**
 * TreeDataProvider for the "Playground" view in the sidebar.
 * Displays actions to open interactive Bench and MariaDB REPL consoles.
 */
export class PlaygroundProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
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
      // Root level: Playground actions
      const consoleItem = new vscode.TreeItem('Open Bench Console', vscode.TreeItemCollapsibleState.None);
      consoleItem.tooltip = 'Launch an interactive Python REPL in a terminal for a site';
      consoleItem.iconPath = new vscode.ThemeIcon('terminal');
      consoleItem.command = {
        command: 'frappe-copilot.openConsole',
        title: 'Open Bench Console',
      };

      const dbItem = new vscode.TreeItem('Open MariaDB Console', vscode.TreeItemCollapsibleState.None);
      dbItem.tooltip = 'Launch an interactive SQL Database client in a terminal for a site';
      dbItem.iconPath = new vscode.ThemeIcon('database');
      dbItem.command = {
        command: 'frappe-copilot.openMariaDB',
        title: 'Open MariaDB Console',
      };

      return [consoleItem, dbItem];
    }
    return [];
  }
}
