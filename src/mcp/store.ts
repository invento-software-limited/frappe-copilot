import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { McpServerConfig, McpServerScope, McpServerSource, McpStoreFile } from './types';

const MCP_FILE = 'mcp.json';
const GLOBAL_DIR = path.join(os.homedir(), '.frappe-copilot');
/** Gemini CLI / Antigravity's own global MCP config — same `mcpServers` shape
 *  as Claude's `.mcp.json`, just keyed under `~/.gemini` instead of the
 *  workspace, since that tool has no per-project variant we discover from. */
const GEMINI_MCP_FILE = path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json');

/** Raw shape of one server entry as it appears in an external config file —
 *  VS Code's `.vscode/mcp.json` ("servers") and Claude Code/Cursor/Claude
 *  Desktop's `.mcp.json` ("mcpServers") both use this same per-entry shape,
 *  just under a different top-level key. */
interface RawServerEntry {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

/** Persists user-added MCP servers to .frappe-copilot/mcp.json, and discovers
 *  (read-only, never written back) servers already configured for this
 *  workspace in the IDE's own MCP config files. Mirrors SkillsStore's
 *  file-backed, defensively-parsed style. */
export class MCPStore {
  constructor(
    private frappeCopilotPath: string,
    private workspaceRoot: string
  ) {}

  private get filePath(): string {
    return path.join(this.frappeCopilotPath, MCP_FILE);
  }

  private get globalFilePath(): string {
    return path.join(GLOBAL_DIR, MCP_FILE);
  }

  private slugify(name: string): string {
    const slug = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return slug || `server-${Date.now().toString(36)}`;
  }

  private readManualFile(filePath: string, scope: McpServerScope): McpServerConfig[] {
    if (!fs.existsSync(filePath)) return [];
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as McpStoreFile;
      const servers = Array.isArray(parsed.servers) ? parsed.servers : [];
      // Tag with which file this came from, unless the entry already claims
      // a scope explicitly (shouldn't normally happen — persisted entries
      // never carry 'scope', it's stripped on write — but respected if set).
      return servers.map(s => ({ ...s, scope: s.scope || scope }));
    } catch {
      return [];
    }
  }

  /** Manual entries from both stores: the workspace-local
   *  '.frappe-copilot/mcp.json' (project-specific servers) and the global
   *  '~/.frappe-copilot/mcp.json' (servers available to every workspace this
   *  extension runs in — e.g. a personal server you don't want to redeclare
   *  per project). An id present in both is resolved in favor of the
   *  workspace copy, since that's the more specific override. */
  private readManual(): McpServerConfig[] {
    const workspace = this.readManualFile(this.filePath, 'workspace');
    const global = this.readManualFile(this.globalFilePath, 'global');
    const workspaceIds = new Set(workspace.map(s => s.id));
    return [...workspace, ...global.filter(s => !workspaceIds.has(s.id))];
  }

