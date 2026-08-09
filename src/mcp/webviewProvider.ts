import * as vscode from 'vscode';
import { MCPManager } from './manager';
import { McpServerConfig, McpServerStatus } from './types';

/** WebviewViewProvider for the "MCP Servers" sidebar view — add/edit/enable/
 *  reconnect MCP servers (local stdio or remote URL) and browse each
 *  connected server's tools. Mirrors the Skills/Database/Bench Commands grid
 *  views: the extension host owns all state (via MCPManager), the webview is
 *  a thin render + postMessage layer re-rendered on structural change, with a
 *  lightweight status-only push for connections that finish asynchronously
 *  (e.g. still connecting when the view first opens after activation). */
export class MCPWebviewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _manager: MCPManager
  ) {
    this._manager.setChangeListener(() => this.pushStatus());
  }

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

    webviewView.webview.html = this._getHtmlForWebview();

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.command) {
        case 'refresh':
          this.refresh();
          break;
        case 'addServer':
          await this._manager.addServer(data.config);
          this.refresh();
          break;
        case 'updateServer':
          await this._manager.updateServer(data.id, data.patch);
          this.refresh();
          break;
        case 'deleteServer':
          await this._manager.removeServer(data.id);
          this.refresh();
          break;
        case 'toggleServer':
          await this._manager.setEnabled(data.id, data.enabled);
          this.refresh();
          break;
        case 'reconnectServer':
          await this._manager.reconnectServer(data.id);
          this.refresh();
          break;
        case 'testConnection': {
          const result = await this._manager.testConnection(data.config);
          this._view?.webview.postMessage({ type: 'testResult', requestId: data.requestId, result });
          break;
        }
      }
    });
  }

  /** Full re-render — used after any structural change (add/edit/delete/toggle). */
  public refresh(): void {
    if (this._view) {
      this._view.webview.html = this._getHtmlForWebview();
    }
  }

  /** Opens the add-server form pre-set to a transport — driven by the
   *  view/title toolbar commands (frappe-copilot.addMcpServer / addMcpRemoteServer),
   *  which focus this view then call this. */
  public triggerAddForm(transport: 'stdio' | 'http'): void {
    this._view?.webview.postMessage({ type: 'openAddForm', transport });
  }

  /** Status-only update, applied in place by the webview's own JS without a
   *  full reload — covers connections that finish after the view already
   *  rendered (background connect on extension activation). */
  private pushStatus(): void {
    if (!this._view) return;
    const statuses: Record<string, { status: McpServerStatus; toolCount: number; error?: string }> = {};
    for (const s of this._manager.listServers()) statuses[s.id] = this._manager.getStatus(s.id);
    this._view.webview.postMessage({ type: 'statusUpdate', statuses });
  }

  private statusDot(status: McpServerStatus): string {
    switch (status) {
      case 'connected': return '🟢';
      case 'connecting': return '🟡';
      case 'error': return '🔴';
      default: return '⚪';
    }
  }

  /** For manual entries this doubles as the scope indicator (Global vs
   *  Workspace) rather than a flat "Manual" label — scope is the thing a
   *  user actually needs to see at a glance, since it determines which
   *  mcp.json the entry lives in and whether it follows them to other
   *  projects. */
  private sourceBadge(config: McpServerConfig): string {
    if (config.source === 'vscode') return '<span class="badge badge-vscode">VS Code</span>';
    if (config.source === 'claude') return '<span class="badge badge-claude">.mcp.json</span>';
    return config.scope === 'global'
      ? '<span class="badge badge-global">🌐 Global</span>'
      : '<span class="badge badge-manual">Workspace</span>';
  }

  private renderCard(config: McpServerConfig): string {
    const status = this._manager.getStatus(config.id);
    const tools = this._manager.getServerTools(config.id);
    const summary = config.transport === 'stdio'
      ? `${escapeHtml(config.command || '')} ${escapeHtml((config.args || []).join(' '))}`.trim()
      : escapeHtml(config.url || '');
    const isManual = config.source === 'manual';
    const configJson = escapeHtml(JSON.stringify(config));

    const toolsList = tools.length
      ? `<div class="tools-list">${tools.map(t => `<div class="tool-row"><span class="tool-name">${escapeHtml(t.name)}</span><span class="tool-desc">${escapeHtml(t.description || '')}</span></div>`).join('')}</div>`
      : '';

    return `
    <div class="server-card" data-id="${escapeHtml(config.id)}">
      <div class="card-header">
        <span class="status-dot" id="dot-${escapeHtml(config.id)}" title="${status.status}">${this.statusDot(status.status)}</span>
        <span class="server-name">${escapeHtml(config.name)}</span>
        ${this.sourceBadge(config)}
        <label class="switch" title="Enable / disable">
          <input type="checkbox" ${config.enabled ? 'checked' : ''} onchange="toggleServer('${escapeHtml(config.id)}', this.checked)">
          <span class="slider"></span>
        </label>
      </div>
      <div class="server-summary">${summary || '(not configured)'}</div>
      <div class="card-meta">
        <span class="meta-item" id="meta-${escapeHtml(config.id)}">${status.status === 'connected' ? `${status.toolCount} tool(s)` : status.status === 'error' ? `error: ${escapeHtml(status.error || '')}` : status.status}</span>
      </div>
      ${tools.length ? `<button class="link-btn" onclick="toggleTools('${escapeHtml(config.id)}')">Show tools (${tools.length})</button>${toolsList}` : ''}
      <div class="card-actions">
        <button class="btn-sm" onclick="reconnectServer('${escapeHtml(config.id)}')">🔄 Reconnect</button>
        ${isManual ? `<button class="btn-sm" onclick='openEditForm(${configJson})'>✏️ Edit</button>` : ''}
        ${isManual ? `<button class="btn-sm btn-danger" onclick="deleteServer('${escapeHtml(config.id)}', '${escapeHtml(config.name)}')">🗑️ Delete</button>` : ''}
      </div>
    </div>`;
  }

  private _getHtmlForWebview(): string {
    const servers = this._manager.listServers();

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MCP Servers</title>
<style>
  :root {
    --bg-color: var(--vscode-sideBar-background, #1e1e1e);
    --card-bg: var(--vscode-editor-background, #252526);
    --border-color: var(--vscode-widget-border, rgba(255,255,255,0.1));
    --text-color: var(--vscode-editor-foreground, #cccccc);
    --text-muted: var(--vscode-descriptionForeground, #888888);
    --accent-color: var(--vscode-button-background, #0e639c);
    --accent-hover: var(--vscode-button-hoverBackground, #1177bb);
    --danger-color: #e05561;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background-color: var(--bg-color);
    color: var(--text-color);
    font-family: var(--vscode-font-family, sans-serif);
    font-size: var(--vscode-font-size, 12px);
    padding: 10px;
  }
  .top-actions { display: flex; gap: 6px; margin-bottom: 10px; }
  .btn {
    flex: 1; display: flex; align-items: center; justify-content: center; gap: 4px;
    padding: 7px 8px; background: var(--accent-color); color: #fff; border: none;
    border-radius: 6px; font-weight: 600; font-size: 11px; cursor: pointer;
  }
  .btn:hover { background: var(--accent-hover); }
  .btn-secondary { background: rgba(255,255,255,0.08); border: 1px solid var(--border-color); color: var(--text-color); }
  .btn-sm {
    padding: 4px 8px; font-size: 10px; border-radius: 4px; border: 1px solid var(--border-color);
    background: rgba(255,255,255,0.05); color: var(--text-color); cursor: pointer;
  }
  .btn-sm:hover { background: rgba(255,255,255,0.12); }
  .btn-danger { color: var(--danger-color); border-color: var(--danger-color); }
  .server-card {
    background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 8px;
    padding: 10px; margin-bottom: 8px; display: flex; flex-direction: column; gap: 6px;
  }
  .card-header { display: flex; align-items: center; gap: 6px; }
  .server-name { font-weight: 700; font-size: 12px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badge { font-size: 9px; font-weight: 700; padding: 2px 6px; border-radius: 4px; color: #fff; text-transform: uppercase; }
  .badge-manual { background: #10b981; }
  .badge-global { background: #f59e0b; }
  .badge-vscode { background: #3b82f6; }
  .badge-claude { background: #8b5cf6; }
  .server-summary { font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; color: var(--text-muted); word-break: break-all; }
  .card-meta { font-size: 10px; color: var(--text-muted); }
  .card-actions { display: flex; gap: 6px; flex-wrap: wrap; }
  .link-btn { background: none; border: none; color: var(--accent-color); font-size: 10px; cursor: pointer; text-align: left; padding: 0; }
  .tools-list { display: flex; flex-direction: column; gap: 3px; padding: 6px; background: rgba(255,255,255,0.03); border-radius: 4px; }
  .tool-row { display: flex; flex-direction: column; }
  .tool-name { font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; font-weight: 700; }
  .tool-desc { font-size: 10px; color: var(--text-muted); }
  .switch { position: relative; display: inline-block; width: 28px; height: 16px; margin-left: auto; }
  .switch input { opacity: 0; width: 0; height: 0; }
  .slider { position: absolute; cursor: pointer; inset: 0; background: rgba(255,255,255,0.2); border-radius: 16px; transition: 0.15s; }
  .slider:before { position: absolute; content: ""; height: 12px; width: 12px; left: 2px; bottom: 2px; background: white; border-radius: 50%; transition: 0.15s; }
  input:checked + .slider { background: var(--accent-color); }
  input:checked + .slider:before { transform: translateX(12px); }
  .empty-state { text-align: center; padding: 20px; color: var(--text-muted); font-size: 11px; }
  .hint { font-size: 10px; color: var(--text-muted); margin-bottom: 10px; line-height: 1.4; }
  .form-panel { display: none; background: var(--card-bg); border: 1px solid var(--accent-color); border-radius: 8px; padding: 10px; margin-bottom: 10px; flex-direction: column; gap: 6px; }
  .form-panel.open { display: flex; }
  .form-panel label { font-size: 10px; color: var(--text-muted); margin-top: 4px; }
  .form-panel input, .form-panel textarea {
    width: 100%; padding: 6px 8px; background: var(--bg-color); color: var(--text-color);
    border: 1px solid var(--border-color); border-radius: 4px; font-size: 11px; outline: none;
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .form-panel textarea { resize: vertical; min-height: 40px; }
  .form-row { display: flex; gap: 6px; }
  .form-row > * { flex: 1; }
  .form-actions { display: flex; gap: 6px; margin-top: 6px; }
  .test-result { font-size: 10px; margin-top: 4px; }
  .test-ok { color: #10b981; }
  .test-err { color: var(--danger-color); }
</style>
</head>
<body>
  <div class="hint">Local (stdio) servers run a command you already trust on this machine. Remote servers connect over HTTP/SSE. Servers discovered from <code>.vscode/mcp.json</code> or <code>.mcp.json</code> start disabled — flip them on when you're ready to connect. Choose <b>Workspace</b> scope to keep a server specific to this project, or <b>Global</b> to make it available in every Frappe Copilot workspace (<code>~/.frappe-copilot/mcp.json</code>).</div>

  <div class="top-actions">
    <button class="btn" onclick="openAddForm('stdio')">➕ Local Server</button>
    <button class="btn btn-secondary" onclick="openAddForm('http')">🌐 Remote Server</button>
  </div>
  <div class="top-actions">
    <button class="btn btn-secondary" onclick="refreshAll()">🔄 Refresh</button>
  </div>

  <div class="form-panel" id="form-panel">
    <input type="hidden" id="f-id" value="">
    <label>Name</label>
    <input type="text" id="f-name" placeholder="e.g. Figma, Postgres">

    <label>Scope</label>
    <select id="f-scope" style="width:100%;padding:6px 8px;background:var(--bg-color);color:var(--text-color);border:1px solid var(--border-color);border-radius:4px;font-size:11px;">
      <option value="workspace">Workspace (this project only)</option>
      <option value="global">Global (every workspace)</option>
    </select>

    <label>Transport</label>
    <select id="f-transport" onchange="onTransportChange()" style="width:100%;padding:6px 8px;background:var(--bg-color);color:var(--text-color);border:1px solid var(--border-color);border-radius:4px;font-size:11px;">
      <option value="stdio">Local (stdio)</option>
      <option value="http">Remote (Streamable HTTP)</option>
      <option value="sse">Remote (SSE, legacy)</option>
    </select>

    <div id="stdio-fields">
      <label>Command</label>
      <input type="text" id="f-command" placeholder="npx">
      <label>Arguments (space-separated)</label>
      <input type="text" id="f-args" placeholder="-y @some/mcp-server">
      <label>Environment variables (KEY=value, one per line)</label>
      <textarea id="f-env" placeholder="API_KEY=..."></textarea>
    </div>

    <div id="remote-fields" style="display:none;">
      <label>URL</label>
      <input type="text" id="f-url" placeholder="https://example.com/mcp">
      <label>Headers (Key: value, one per line)</label>
      <textarea id="f-headers" placeholder="Authorization: Bearer ..."></textarea>
    </div>

    <div class="form-actions">
      <button class="btn" onclick="saveServer()">Save & Connect</button>
      <button class="btn-sm" onclick="testConnectionFromForm()">Test</button>
      <button class="btn-sm btn-secondary" onclick="closeForm()">Cancel</button>
    </div>
    <div class="test-result" id="test-result"></div>
  </div>

  <div id="servers-container">
    ${servers.length === 0 ? `<div class="empty-state">No MCP servers yet. Add a local or remote server above.</div>` : servers.map(s => this.renderCard(s)).join('')}
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let pendingTestRequestId = 0;

    function openAddForm(transport) {
      document.getElementById('f-id').value = '';
      document.getElementById('f-name').value = '';
      document.getElementById('f-scope').value = 'workspace';
      document.getElementById('f-command').value = '';
      document.getElementById('f-args').value = '';
      document.getElementById('f-env').value = '';
      document.getElementById('f-url').value = '';
      document.getElementById('f-headers').value = '';
      document.getElementById('f-transport').value = transport;
      document.getElementById('test-result').textContent = '';
      onTransportChange();
      document.getElementById('form-panel').classList.add('open');
    }

    function openEditForm(config) {
      document.getElementById('f-id').value = config.id;
      document.getElementById('f-name').value = config.name || '';
      document.getElementById('f-scope').value = config.scope || 'workspace';
      document.getElementById('f-transport').value = config.transport;
      document.getElementById('f-command').value = config.command || '';
      document.getElementById('f-args').value = (config.args || []).join(' ');
      document.getElementById('f-env').value = Object.entries(config.env || {}).map(([k,v]) => k + '=' + v).join('\\n');
      document.getElementById('f-url').value = config.url || '';
      document.getElementById('f-headers').value = Object.entries(config.headers || {}).map(([k,v]) => k + ': ' + v).join('\\n');
      document.getElementById('test-result').textContent = '';
      onTransportChange();
      document.getElementById('form-panel').classList.add('open');
    }

    function closeForm() {
      document.getElementById('form-panel').classList.remove('open');
    }

    function onTransportChange() {
      const t = document.getElementById('f-transport').value;
      document.getElementById('stdio-fields').style.display = t === 'stdio' ? 'block' : 'none';
      document.getElementById('remote-fields').style.display = t === 'stdio' ? 'none' : 'block';
    }

    function parseEnvLines(text) {
      const out = {};
      text.split('\\n').map(l => l.trim()).filter(Boolean).forEach(line => {
        const idx = line.indexOf('=');
        if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      });
      return out;
    }

    function parseHeaderLines(text) {
      const out = {};
      text.split('\\n').map(l => l.trim()).filter(Boolean).forEach(line => {
        const idx = line.indexOf(':');
        if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      });
      return out;
    }

    function buildConfigFromForm() {
      const transport = document.getElementById('f-transport').value;
      const name = document.getElementById('f-name').value.trim();
      const scope = document.getElementById('f-scope').value;
      const base = { name, transport, scope, enabled: true };
      if (transport === 'stdio') {
        const args = document.getElementById('f-args').value.trim();
        return Object.assign(base, {
          command: document.getElementById('f-command').value.trim(),
          args: args ? args.split(/\\s+/) : [],
          env: parseEnvLines(document.getElementById('f-env').value)
        });
      }
      return Object.assign(base, {
        url: document.getElementById('f-url').value.trim(),
        headers: parseHeaderLines(document.getElementById('f-headers').value)
      });
    }

    function saveServer() {
      const config = buildConfigFromForm();
      if (!config.name) { document.getElementById('test-result').innerHTML = '<span class="test-err">Name is required.</span>'; return; }
      const id = document.getElementById('f-id').value;
      if (id) {
        vscode.postMessage({ command: 'updateServer', id, patch: config });
      } else {
        vscode.postMessage({ command: 'addServer', config });
      }
      closeForm();
    }

    function testConnectionFromForm() {
      const config = buildConfigFromForm();
      const requestId = ++pendingTestRequestId;
      document.getElementById('test-result').textContent = 'Testing...';
      vscode.postMessage({ command: 'testConnection', config, requestId });
    }

    function toggleServer(id, enabled) {
      vscode.postMessage({ command: 'toggleServer', id, enabled });
    }

    function reconnectServer(id) {
      vscode.postMessage({ command: 'reconnectServer', id });
    }

    function deleteServer(id, name) {
      if (confirm('Remove MCP server "' + name + '"? This only removes it from Frappe Copilot.')) {
        vscode.postMessage({ command: 'deleteServer', id });
      }
    }

    function refreshAll() {
      vscode.postMessage({ command: 'refresh' });
    }

    function toggleTools(id) {
      const card = document.querySelector('.server-card[data-id="' + id + '"]');
      if (!card) return;
      const list = card.querySelector('.tools-list');
      if (list) list.style.display = list.style.display === 'none' ? 'flex' : 'none';
    }

    window.addEventListener('message', function(ev) {
      const m = ev.data;
      if (m.type === 'testResult' && m.requestId === pendingTestRequestId) {
        const el = document.getElementById('test-result');
        if (m.result.success) {
          el.innerHTML = '<span class="test-ok">✓ Connected — ' + m.result.toolCount + ' tool(s) found.</span>';
        } else {
          el.innerHTML = '<span class="test-err">✗ ' + (m.result.error || 'Connection failed') + '</span>';
        }
      } else if (m.type === 'openAddForm') {
        openAddForm(m.transport);
      } else if (m.type === 'statusUpdate') {
        Object.keys(m.statuses).forEach(function(id) {
          const dot = document.getElementById('dot-' + id);
          const meta = document.getElementById('meta-' + id);
          const s = m.statuses[id];
          if (dot) dot.textContent = s.status === 'connected' ? '🟢' : s.status === 'connecting' ? '🟡' : s.status === 'error' ? '🔴' : '⚪';
          if (meta) meta.textContent = s.status === 'connected' ? (s.toolCount + ' tool(s)') : s.status === 'error' ? ('error: ' + (s.error || '')) : s.status;
        });
      }
    });
  </script>
</body>
</html>`;
  }
}

function escapeHtml(str: string): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
