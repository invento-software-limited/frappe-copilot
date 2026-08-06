import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { MCPStore } from './store';
import { McpServerConfig, McpServerRuntimeState, McpToolInfo } from './types';

/** Shape-compatible with ToolExecutor's ToolResult, without importing it —
 *  avoids a manager <-> toolExecutor circular import for what's really just
 *  a structural match. */
interface CallResult {
  success: boolean;
  output: string;
}

interface LiveConnection {
  client: Client;
  tools: McpToolInfo[];
}

/** Owns every live MCP server connection for the workspace: connects enabled
 *  servers, keeps their tools/list cache fresh, dispatches call_mcp_tool, and
 *  reports status for the sidebar view. One instance lives for the whole
 *  extension session (see extension.ts) — never construct a second one, since
 *  each connection is a real child process or socket, not a cheap file read
 *  like SkillsStore. */
export class MCPManager {
  private store: MCPStore;
  private connections = new Map<string, LiveConnection>();
  private statuses = new Map<string, McpServerRuntimeState>();
  private onChange?: () => void;

  constructor(frappeCopilotPath: string, workspaceRoot: string, private extensionVersion: string = '0.0.0') {
    this.store = new MCPStore(frappeCopilotPath, workspaceRoot);
  }

  /** Lets extension.ts refresh the sidebar view whenever a connection's
   *  status changes, without the view having to poll. */
  setChangeListener(cb: () => void): void {
    this.onChange = cb;
  }

  private notify(): void {
    try { this.onChange?.(); } catch { /* a listener error must never break a connect/disconnect */ }
  }

  // ─── Read access ────────────────────────────────────────────────────────

  listServers(): McpServerConfig[] {
    return this.store.listServers();
  }

  getStatus(id: string): McpServerRuntimeState {
    return this.statuses.get(id) || { status: 'disabled', toolCount: 0 };
  }

  getServerTools(id: string): McpToolInfo[] {
    return this.connections.get(id)?.tools || [];
  }

  /** Every tool from every currently-connected server — what call_mcp_tool
   *  can actually reach right now. */
  listAllTools(): McpToolInfo[] {
    return this.listServers().flatMap(s => this.getServerTools(s.id));
  }

