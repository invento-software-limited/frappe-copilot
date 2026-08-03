import * as vscode from 'vscode';
import { BENCH_COMMANDS } from './commands';
import { BenchCommand } from '../types';

/** IDs of frequently used commands to highlight at the top grid. */
const FREQUENT_COMMAND_IDS = ['clear-cache', 'migrate', 'restart', 'get-app', 'install-app'];

/** Category metadata (icon, description) */
const CATEGORY_META: Record<string, { title: string; icon: string }> = {
  init: { title: 'Init', icon: '🚀' },
  app: { title: 'App', icon: '📦' },
  site: { title: 'Site', icon: '🌐' },
  backup: { title: 'Backup', icon: '🗄️' },
  config: { title: 'Config', icon: '⚙️' },
  database: { title: 'Database', icon: '💾' },
  doctype: { title: 'DocType', icon: '📄' },
  build: { title: 'Build', icon: '🛠️' },
  test: { title: 'Test', icon: '🧪' },
  scheduler: { title: 'Scheduler', icon: '⏱️' },
  translation: { title: 'Translation', icon: '🗣️' },
  update: { title: 'Update', icon: '🔄' },
  setup: { title: 'Setup', icon: '🔧' },
  install: { title: 'Install', icon: '💻' },
  network: { title: 'Network', icon: '📡' },
  production: { title: 'Production', icon: '🏭' },
  utility: { title: 'Utility', icon: '⚡' },
};

/**
 * WebviewViewProvider for the "Bench Commands" grid view in the sidebar.
 */
