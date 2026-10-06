import type { VectorStore } from '../vectorStore';
import { ToolResult, ok, fail } from './result';
import { asInt, asString } from './args';

export interface SchemaMap {
  doctypes: string[];
  apps: string[];
}

const MAX_DOCTYPES_LISTED = 300;
const MAX_CHUNK_CHARS = 2500;

/** search_knowledge / list_doctypes — the knowledge base and site schema,
 *  fetched on demand instead of injected into every step's system prompt. */
export class ContextTools {
  static readonly NAMES: ReadonlySet<string> = new Set(['search_knowledge', 'list_doctypes']);

  constructor(
    private vectorStore: () => VectorStore | null,
    private schema: () => SchemaMap | null,
    /** Retries loading the schema (the bench may not have been up at startup). */
    private reloadSchema?: () => Promise<void>
  ) {}

  handles(name: string): boolean {
    return ContextTools.NAMES.has(name);
  }

  async run(name: string, args: Record<string, any>): Promise<ToolResult> {
    return name === 'search_knowledge' ? this.searchKnowledge(args) : this.listDoctypes(args);
  }

  private async searchKnowledge(args: Record<string, any>): Promise<ToolResult> {
    const query = asString(args.query);
    if (!query) return fail('Missing query parameter');
    const store = this.vectorStore();
    if (!store) return fail('The knowledge base is not available in this workspace.');
    const limit = Math.min(12, Math.max(1, asInt(args.limit) ?? 6));
    const results = await store.search(query, limit);
    if (results.length === 0) return ok(`No knowledge-base results for "${query}".`);
    return ok(results.map(r => `--- [${r.source}] ---\n${clip(r.text)}`).join('\n\n'));
  }

  private async listDoctypes(args: Record<string, any>): Promise<ToolResult> {
    if (!this.schema() && this.reloadSchema) await this.reloadSchema();
    const schema = this.schema();
    if (!schema) return fail("Couldn't load the site's DocTypes — the bench may not be running, or no site could be determined. Try introspect_doctype with an explicit site, or check the bench.");
    const filter = (asString(args.filter) || '').toLowerCase();
    const matches = schema.doctypes.filter(d => d.toLowerCase().includes(filter)).sort();
    const shown = matches.slice(0, MAX_DOCTYPES_LISTED);
    const more = matches.length > shown.length ? `\n[${matches.length - shown.length} more — narrow the filter]` : '';
    const header = `Installed apps: ${schema.apps.join(', ')}\n${matches.length} DocType(s)${filter ? ` matching "${filter}"` : ''}:`;
    return ok(`${header}\n${shown.join('\n')}${more}`);
  }
}

/** Short, one-line site summary for the system prompt. */
export function schemaSummary(schema: SchemaMap | null): string {
  if (!schema) return '';
  return `\n\n### Active Site\nInstalled apps: ${schema.apps.join(', ')}. The site has ${schema.doctypes.length} DocTypes — call list_doctypes to search them before referencing or creating one.`;
}

function clip(text: string): string {
  return text.length > MAX_CHUNK_CHARS ? text.slice(0, MAX_CHUNK_CHARS) + '\n…' : text;
}
