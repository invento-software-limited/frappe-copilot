import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { LLMProvider } from '../providers/interface';
import { ToolExecutor } from '../agents/toolExecutor';
import { VectorStore } from '../agents/vectorStore';
import { GraphStore } from '../agents/graphStore';
import { SkillsStore } from '../agents/skillsStore';
import { SkillRouter } from '../agents/skillRouter';
import { ContextTools, SchemaMap } from '../agents/tools/contextTools';

/** The workspace's `.frappe-copilot` folder, or null when there isn't one. */
export function frappeCopilotPath(): string | null {
  const r = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
  if (!r) return null;
  const p = path.join(r, '.frappe-copilot');
  return fs.existsSync(p) ? p : null;
}

export function workspaceRoot(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
}

/** Per-workspace knowledge the agent draws on: the knowledge base, skills
 *  library, workflow graph and the site's DocType/app index. All of it is
 *  absent when the workspace has no `.frappe-copilot` folder. */
export class ProjectContext {
  readonly vectorStore: VectorStore | null = null;
  readonly graphStore: GraphStore | null = null;
  readonly skillsStore: SkillsStore | null = null;
  readonly skillRouter: SkillRouter | null = null;
  readonly contextTools: ContextTools;
  private schemaMap: SchemaMap | null = null;
  private watchers: vscode.Disposable[] = [];
  private tools: ToolExecutor | null = null;

  constructor(extensionPath: string, provider: LLMProvider) {
    this.contextTools = new ContextTools(() => this.vectorStore, () => this.schemaMap, () => this.refreshSchema());
    const fp = frappeCopilotPath();
    if (!fp) return;
    this.graphStore = new GraphStore(fp);
    // Built before VectorStore since the knowledge base indexes the skills library too.
    this.skillsStore = new SkillsStore(fp, path.join(extensionPath, 'assets', 'skills'));
    this.skillsStore.migrateLegacyMemoryIfNeeded();
    this.skillRouter = new SkillRouter(this.skillsStore);
    this.vectorStore = new VectorStore(fp, extensionPath, provider, workspaceRoot(), this.skillsStore);
    this.watchers = this.vectorStore.watch();
  }

  get schema(): SchemaMap | null {
    return this.schemaMap;
  }

  /** Loads the cached site index, then refreshes it from the bench. */
  async attach(tools: ToolExecutor): Promise<void> {
    this.tools = tools;
    const fp = frappeCopilotPath();
    if (!fp) return;
    const cached = path.join(fp, 'schema_index.json');
    if (fs.existsSync(cached)) {
      try {
        this.schemaMap = JSON.parse(fs.readFileSync(cached, 'utf-8'));
      } catch (err) {
        console.error('Failed to parse cached schema index:', err);
      }
    }
    await this.refreshSchema();
  }

  /** Stops the knowledge-base file watcher — only on extension deactivation,
   *  since the chat object outlives a closed webview. */
  disposeWatchers(): void {
    this.watchers.forEach(d => d.dispose());
    this.watchers = [];
  }

  /** Reloads the site's apps and DocType names and caches them on disk. */
  private async refreshSchema(): Promise<void> {
    if (!this.tools) return;
    try {
      const schema = await this.tools.fetchSchema();
      if (!schema) return;
      this.schemaMap = { doctypes: schema.doctypes, apps: schema.apps };
      const fp = frappeCopilotPath();
      if (fp) fs.writeFileSync(path.join(fp, 'schema_index.json'), JSON.stringify(this.schemaMap, null, 2), 'utf-8');
    } catch (err) {
      console.warn('Workspace schema introspection failed:', err);
    }
  }
}