  /** Small always-injected catalog for the system prompt, grouped by server —
   *  same "cheap always-on listing, full detail on demand" shape as
   *  SkillsStore.buildCatalog(). call_mcp_tool's own inputSchema per tool is
   *  intentionally omitted here to keep this cheap; the model can infer
   *  common param shapes from the description, and a malformed 'arguments'
   *  JSON comes back as a clear tool-result error it can correct from. */
  buildCatalog(): string {
    const servers = this.listServers().filter(s => this.getStatus(s.id).status === 'connected');
    if (servers.length === 0) return '';

    return servers.map(s => {
      const tools = this.getServerTools(s.id);
      const lines = tools.map(t => `  - ${t.name}: ${t.description || '(no description)'}`).join('\n');
      return `- Server "${s.id}" (${s.name}):\n${lines}`;
    }).join('\n');
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  /** Connects every enabled server. Each connection is independent — one
   *  hung stdio command or unreachable URL must never block the others or
   *  delay extension activation, so failures are swallowed per-server (the
   *  status map is where the failure actually surfaces). */
  async initialize(): Promise<void> {
    const enabled = this.store.listServers().filter(s => s.enabled);
    await Promise.allSettled(enabled.map(s => this.connectServer(s.id)));
  }

  private async closeConnection(id: string): Promise<void> {
    const existing = this.connections.get(id);
    this.connections.delete(id);
    if (existing) {
      try { await existing.client.close(); } catch { /* already gone */ }
    }
  }

  async connectServer(id: string): Promise<void> {
    const config = this.store.getServer(id);
    if (!config) return;
    await this.closeConnection(id);

    this.statuses.set(id, { status: 'connecting', toolCount: 0 });
    this.notify();

    try {
      const transport = this.buildTransport(config);
      const client = new Client({ name: 'frappe-copilot', version: this.extensionVersion }, { capabilities: {} });
      await client.connect(transport);
      const { tools } = await client.listTools();
      const toolInfos: McpToolInfo[] = tools.map(t => ({
        serverId: id,
        serverName: config.name,
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as McpToolInfo['inputSchema'],
      }));
      this.connections.set(id, { client, tools: toolInfos });
      this.statuses.set(id, { status: 'connected', toolCount: toolInfos.length });
    } catch (e: any) {
      this.statuses.set(id, { status: 'error', error: e?.message || String(e), toolCount: 0 });
    }
    this.notify();
  }

  async disconnectServer(id: string): Promise<void> {
    await this.closeConnection(id);
    this.statuses.set(id, { status: 'disabled', toolCount: 0 });
    this.notify();
  }

  async reconnectServer(id: string): Promise<void> {
    await this.connectServer(id);
  }

  /** Connects with a transient client that's never added to the pool or
   *  status map — for the "Test Connection" button in the add/edit form,
   *  before the server is actually saved. */
  async testConnection(config: McpServerConfig): Promise<{ success: boolean; toolCount?: number; error?: string }> {
    let client: Client | undefined;
    try {
      const transport = this.buildTransport(config);
      client = new Client({ name: 'frappe-copilot', version: this.extensionVersion }, { capabilities: {} });
      await client.connect(transport);
      const { tools } = await client.listTools();
      return { success: true, toolCount: tools.length };
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) };
    } finally {
      try { await client?.close(); } catch { /* ignore */ }
    }
  }

  // ─── CRUD (delegates to the store, then reconnects as needed) ─────────────

  async addServer(config: Omit<McpServerConfig, 'id' | 'source'> & { id?: string }): Promise<McpServerConfig> {
    const saved = this.store.addServer(config);
    if (saved.enabled) await this.connectServer(saved.id);
    return saved;
  }

  async updateServer(id: string, patch: Partial<McpServerConfig>): Promise<McpServerConfig | null> {
    const updated = this.store.updateServer(id, patch);
    if (!updated) return null;
    // Any edit (command/args/env/url/enabled) needs a fresh connection to take effect.
    if (updated.enabled) await this.connectServer(id);
    else await this.disconnectServer(id);
    return updated;
  }

  async setEnabled(id: string, enabled: boolean): Promise<McpServerConfig | null> {
    return this.updateServer(id, { enabled });
  }

  async removeServer(id: string): Promise<boolean> {
    await this.disconnectServer(id);
    return this.store.removeServer(id);
  }

  /** Closes every live connection — called from extension.ts deactivate(). */
  async dispose(): Promise<void> {
    await Promise.allSettled(Array.from(this.connections.keys()).map(id => this.closeConnection(id)));
    this.statuses.clear();
  }

  // ─── Tool dispatch ──────────────────────────────────────────────────────

  /** Runs one MCP tool call and renders its result content blocks down to a
   *  plain string ToolResult — the same shape every other ToolExecutor method
   *  returns, since the model only ever sees tool results as text inside a
   *  <tool_result> block. */
  async callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<CallResult> {
    const conn = this.connections.get(serverId);
    if (!conn) {
      const config = this.store.getServer(serverId);
      if (!config) return { success: false, output: `Unknown MCP server '${serverId}'. Check the "Available MCP Tools" catalog for valid server ids.` };
      return { success: false, output: `MCP server '${serverId}' (${config.name}) is not connected (status: ${this.getStatus(serverId).status}). Enable/reconnect it from the MCP Servers view first.` };
    }
    if (!conn.tools.some(t => t.name === toolName)) {
      const available = conn.tools.map(t => t.name).join(', ') || '(none)';
      return { success: false, output: `Server '${serverId}' has no tool named '${toolName}'. Available tools: ${available}` };
    }

    try {
      const result = await conn.client.callTool({ name: toolName, arguments: args });
      const text = this.renderContent(result.content as any[]);
      return { success: !result.isError, output: text || (result.isError ? 'Tool reported an error with no message.' : '(no output)') };
    } catch (e: any) {
      return { success: false, output: `MCP tool call failed: ${e?.message || String(e)}` };
    }
  }

  /** Flattens callTool's mixed content blocks (text/image/audio/resource/
   *  resource_link) into one string — text passes through verbatim; binary
   *  types are noted by mime/size rather than dumped as base64, since that
   *  would blow up the tool-result token budget for no benefit to the model. */
  private renderContent(blocks: any[]): string {
    if (!Array.isArray(blocks)) return '';
    return blocks.map(b => {
      switch (b?.type) {
        case 'text': return b.text ?? '';
        case 'image': return `[image: ${b.mimeType || 'unknown type'}, ${Math.round((b.data?.length || 0) * 0.75 / 1024)}KB — not renderable in this text channel]`;
        case 'audio': return `[audio: ${b.mimeType || 'unknown type'}, not renderable in this text channel]`;
        case 'resource': {
          const r = b.resource || {};
          return r.text ? `[resource ${r.uri}]\n${r.text}` : `[resource ${r.uri} (${r.mimeType || 'binary'}), not renderable in this text channel]`;
        }
        case 'resource_link': return `[resource link: ${b.uri}${b.description ? ' — ' + b.description : ''}]`;
        default: return JSON.stringify(b);
      }
    }).filter(Boolean).join('\n');
  }

  private buildTransport(config: McpServerConfig): Transport {
    switch (config.transport) {
      case 'stdio': {
        if (!config.command) throw new Error(`Server '${config.name}' has no command configured.`);
        return new StdioClientTransport({
          command: config.command,
          args: config.args,
          env: { ...getDefaultEnvironment(), ...(config.env || {}) },
          cwd: config.cwd,
        });
      }
      case 'sse': {
        if (!config.url) throw new Error(`Server '${config.name}' has no URL configured.`);
        return new SSEClientTransport(new URL(config.url), config.headers ? { requestInit: { headers: config.headers } } : undefined);
      }
      case 'http':
      default: {
        if (!config.url) throw new Error(`Server '${config.name}' has no URL configured.`);
        return new StreamableHTTPClientTransport(new URL(config.url), config.headers ? { requestInit: { headers: config.headers } } : undefined);
      }
    }
  }
}