  private writeManualFile(filePath: string, dir: string, servers: McpServerConfig[]): boolean {
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify({ servers } satisfies McpStoreFile, null, 2));
      return true;
    } catch {
      return false;
    }
  }

  /** Splits the full desired manual list by each entry's own scope and
   *  writes each half to its file — 'scope' itself is never persisted (kept
   *  out of the JSON so files stay identical in shape to before this field
   *  existed); which file an entry lives in *is* its scope on the next read. */
  private writeManual(servers: McpServerConfig[]): boolean {
    const strip = (s: McpServerConfig): McpServerConfig => {
      const { scope, ...rest } = s;
      return rest as McpServerConfig;
    };
    const workspaceServers = servers.filter(s => (s.scope || 'workspace') === 'workspace').map(strip);
    const globalServers = servers.filter(s => s.scope === 'global').map(strip);
    const wroteWorkspace = this.writeManualFile(this.filePath, this.frappeCopilotPath, workspaceServers);
    const wroteGlobal = this.writeManualFile(this.globalFilePath, GLOBAL_DIR, globalServers);
    return wroteWorkspace && wroteGlobal;
  }

  /** One external config file's server map, normalized into McpServerConfig
   *  entries namespaced by `source` so ids never collide with a manual entry
   *  or another discovered source of the same server name. Never throws —
   *  a missing or malformed file just yields no entries. */
  private discoverFrom(filePath: string, topLevelKey: string, source: McpServerSource): McpServerConfig[] {
    if (!fs.existsSync(filePath)) return [];
    let parsed: any;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      return [];
    }
    const entries: Record<string, RawServerEntry> = parsed?.[topLevelKey] || {};
    if (!entries || typeof entries !== 'object') return [];

    const out: McpServerConfig[] = [];
    for (const [name, entry] of Object.entries(entries)) {
      if (!entry || typeof entry !== 'object') continue;
      const id = `${source}:${this.slugify(name)}`;
      if (entry.url) {
        out.push({
          id, name, source, enabled: false,
          transport: entry.type === 'sse' ? 'sse' : 'http',
          url: entry.url,
          headers: entry.headers,
        });
      } else if (entry.command) {
        out.push({
          id, name, source, enabled: false,
          transport: 'stdio',
          command: entry.command,
          args: entry.args,
          env: entry.env,
          cwd: entry.cwd,
        });
      }
      // Entries with neither url nor command (e.g. VS Code's extension-contributed
      // or input-only definitions) aren't something we can connect to — skip.
    }
    return out;
  }

  /** Discovered, read-only entries from the IDE's own MCP config files —
   *  VS Code's `.vscode/mcp.json` and the Claude Code/Cursor-style project
   *  `.mcp.json` at the workspace root, plus Gemini CLI/Antigravity's global
   *  `~/.gemini/config/mcp_config.json`. All default to disabled; the user
   *  opts each one in from the MCP Servers view. */
  private discoverExternal(): McpServerConfig[] {
    return [
      ...this.discoverFrom(path.join(this.workspaceRoot, '.vscode', 'mcp.json'), 'servers', 'vscode'),
      ...this.discoverFrom(path.join(this.workspaceRoot, '.mcp.json'), 'mcpServers', 'claude'),
      ...this.discoverFrom(GEMINI_MCP_FILE, 'mcpServers', 'gemini'),
    ];
  }

  /** Full catalog: manual entries first, then anything discovered that isn't
   *  already present (by id) — so re-enabling a previously-toggled discovered
   *  server doesn't get shadowed by a stale re-discovery. Manual entries are
   *  the source of truth for their own enabled/edited state; discovered ones
   *  are re-read fresh every call so external config edits show up live. */
  listServers(): McpServerConfig[] {
    const manual = this.readManual();
    const manualIds = new Set(manual.map(s => s.id));
    const discovered = this.discoverExternal().filter(s => !manualIds.has(s.id));
    return [...manual, ...discovered];
  }

  getServer(id: string): McpServerConfig | undefined {
    return this.listServers().find(s => s.id === id);
  }

  /** Adds a manually-configured server, or promotes a discovered one to a
   *  manual entry the user can then edit/toggle (called by setEnabled/update
   *  when the target id isn't in the manual store yet). Defaults to
   *  workspace scope when the caller doesn't specify one, matching the
   *  original (pre-scope) behavior. */
  addServer(config: Omit<McpServerConfig, 'id' | 'source'> & { id?: string }): McpServerConfig {
    const manual = this.readManual();
    const id = config.id || `manual:${this.slugify(config.name)}`;
    const withoutDup = manual.filter(s => s.id !== id);
    const saved: McpServerConfig = { ...config, id, source: 'manual', scope: config.scope || 'workspace' };
    this.writeManual([...withoutDup, saved]);
    return saved;
  }

  /** Updates a manual server, or — if `id` currently only exists as a
   *  discovered (read-only) entry — materializes it into the manual store
   *  first so the edit has somewhere to persist. A patch that changes
   *  `scope` moves the entry to the other file on this write, since
   *  writeManual re-splits the whole list by each entry's current scope. */
  updateServer(id: string, patch: Partial<McpServerConfig>): McpServerConfig | null {
    const manual = this.readManual();
    const idx = manual.findIndex(s => s.id === id);
    if (idx !== -1) {
      const updated = { ...manual[idx], ...patch, id, source: 'manual' as const, scope: patch.scope || manual[idx].scope || 'workspace' };
      manual[idx] = updated;
      this.writeManual(manual);
      return updated;
    }
    const discovered = this.discoverExternal().find(s => s.id === id);
    if (!discovered) return null;
    const promoted: McpServerConfig = { ...discovered, ...patch, id, source: 'manual', scope: patch.scope || 'workspace' };
    this.writeManual([...manual, promoted]);
    return promoted;
  }

  setEnabled(id: string, enabled: boolean): McpServerConfig | null {
    return this.updateServer(id, { enabled });
  }

  /** Only ever removes from the manual store — a discovered entry can't be
   *  deleted (it lives in a file this extension doesn't own), only disabled. */
  removeServer(id: string): boolean {
    const manual = this.readManual();
    const filtered = manual.filter(s => s.id !== id);
    if (filtered.length === manual.length) return false;
    return this.writeManual(filtered);
  }
}
