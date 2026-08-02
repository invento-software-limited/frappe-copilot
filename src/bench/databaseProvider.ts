import * as vscode from 'vscode';
import { BenchExecutor } from './executor';
import { logChannel } from '../extension';

/**
 * TreeDataProvider for the "Database" view in the sidebar.
 * Displays sites, their database tables, and the columns (fields + types) within each table.
 */
export class DatabaseProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private getExecutor: () => BenchExecutor | null) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    const executor = this.getExecutor();
    if (!executor) {
      if (!element) {
        return [new vscode.TreeItem('Bench not configured', vscode.TreeItemCollapsibleState.None)];
      }
      return [];
    }

    if (!element) {
      // Root level: list of sites in the bench
      try {
        const sites = await executor.getSites();
        if (sites.length === 0) {
          return [new vscode.TreeItem('No sites found', vscode.TreeItemCollapsibleState.None)];
        }
        return sites.map((site) => new DatabaseSiteItem(site));
      } catch (err: any) {
        return [new vscode.TreeItem(`Error loading sites: ${err.message}`, vscode.TreeItemCollapsibleState.None)];
      }
    }

    if (element instanceof DatabaseSiteItem) {
      // Site level: list of tables in the site database
      const site = element.site;
      try {
        const pythonCmd = `bench --site ${site} execute frappe.db.get_tables`;
        const stdout = await executor.executeSilent(pythonCmd);

        let tables: string[] = [];
        try {
          tables = JSON.parse(stdout);
        } catch {
          tables = parsePythonList(stdout);
        }

        if (!Array.isArray(tables) || tables.length === 0) {
          return [new vscode.TreeItem('No tables found', vscode.TreeItemCollapsibleState.None)];
        }

        tables.sort();
        return tables.map((table) => new DatabaseTableItem(site, table));
      } catch (err: any) {
        logChannel.appendLine(`Error loading tables for site "${site}":`);
        logChannel.appendLine(err.stack || err.message || err);
        if (err.stdout) logChannel.appendLine(`Stdout: ${err.stdout}`);
        if (err.stderr) logChannel.appendLine(`Stderr: ${err.stderr}`);
        logChannel.show(true);
        return [new vscode.TreeItem(`Error loading tables: ${err.message}`, vscode.TreeItemCollapsibleState.None)];
      }
    }

    if (element instanceof DatabaseTableItem) {
      // Table level: list of columns (fields + database types) inside the table
      const { site, tableName } = element;
      try {
        // Query column details natively using frappe.db.get_table_columns_description
        const pythonCmd = `bench --site ${site} execute frappe.db.get_table_columns_description --args "['${tableName}']"`;
        const stdout = await executor.executeSilent(pythonCmd);

        let columns: { name: string; type: string }[] = [];
        try {
          columns = JSON.parse(stdout);
        } catch {
          columns = parsePythonDictList(stdout);
        }

        if (!Array.isArray(columns) || columns.length === 0) {
          return [new vscode.TreeItem('No columns found', vscode.TreeItemCollapsibleState.None)];
        }

        return columns.map((col) => new DatabaseColumnItem(col.name, col.type));
      } catch (err: any) {
        logChannel.appendLine(`Error loading columns for table "${tableName}" on site "${site}":`);
        logChannel.appendLine(err.stack || err.message || err);
        if (err.stdout) logChannel.appendLine(`Stdout: ${err.stdout}`);
        if (err.stderr) logChannel.appendLine(`Stderr: ${err.stderr}`);
        logChannel.show(true);
        return [new vscode.TreeItem(`Error loading columns: ${err.message}`, vscode.TreeItemCollapsibleState.None)];
      }
    }

    return [];
  }
}

/**
 * Parses python list representation e.g. ['item1', 'item2']
 */
function parsePythonList(raw: string): string[] {
  let s = raw.trim();

  // Handle tuple parenthesis
  if (s.startsWith('(') && s.endsWith(')')) {
    s = '[' + s.slice(1, -1) + ']';
  }

  try {
    return JSON.parse(s);
  } catch {
    try {
      const jsonStr = s.replace(/'/g, '"');
      return JSON.parse(jsonStr);
    } catch {
      // Regex extraction fallback
      const matches = s.match(/["']([^"']+)["']/g) || [];
      return matches.map((m) => m.slice(1, -1));
    }
  }
}

/**
 * Parses python list of dicts representation e.g. [{'name': 'fieldname', 'type': 'varchar'}]
 */
function parsePythonDictList(raw: string): any[] {
  let s = raw.trim();
  try {
    return JSON.parse(s);
  } catch {
    try {
      // Replace python-specific literals to json standard
      let jsonStr = s
        .replace(/'/g, '"')
        .replace(/None/g, 'null')
        .replace(/True/g, 'true')
        .replace(/False/g, 'false');
      return JSON.parse(jsonStr);
    } catch {
      // Regex parse fallback
      const results: any[] = [];
      const dictRegex = /\{[^{}]+\}/g;
      let match;
      while ((match = dictRegex.exec(s)) !== null) {
        const dictStr = match[0];
        const nameMatch = dictStr.match(/['"]name['"]:\s*['"]([^'"]+)['"]/);
        const typeMatch = dictStr.match(/['"]type['"]:\s*['"]([^'"]+)['"]/);
        if (nameMatch) {
          results.push({
            name: nameMatch[1],
            type: typeMatch ? typeMatch[1] : '',
          });
        }
      }
      return results;
    }
  }
}

/** Tree item representing a site database. */
export class DatabaseSiteItem extends vscode.TreeItem {
  constructor(public readonly site: string) {
    super(site, vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = new vscode.ThemeIcon('database');
    this.contextValue = 'databaseSite';
  }
}

/** Tree item representing a database table. */
export class DatabaseTableItem extends vscode.TreeItem {
  constructor(public readonly site: string, public readonly tableName: string) {
    super(tableName, vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = new vscode.ThemeIcon('table');
    this.contextValue = 'databaseTable';
  }
}

/** Tree item representing a database column. */
export class DatabaseColumnItem extends vscode.TreeItem {
  constructor(public readonly columnName: string, public readonly columnType: string) {
    super(columnName, vscode.TreeItemCollapsibleState.None);
    this.description = columnType;
    this.iconPath = new vscode.ThemeIcon('symbol-field');
    this.contextValue = 'databaseColumn';
  }
}
