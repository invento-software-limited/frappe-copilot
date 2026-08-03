import * as vscode from 'vscode';
import { BenchExecutor } from './executor';
import { logChannel } from '../extension';

/**
 * WebviewViewProvider for the "Database" explorer in the sidebar.
 * Displays sites, tables, columns with search and interactive consoles.
 */
export class DatabaseWebviewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _getExecutor: () => BenchExecutor | null
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.command) {
        case 'openMariaDB': {
          await vscode.commands.executeCommand('frappe-copilot.openMariaDB');
          break;
        }
        case 'openConsole': {
          await vscode.commands.executeCommand('frappe-copilot.openConsole');
          break;
        }
        case 'fetchTables': {
          await this._handleFetchTables(data.site);
          break;
        }
        case 'fetchColumns': {
          await this._handleFetchColumns(data.site, data.table);
          break;
        }
      }
    });

    // Auto load site tables upon opening
    this._initialLoad();
  }

  public refresh(): void {
    if (this._view) {
      this._view.webview.html = this._getHtmlForWebview(this._view.webview);
      this._initialLoad();
    }
  }

  private async _initialLoad(): Promise<void> {
    const executor = this._getExecutor();
    if (!executor || !this._view) return;

    try {
      const sites = await executor.getSites();
      this._view.webview.postMessage({ command: 'setSites', sites });
      if (sites.length > 0) {
        const firstSite = sites[0].replace(/^\*\s*/, '').trim();
        await this._handleFetchTables(firstSite);
      }
    } catch {
      // ignore
    }
  }

  private async _handleFetchTables(site: string): Promise<void> {
    const executor = this._getExecutor();
    if (!executor || !this._view) return;

    const cleanSite = site.replace(/^\*\s*/, '').trim();

    try {
      const pythonCmd = `bench --site ${cleanSite} execute frappe.db.get_tables`;
      const stdout = await executor.executeSilent(pythonCmd);

      let tables: string[] = [];
      try {
        tables = JSON.parse(stdout);
      } catch {
        tables = parsePythonList(stdout);
      }

      if (Array.isArray(tables)) {
        tables.sort();
        this._view.webview.postMessage({ command: 'setTables', site: cleanSite, tables });
      }
    } catch (err: any) {
      logChannel.appendLine(`DatabaseWebviewProvider error loading tables for site "${cleanSite}": ${err.message}`);
    }
  }

  private async _handleFetchColumns(site: string, table: string): Promise<void> {
    const executor = this._getExecutor();
    if (!executor || !this._view) return;

    const cleanSite = site.replace(/^\*\s*/, '').trim();

    try {
      const pythonCmd = `bench --site ${cleanSite} execute frappe.db.get_table_columns_description --args "['${table}']"`;
      const stdout = await executor.executeSilent(pythonCmd);

      let columns: { name: string; type: string }[] = [];
      try {
        columns = JSON.parse(stdout);
      } catch {
        columns = parsePythonDictList(stdout);
      }

      if (Array.isArray(columns)) {
        this._view.webview.postMessage({ command: 'setColumns', table, columns });
      }
    } catch (err: any) {
      logChannel.appendLine(`DatabaseWebviewProvider error loading columns for "${table}": ${err.message}`);
    }
  }

  private _getHtmlForWebview(_webview: vscode.Webview): string {
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Database Explorer</title>
  <style>
    :root {
      --bg-color: var(--vscode-sideBar-background, #1e1e1e);
      --card-bg: var(--vscode-editor-background, #252526);
      --card-hover-bg: var(--vscode-list-hoverBackground, #2a2d2e);
      --border-color: var(--vscode-widget-border, rgba(255, 255, 255, 0.1));
      --text-color: var(--vscode-editor-foreground, #cccccc);
      --text-muted: var(--vscode-descriptionForeground, #888888);
      --accent-color: var(--vscode-button-background, #0e639c);
      --accent-hover: var(--vscode-button-hoverBackground, #1177bb);
      --type-varchar: #3b82f6;
      --type-int: #10b981;
      --type-date: #f59e0b;
      --type-text: #8b5cf6;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background-color: var(--bg-color);
      color: var(--text-color);
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
      font-size: var(--vscode-font-size, 12px);
      padding: 10px;
      user-select: none;
    }

    .top-bar {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-bottom: 12px;
    }

    .site-select-row {
      display: flex;
      gap: 6px;
    }

    select.site-select {
      flex: 1;
      padding: 6px 8px;
      background: var(--card-bg);
      color: var(--text-color);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      font-size: 11px;
      outline: none;
    }

    .btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      padding: 6px 10px;
      background: var(--accent-color);
      color: #ffffff;
      border: none;
      border-radius: 6px;
      font-weight: 600;
      font-size: 11px;
      cursor: pointer;
      transition: background 0.15s ease;
    }

    .btn:hover {
      background: var(--accent-hover);
    }

    .btn-row {
      display: flex;
      gap: 6px;
    }

    .btn-row .btn {
      flex: 1;
    }

    .search-box {
      width: 100%;
      padding: 7px 10px;
      background: var(--card-bg);
      color: var(--text-color);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      font-size: 11px;
      outline: none;
    }

    .search-box:focus {
      border-color: var(--accent-color);
    }

    .tables-container {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .table-item {
      background: var(--card-bg);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      overflow: hidden;
    }

    .table-header {
      padding: 8px 10px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-weight: 600;
      font-size: 11.5px;
      color: #ffffff;
      transition: background 0.15s ease;
    }

    .table-header:hover {
      background: var(--card-hover-bg);
    }

    .table-header .title {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .columns-list {
      padding: 8px 10px;
      background: rgba(0, 0, 0, 0.2);
      border-top: 1px solid var(--border-color);
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .column-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 11px;
      padding: 3px 0;
    }

    .column-name {
      font-weight: 500;
      color: var(--text-color);
    }

    .type-badge {
      font-size: 9.5px;
      font-weight: 600;
      padding: 1px 6px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.1);
      color: var(--text-muted);
      text-transform: uppercase;
    }

    .empty-state {
      text-align: center;
      padding: 20px;
      color: var(--text-muted);
      font-size: 11px;
    }

    .hidden {
      display: none !important;
    }
  </style>
</head>
<body>

  <div class="top-bar">
    <div class="site-select-row">
      <select class="site-select" id="siteSelect" onchange="onSiteChange()">
        <option value="">Loading sites...</option>
      </select>
    </div>

    <div class="btn-row">
      <button class="btn" onclick="openMariaDB()">
        <span>💻</span> MariaDB Console
      </button>
      <button class="btn" style="background: rgba(255,255,255,0.08); color: var(--text-color); border: 1px solid var(--border-color);" onclick="openConsole()">
        <span>🐍</span> Python Console
      </button>
    </div>

    <input type="text" class="search-box" id="searchInput" placeholder="🔍 Search tables..." oninput="filterTables()" />
  </div>

  <div class="tables-container" id="tablesContainer">
    <div class="empty-state">Select a site to view database tables.</div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let currentSite = '';
    let tableColumns = {};

    function openMariaDB() {
      vscode.postMessage({ command: 'openMariaDB' });
    }

    function openConsole() {
      vscode.postMessage({ command: 'openConsole' });
    }

    function onSiteChange() {
      const select = document.getElementById('siteSelect');
      currentSite = select.value;
      if (currentSite) {
        document.getElementById('tablesContainer').innerHTML = '<div class="empty-state">Loading database tables...</div>';
        vscode.postMessage({ command: 'fetchTables', site: currentSite });
      }
    }

    function toggleTable(tableName) {
      const colDiv = document.getElementById('cols-' + tableName);
      const icon = document.getElementById('arrow-' + tableName);
      if (!colDiv) return;

      if (colDiv.classList.contains('hidden')) {
        colDiv.classList.remove('hidden');
        if (icon) icon.innerText = '▼';
        if (!tableColumns[tableName]) {
          colDiv.innerHTML = '<div class="empty-state" style="padding: 6px;">Loading columns...</div>';
          vscode.postMessage({ command: 'fetchColumns', site: currentSite, table: tableName });
        }
      } else {
        colDiv.classList.add('hidden');
        if (icon) icon.innerText = '▶';
      }
    }

    function filterTables() {
      const q = document.getElementById('searchInput').value.trim().toLowerCase();
      const items = document.querySelectorAll('.table-item');
      items.forEach(item => {
        const name = item.getAttribute('data-table') || '';
        if (name.includes(q)) {
          item.classList.remove('hidden');
        } else {
          item.classList.add('hidden');
        }
      });
    }

    window.addEventListener('message', event => {
      const msg = event.data;
      switch (msg.command) {
        case 'setSites': {
          const select = document.getElementById('siteSelect');
          select.innerHTML = msg.sites.map(s => \`<option value="\${s}">🌐 \${s}</option>\`).join('');
          if (msg.sites.length > 0) {
            currentSite = msg.sites[0];
          }
          break;
        }
        case 'setTables': {
          const container = document.getElementById('tablesContainer');
          if (!msg.tables || msg.tables.length === 0) {
            container.innerHTML = '<div class="empty-state">No tables found on this site.</div>';
            return;
          }
          container.innerHTML = msg.tables.map(tbl => \`
            <div class="table-item" data-table="\${tbl.toLowerCase()}">
              <div class="table-header" onclick="toggleTable('\${tbl}')">
                <span class="title">
                  <span id="arrow-\${tbl}">▶</span>
                  <span>📊 \${tbl}</span>
                </span>
              </div>
              <div class="columns-list hidden" id="cols-\${tbl}">
              </div>
            </div>
          \`).join('');
          filterTables();
          break;
        }
        case 'setColumns': {
          tableColumns[msg.table] = msg.columns;
          const colDiv = document.getElementById('cols-' + msg.table);
          if (colDiv) {
            if (!msg.columns || msg.columns.length === 0) {
              colDiv.innerHTML = '<div class="empty-state" style="padding: 6px;">No columns found.</div>';
              return;
            }
            colDiv.innerHTML = msg.columns.map(c => \`
              <div class="column-row">
                <span class="column-name">🔹 \${escapeHtml(c.name)}</span>
                <span class="type-badge">\${escapeHtml(c.type || 'unknown')}</span>
              </div>
            \`).join('');
          }
          break;
        }
      }
    });

    function escapeHtml(str) {
      return (str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }
  </script>
</body>
</html>`;
  }
}

function parsePythonList(raw: string): string[] {
  let s = raw.trim();
  if (s.startsWith('(') && s.endsWith(')')) {
    s = '[' + s.slice(1, -1) + ']';
  }
  try {
    return JSON.parse(s);
  } catch {
    try {
      return JSON.parse(s.replace(/'/g, '"'));
    } catch {
      const matches = s.match(/["']([^"']+)["']/g) || [];
      return matches.map((m) => m.slice(1, -1));
    }
  }
}

function parsePythonDictList(raw: string): any[] {
  let s = raw.trim();
  try {
    return JSON.parse(s);
  } catch {
    try {
      let jsonStr = s
        .replace(/'/g, '"')
        .replace(/None/g, 'null')
        .replace(/True/g, 'true')
        .replace(/False/g, 'false');
      return JSON.parse(jsonStr);
    } catch {
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
