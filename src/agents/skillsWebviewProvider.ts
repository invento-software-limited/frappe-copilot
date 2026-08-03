import * as vscode from 'vscode';
import { SkillsStore, SkillMeta } from './skillsStore';

/**
 * WebviewViewProvider for the "Skills" library view in the sidebar.
 * Displays skills in a grid/list layout with search and quick actions.
 */
export class SkillsWebviewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _store: SkillsStore
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
        case 'openSkill': {
          await vscode.commands.executeCommand('frappe-copilot.openSkill', data.skillId);
          break;
        }
        case 'newSkill': {
          await vscode.commands.executeCommand('frappe-copilot.newSkill');
          break;
        }
        case 'importSkill': {
          await vscode.commands.executeCommand('frappe-copilot.importSkill');
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
    const skills = this._store.listSkills();

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Skills Library</title>
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
      --badge-builtin: #8b5cf6;
      --badge-custom: #10b981;
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

    .top-actions {
      display: flex;
      gap: 6px;
      margin-bottom: 8px;
    }

    .btn {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      padding: 7px 10px;
      background: var(--accent-color);
      color: #ffffff;
      border: none;
      border-radius: 6px;
      font-weight: 600;
      font-size: 11px;
      cursor: pointer;
      transition: background 0.15s ease, transform 0.1s ease;
    }

    .btn:hover {
      background: var(--accent-hover);
      transform: translateY(-1px);
    }

    .btn-secondary {
      background: rgba(255, 255, 255, 0.08);
      color: var(--text-color);
      border: 1px solid var(--border-color);
    }

    .btn-secondary:hover {
      background: rgba(255, 255, 255, 0.15);
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
      margin-bottom: 12px;
    }

    .search-box:focus {
      border-color: var(--accent-color);
    }

    .skills-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 8px;
    }

    .skill-card {
      background: var(--card-bg);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 10px;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      gap: 6px;
      transition: all 0.15s ease;
    }

    .skill-card:hover {
      background: var(--card-hover-bg);
      border-color: var(--accent-color);
      transform: translateY(-1px);
      box-shadow: 0 4px 10px rgba(0,0,0,0.2);
    }

    .card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
    }

    .skill-title {
      font-weight: 700;
      font-size: 12px;
      color: #ffffff;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .badge {
      font-size: 9px;
      font-weight: 700;
      padding: 2px 6px;
      border-radius: 4px;
      color: #ffffff;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }

    .badge-builtin {
      background: var(--badge-builtin);
    }

    .badge-custom {
      background: var(--badge-custom);
    }

    .skill-desc {
      font-size: 11px;
      color: var(--text-muted);
      line-height: 1.35;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
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

  <div class="top-actions">
    <button class="btn" onclick="newSkill()">
      <span>➕</span> New Skill
    </button>
    <button class="btn btn-secondary" onclick="importSkill()">
      <span>📥</span> Import
    </button>
  </div>

  <input type="text" class="search-box" id="searchInput" placeholder="🔍 Search skills..." oninput="filterSkills()" />

  <div class="skills-grid" id="skillsContainer">
    ${skills.length === 0 ? `<div class="empty-state">No skills found. Click "New Skill" to create one.</div>` : ''}
    ${skills
      .map((skill) => {
        const isBuiltin = skill.id.startsWith('builtin-') || skill.source === 'builtin';
        return `
        <div class="skill-card" data-name="${escapeHtml(skill.name.toLowerCase())}" data-desc="${escapeHtml((skill.description || '').toLowerCase())}" onclick="openSkill('${skill.id}')" title="${escapeHtml(skill.description || skill.name)}">
          <div class="card-header">
            <span class="skill-title">
              <span>🧠</span>
              <span>${escapeHtml(skill.name)}</span>
            </span>
            <span class="badge ${isBuiltin ? 'badge-builtin' : 'badge-custom'}">
              ${isBuiltin ? 'Built-in' : 'Custom'}
            </span>
          </div>
          <div class="skill-desc">
            ${escapeHtml(skill.description || 'No description provided.')}
          </div>
        </div>`;
      })
      .join('')}
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    function openSkill(id) {
      vscode.postMessage({ command: 'openSkill', skillId: id });
    }

    function newSkill() {
      vscode.postMessage({ command: 'newSkill' });
    }

    function importSkill() {
      vscode.postMessage({ command: 'importSkill' });
    }

    function filterSkills() {
      const q = document.getElementById('searchInput').value.trim().toLowerCase();
      const cards = document.querySelectorAll('.skill-card');

      cards.forEach(card => {
        const name = card.getAttribute('data-name') || '';
        const desc = card.getAttribute('data-desc') || '';
        if (name.includes(q) || desc.includes(q)) {
          card.classList.remove('hidden');
        } else {
          card.classList.add('hidden');
        }
      });
    }
  </script>
</body>
</html>`;
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
