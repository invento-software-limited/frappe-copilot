/** How a server is reached. 'sse' is the legacy HTTP+Server-Sent-Events
 *  transport; 'http' is the current Streamable HTTP transport most remote
 *  MCP servers use today. Both are kept since config files in the wild
 *  (older `.vscode/mcp.json` entries especially) still say "sse". */
export type McpTransportKind = 'stdio' | 'sse' | 'http';

/** Where a server definition came from — controls whether the user can
 *  edit/delete it from our own UI (only 'manual' ones) and how it's badged. */
export type McpServerSource = 'manual' | 'vscode' | 'claude' | 'gemini';

/** Which mcp.json a manual server is persisted in: the workspace-local
 *  '.frappe-copilot/mcp.json' (this project only) or the global
 *  '~/.frappe-copilot/mcp.json' (every workspace this extension runs in).
 *  Only meaningful for source: 'manual' — discovered entries are always
 *  workspace-scoped, since they come from a workspace file by definition. */
export type McpServerScope = 'workspace' | 'global';

/** One configured MCP server, persisted in .frappe-copilot/mcp.json (manual
 *  ones) or synthesized on the fly from an external config file (discovered
 *  ones — never written back to our own store). */
export interface McpServerConfig {
  /** Stable slug, unique within its source. Used as the lookup key everywhere. */
  id: string;
  name: string;
  transport: McpTransportKind;
  /** stdio only */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** sse / http only */
  url?: string;
  headers?: Record<string, string>;
  /** Discovered servers default to disabled — nothing auto-connects without
   *  the user opting in, even though the underlying config file is trusted
   *  (this extension shouldn't be the one that decides to spawn a process). */
  enabled: boolean;
  source: McpServerSource;
  /** Manual entries only. Defaults to 'workspace' when absent, so files
   *  written before this field existed keep behaving exactly as before. */
  scope?: McpServerScope;
}

export type McpServerStatus = 'disabled' | 'connecting' | 'connected' | 'error';

export interface McpServerRuntimeState {
  status: McpServerStatus;
  error?: string;
  toolCount: number;
}

/** One tool advertised by a connected server's tools/list, flattened for the
 *  catalog shown to the model and for the webview's per-server tool list. */
export interface McpToolInfo {
  serverId: string;
  serverName: string;
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

/** On-disk shape of .frappe-copilot/mcp.json. */
export interface McpStoreFile {
  servers: McpServerConfig[];
}