export class BenchCommandsWebviewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;

  constructor(private readonly _extensionUri: vscode.Uri) {}

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
        case 'executeCommand': {
          await vscode.commands.executeCommand('frappe-copilot.executeBenchCommand', data.commandId);
          break;
        }
        case 'setupBench': {
          await vscode.commands.executeCommand('frappe-copilot.setupBench');
          break;
        }
      }
    });
  }

  public refresh(): void {
    if (this._view) {
      this._view.webview.html = this._getHtmlForWebview(this._view.webview);
    }
  }

  private _getHtmlForWebview(_webview: vscode.Webview): string {
    const frequentCommands = FREQUENT_COMMAND_IDS.map((id) =>
      BENCH_COMMANDS.find((c) => c.id === id)
    ).filter(Boolean) as BenchCommand[];

    const categories = [...new Set(BENCH_COMMANDS.map((c) => c.category))];

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Bench Commands</title>
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
      --badge-destructive: #f43f5e;
      --badge-site: #3b82f6;
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

    .header-bar {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-bottom: 12px;
    }

    .top-action-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 8px 12px;
      background: var(--accent-color);
      color: #ffffff;
      border: none;
      border-radius: 6px;
      font-weight: 600;
      font-size: 11px;
      cursor: pointer;
      transition: background 0.15s ease, transform 0.1s ease;
    }

    .top-action-btn:hover {
      background: var(--accent-hover);
      transform: translateY(-1px);
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

    .section-title {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-muted);
      margin: 14px 0 8px 0;
    }

    .frequent-section {
      background: linear-gradient(135deg, rgba(14, 99, 156, 0.12), rgba(88, 28, 135, 0.12));
      border: 1px solid rgba(14, 99, 156, 0.3);
      border-radius: 8px;
      padding: 10px;
      margin-bottom: 14px;
    }

    .frequent-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
      gap: 8px;
    }

    .frequent-card {
      background: var(--card-bg);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 6px;
      padding: 9px;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      gap: 4px;
      transition: all 0.15s ease;
      box-shadow: 0 2px 5px rgba(0,0,0,0.15);
    }

    .frequent-card:hover {
      background: var(--card-hover-bg);
      border-color: var(--accent-color);
      transform: translateY(-2px);
      box-shadow: 0 4px 10px rgba(0,0,0,0.25);
    }

    .frequent-card .card-head {
      display: flex;
      align-items: center;
      gap: 6px;
      font-weight: 700;
      font-size: 11.5px;
      color: #ffffff;
    }

    .frequent-card .card-head .icon {
      font-size: 14px;
    }

    .frequent-card .card-desc {
      font-size: 10px;
      color: var(--text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .category-group {
      margin-bottom: 12px;
    }

    .category-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 2px;
      cursor: pointer;
    }

    .category-header .title {
      font-size: 11px;
      font-weight: 700;
      color: var(--text-color);
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .category-header .count {
      font-size: 10px;
      color: var(--text-muted);
      background: rgba(255, 255, 255, 0.05);
      padding: 1px 6px;
      border-radius: 10px;
    }

    .command-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
      gap: 6px;
      margin-top: 6px;
    }

    .command-card {
      background: var(--card-bg);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      padding: 8px;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 4px;
      transition: all 0.15s ease;
      min-height: 54px;
    }

    .command-card:hover {
      background: var(--card-hover-bg);
      border-color: var(--accent-color);
      transform: translateY(-1px);
    }

    .command-name {
      font-weight: 600;
      font-size: 11px;
      line-height: 1.25;
      display: flex;
      align-items: flex-start;
      gap: 4px;
    }

    .command-desc {
      font-size: 9.5px;
      color: var(--text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .badges {
      display: flex;
      gap: 3px;
      margin-top: 2px;
    }

    .badge {
      font-size: 8.5px;
      font-weight: 700;
      padding: 1px 4px;
      border-radius: 3px;
      color: #ffffff;
    }

    .badge-destructive {
      background: var(--badge-destructive);
    }

    .badge-site {
      background: var(--badge-site);
    }

    .hidden {
      display: none !important;
    }
  </style>
</head>
<body>

  <div class="header-bar">
    <button class="top-action-btn" onclick="triggerSetupBench()">
      <span>⚙️</span> Configure / Update Bench
    </button>
    <input type="text" class="search-box" id="searchInput" placeholder="🔍 Search commands..." oninput="filterCommands()" />
  </div>

  <!-- FREQUENTLY USED SECTION -->
  <div class="frequent-section" id="frequentSection">
    <div class="section-title" style="margin-top: 0;">
      <span>⚡</span> FREQUENTLY USED COMMANDS
    </div>
    <div class="frequent-grid">
      ${frequentCommands
        .map((cmd) => {
          const icon = getCommandEmoji(cmd.id);
          return `
          <div class="frequent-card" onclick="executeCommand('${cmd.id}')" title="${escapeHtml(cmd.description || cmd.template)}">
            <div class="card-head">
              <span class="icon">${icon}</span>
              <span>${escapeHtml(cmd.name)}</span>
            </div>
            <div class="card-desc">${escapeHtml(cmd.template)}</div>
          </div>`;
        })
        .join('')}
    </div>
  </div>

  <!-- CATEGORIES -->
  <div id="categoriesContainer">
    ${categories
      .map((cat) => {
        const catMeta = CATEGORY_META[cat] || { title: cat, icon: '📁' };
        const commands = BENCH_COMMANDS.filter((c) => c.category === cat);
        return `
        <div class="category-group" data-category="${cat}">
          <div class="category-header">
            <span class="title">
              <span>${catMeta.icon}</span>
              <span>${catMeta.title} Commands</span>
            </span>
            <span class="count">${commands.length}</span>
          </div>
          <div class="command-grid">
            ${commands
              .map((cmd) => {
                const icon = getCommandEmoji(cmd.id);
                return `
                <div class="command-card" data-name="${escapeHtml(cmd.name.toLowerCase())}" data-template="${escapeHtml(cmd.template.toLowerCase())}" onclick="executeCommand('${cmd.id}')" title="${escapeHtml(cmd.description || cmd.name)}&#10;${escapeHtml(cmd.template)}">
                  <div>
                    <div class="command-name">
                      <span>${icon}</span>
                      <span>${escapeHtml(cmd.name)}</span>
                    </div>
                    <div class="command-desc">${escapeHtml(cmd.template)}</div>
                  </div>
                  <div class="badges">
                    ${cmd.destructive ? `<span class="badge badge-destructive">⚠️ WARN</span>` : ''}
                    ${cmd.requiresSite ? `<span class="badge badge-site">🌐 SITE</span>` : ''}
                  </div>
                </div>`;
              })
              .join('')}
          </div>
        </div>`;
      })
      .join('')}
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    function executeCommand(commandId) {
      vscode.postMessage({ command: 'executeCommand', commandId: commandId });
    }

    function triggerSetupBench() {
      vscode.postMessage({ command: 'setupBench' });
    }

    function filterCommands() {
      const q = document.getElementById('searchInput').value.trim().toLowerCase();
      const frequentSection = document.getElementById('frequentSection');
      const categoryGroups = document.querySelectorAll('.category-group');

      if (q.length > 0) {
        frequentSection.classList.add('hidden');
      } else {
        frequentSection.classList.remove('hidden');
      }

      categoryGroups.forEach(group => {
        let visibleInGroup = 0;
        const cards = group.querySelectorAll('.command-card');
        cards.forEach(card => {
          const name = card.getAttribute('data-name') || '';
          const template = card.getAttribute('data-template') || '';
          if (name.includes(q) || template.includes(q)) {
            card.classList.remove('hidden');
            visibleInGroup++;
          } else {
            card.classList.add('hidden');
          }
        });

        if (visibleInGroup > 0) {
          group.classList.remove('hidden');
        } else {
          group.classList.add('hidden');
        }
      });
    }
  </script>
</body>
</html>`;
  }
}

/** Helper to return emoji for specific command IDs */
function getCommandEmoji(id: string): string {
  switch (id) {
    case 'clear-cache':
    case 'clear-website-cache':
      return '⚡';
    case 'migrate':
      return '🔄';
    case 'restart':
      return '🔁';
    case 'get-app':
      return '📥';
    case 'install-app':
      return '🔌';
    case 'console':
    case 'database':
    case 'mariadb':
    case 'postgres':
    case 'sqlite':
      return '💻';
    case 'new-site':
    case 'new-app':
    case 'new-doctype':
      return '➕';
    case 'drop-site':
    case 'remove-app':
      return '🗑️';
    case 'backup':
    case 'backup-all-sites':
      return '📦';
    case 'restore':
      return '⏮️';
    case 'build':
    case 'watch-assets':
      return '🛠️';
    case 'run-tests':
      return '🧪';
    default:
      return '▶️';
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
