import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { LLMProvider } from '../providers/interface';
import { SkillsStore } from './skillsStore';
import { KNOWN_AGENT_DIRS } from '../workspace/crossAgentMemory';

type SourceType = 'framework-docs' | 'framework-templates' | 'workspace-code' | 'user-notes' | 'skill' | 'agent-memory';

interface TextChunk {
  id: string;
  source: string;
  sourceType: SourceType;
  text: string;
  vector?: number[];
}

/** One embeddable document before chunking — a whole file (or skill, or
 *  memory note). `key` must be stable and unique across rebuilds so an
 *  unchanged file's chunks can be recognized and skipped instead of
 *  re-embedded, and a changed/deleted one's stale chunks can be found and
 *  dropped. */
interface SourceDoc {
  key: string;
  source: string;
  sourceType: SourceType;
  text: string;
}

interface SourceFileEntry {
  hash: string;
  chunkIds: string[];
}

interface VectorStoreData {
  version: string;
  chunks: TextChunk[];
  files: Record<string, SourceFileEntry>;
}

/** Bump whenever the store's schema or chunking strategy changes, so existing
 *  on-disk caches are fully rebuilt instead of read in a stale shape. */
const INDEX_VERSION = '2.0';

const CHUNK_MAX_CHARS = 1200;
const CHUNK_OVERLAP_CHARS = 150;

const WORKSPACE_EXTENSIONS = new Set(['.py', '.js', '.json']);
// Note: 'public' is deliberately NOT excluded — <app>/public/js/*.js is where
// Frappe apps keep genuine hand-written client scripts. Its generated/vendor
// subdirectories ('dist', 'build', 'node_modules') are excluded by name
// wherever they occur, which already covers public/dist, public/node_modules, etc.
const WORKSPACE_EXCLUDED_DIRS = new Set([
  'node_modules', '__pycache__', 'venv', 'env', 'dist', 'build',
  'sites', 'out', 'locale', 'translations',
]);
/** Config/tooling JSON that is never a DocType/workspace definition worth
 *  embedding — filtered by filename since they can live anywhere in the tree. */
const WORKSPACE_EXCLUDED_JSON_NAMES = new Set([
  'package.json', 'package-lock.json', 'composer.json', 'composer.lock',
  'tsconfig.json', 'tslint.json', '.eslintrc.json', 'launch.json', 'settings.json',
]);
const MAX_WORKSPACE_FILE_BYTES = 60 * 1024; // skip generated/minified/huge files as noise
const MAX_WORKSPACE_FILES = 800; // bound cost/time if the workspace root is a whole bench

/**
 * Retrieval-augmented-generation knowledge base for the chat agent.
 *
 * Indexes six kinds of source, each hash-diffed per file so an unchanged
 * file's chunks are kept as-is (no wasted embedding calls) on every rebuild:
 *  - framework-docs / framework-templates: the extension's own bundled
 *    reference material (assets/docs, assets/templates) — unchanged in
 *    intent from before, just routed through the same pipeline as everything else.
 *  - workspace-code: the actual project open in the editor (DocType JSON,
 *    Python controllers/hooks, client scripts) — so retrieval can surface
 *    this project's own patterns, not just generic framework docs.
 *  - user-notes: markdown the user drops in .frappe-copilot/knowledge/.
 *  - skill: the skills library (skillsStore), so semantic search can surface
 *    a relevant skill even when suggestSkills()'s lexical matching misses it.
 *  - agent-memory: other AI tools' project notes (see crossAgentMemory.ts),
 *    made searchable on demand instead of only ever being force-injected.
 */
export class VectorStore {
  private storePath: string;
  private docsDir: string;
  private templatesDir: string;
  private notesDir: string;
  private data: VectorStoreData = { version: '0', chunks: [], files: {} };
  private isFallbackMode = false;
  private initializedPromise: Promise<void>;
  private nextId = 1;

  constructor(
    private copilotPath: string,
    private extensionPath: string,
    private provider: LLMProvider,
    private workspaceRoot: string = '',
    private skillsStore: SkillsStore | null = null
  ) {
    this.storePath = path.join(this.copilotPath, 'docs', 'vector_store.json');
    this.docsDir = path.join(this.extensionPath, 'assets', 'docs');
    this.templatesDir = path.join(this.extensionPath, 'assets', 'templates');
    this.notesDir = path.join(this.copilotPath, 'knowledge');
    this.initializedPromise = this.initialize();
  }

  /** Load the cache (or build fresh) then resync — resync is cheap even with
   *  a valid cache since every file is hash-diffed, so this also catches any
   *  workspace/skill/notes edits made while the extension wasn't running. */
  private async initialize(): Promise<void> {
    try {
      const dir = path.dirname(this.storePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      if (fs.existsSync(this.storePath)) {
        const raw = fs.readFileSync(this.storePath, 'utf-8');
        const loaded = JSON.parse(raw) as Partial<VectorStoreData>;
        this.data = { version: loaded.version || '0', chunks: loaded.chunks || [], files: loaded.files || {} };
        this.nextId = 1 + this.data.chunks.reduce((max, c) => {
          const n = parseInt(c.id.split('-')[1] || '0', 10);
          return Number.isFinite(n) && n > max ? n : max;
        }, 0);
        if (this.data.version !== INDEX_VERSION) {
          console.log(`Knowledge base cache is version ${this.data.version}, expected ${INDEX_VERSION} — rebuilding.`);
          this.data = { version: INDEX_VERSION, chunks: [], files: {} };
          this.nextId = 1;
        }
      }
      await this.rebuildIndex();
    } catch (err) {
      console.error('Failed to initialize knowledge base, falling back to keyword search:', err);
      this.isFallbackMode = true;
    }
  }

  /** Re-scan every source and sync the index against what's currently on
   *  disk. Safe to call often — a file whose content hash hasn't changed is
   *  never re-embedded, so this only pays for what actually changed. */
  async rebuildIndex(): Promise<void> {
    try {
      this.data.version = INDEX_VERSION;
      await this.syncSourceType('framework-docs', this.collectFrameworkDocs());
      await this.syncSourceType('framework-templates', this.collectFrameworkTemplates());
      await this.syncSourceType('workspace-code', this.collectWorkspaceCode());
      await this.syncSourceType('user-notes', this.collectUserNotes());
      await this.syncSourceType('skill', this.collectSkills());
      await this.syncSourceType('agent-memory', this.collectAgentMemory());
      this.persist();
      console.log(`Knowledge base index: ${this.data.chunks.length} chunks across ${Object.keys(this.data.files).length} files.`);
    } catch (err) {
      console.error('Fatal error during knowledge base index rebuild:', err);
    }
  }

  /** Watches the workspace for changes to anything indexable and debounces a
   *  resync. One glob rooted at the workspace covers workspace code AND
   *  .frappe-copilot/knowledge AND .frappe-copilot/skills AND agent-memory
   *  dirs, since they all live under it — the callback filters out our own
   *  cache file and noisy non-source dirs (sessions/plans/node_modules/...)
   *  so it doesn't resync on its own writes or unrelated churn. */
  watch(): vscode.Disposable[] {
    if (!this.workspaceRoot || !fs.existsSync(this.workspaceRoot)) return [];

    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleResync = (uri: vscode.Uri) => {
      if (this.shouldIgnoreWatchPath(uri.fsPath)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        this.rebuildIndex().catch(err => console.error('Knowledge base resync failed:', err));
      }, 2000);
    };

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.workspaceRoot, '**/*.{py,js,json,md}')
    );
    watcher.onDidCreate(scheduleResync);
    watcher.onDidChange(scheduleResync);
    watcher.onDidDelete(scheduleResync);
    return [watcher, new vscode.Disposable(() => { if (timer) clearTimeout(timer); })];
  }

  private shouldIgnoreWatchPath(fsPath: string): boolean {
    const norm = fsPath.split(path.sep).join('/');
    if (norm === this.storePath.split(path.sep).join('/')) return true; // our own cache write

    const copilotNorm = this.copilotPath.split(path.sep).join('/');
    // sessions/plans/agents/docs churn constantly during normal use and are
    // never a knowledge source themselves (docs/ is where our cache lives).
    if (['sessions', 'plans', 'agents', 'docs'].some(d => norm.startsWith(`${copilotNorm}/${d}/`))) {
      return true;
    }

    for (const seg of norm.split('/')) {
      if (WORKSPACE_EXCLUDED_DIRS.has(seg)) return true;
      if (seg.startsWith('.') && seg !== '.frappe-copilot' && seg !== '.devmind') return true;
    }
    return false;
  }

  private persist(): void {
    try {
      const dir = path.dirname(this.storePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.storePath, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to write knowledge base cache:', err);
    }
  }

  // ─── Source collectors ────────────────────────────────────────────────

  /** Recursively collect all .md files under a directory (used for assets/docs, which
   *  nests skill folders like docs/skills/frappe-app-dev/references/*.md). */
  private findMarkdownFilesRecursive(dir: string): string[] {
    const results: string[] = [];
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return results; }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...this.findMarkdownFilesRecursive(fullPath));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(fullPath);
      }
    }
    return results;
  }

  private collectFrameworkDocs(): SourceDoc[] {
    if (!fs.existsSync(this.docsDir)) return [];
    const docs: SourceDoc[] = [];
    for (const filePath of this.findMarkdownFilesRecursive(this.docsDir)) {
      const relPath = path.relative(this.docsDir, filePath).split(path.sep).join('/');
      let content: string;
      try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }
      if (!content.trim()) continue;
      docs.push({ key: `framework-docs:${relPath}`, source: `docs/${relPath}`, sourceType: 'framework-docs', text: content.trim() });
    }
    return docs;
  }

  private collectFrameworkTemplates(): SourceDoc[] {
    if (!fs.existsSync(this.templatesDir)) return [];
    const docs: SourceDoc[] = [];
    const files = fs.readdirSync(this.templatesDir).filter(f => f.endsWith('.py') || f.endsWith('.js'));
    for (const file of files) {
      const filePath = path.join(this.templatesDir, file);
      let content: string;
      try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }
      if (!content.trim()) continue;
      docs.push({ key: `framework-templates:${file}`, source: `templates/${file}`, sourceType: 'framework-templates', text: content.trim() });
    }
    return docs;
  }

  /** Walks the open workspace for DocType JSON / Python controllers & hooks /
   *  client scripts — capped on file count and per-file size so opening the
   *  whole bench root (rather than just one app) doesn't blow up indexing
   *  time or embedding cost. */
  private collectWorkspaceCode(): SourceDoc[] {
    if (!this.workspaceRoot || !fs.existsSync(this.workspaceRoot)) return [];
    const docs: SourceDoc[] = [];

    const walk = (dir: string) => {
      if (docs.length >= MAX_WORKSPACE_FILES) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

      for (const entry of entries) {
        if (docs.length >= MAX_WORKSPACE_FILES) return;
        const full = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          if (entry.name.startsWith('.')) continue; // .git, .vscode, .frappe-copilot, .venv, ...
          if (WORKSPACE_EXCLUDED_DIRS.has(entry.name)) continue;
          walk(full);
          continue;
        }
        if (!entry.isFile()) continue;

        const ext = path.extname(entry.name);
        if (!WORKSPACE_EXTENSIONS.has(ext)) continue;
        if (ext === '.json' && WORKSPACE_EXCLUDED_JSON_NAMES.has(entry.name)) continue;

        let stat: fs.Stats;
        try { stat = fs.statSync(full); } catch { continue; }
        if (stat.size === 0 || stat.size > MAX_WORKSPACE_FILE_BYTES) continue;

        let content: string;
        try { content = fs.readFileSync(full, 'utf-8'); } catch { continue; }
        if (!content.trim()) continue;

        const relPath = path.relative(this.workspaceRoot, full).split(path.sep).join('/');
        docs.push({ key: `workspace-code:${full}`, source: `workspace/${relPath}`, sourceType: 'workspace-code', text: content.trim() });
      }
    };
    walk(this.workspaceRoot);
    return docs;
  }

  private collectUserNotes(): SourceDoc[] {
    if (!fs.existsSync(this.notesDir)) return [];
    const docs: SourceDoc[] = [];
    for (const filePath of this.findMarkdownFilesRecursive(this.notesDir)) {
      const relPath = path.relative(this.notesDir, filePath).split(path.sep).join('/');
      let content: string;
      try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }
      if (!content.trim()) continue;
      docs.push({ key: `user-notes:${filePath}`, source: `notes/${relPath}`, sourceType: 'user-notes', text: content.trim() });
    }
    return docs;
  }

  private collectSkills(): SourceDoc[] {
    if (!this.skillsStore) return [];
    const docs: SourceDoc[] = [];
    for (const meta of this.skillsStore.listSkills()) {
      let content: string | null;
      try { content = this.skillsStore.readSkill(meta.id); } catch { continue; }
      if (!content || content.startsWith('Error:') || !content.trim()) continue;
      docs.push({ key: `skill:${meta.id}`, source: `skill:${meta.id}`, sourceType: 'skill', text: content.trim() });
    }
    return docs;
  }

  private collectAgentMemory(): SourceDoc[] {
    if (!this.workspaceRoot) return [];
    const docs: SourceDoc[] = [];
    for (const { label, relDir } of KNOWN_AGENT_DIRS) {
      const dir = path.join(this.workspaceRoot, relDir);
      let entries: string[];
      try { entries = fs.readdirSync(dir).filter(f => f.endsWith('.md')); } catch { continue; }
      for (const file of entries) {
        const filePath = path.join(dir, file);
        let content: string;
        try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }
        if (!content.trim()) continue;
        docs.push({ key: `agent-memory:${filePath}`, source: `${label}/${file}`, sourceType: 'agent-memory', text: content.trim() });
      }
    }
    return docs;
  }

  // ─── Indexing ─────────────────────────────────────────────────────────

  /** Diffs `docs` against what's currently indexed for `sourceType`: drops
   *  files that no longer exist, skips files whose content hash is
   *  unchanged (no re-embedding), and (re)indexes everything else. */
  private async syncSourceType(sourceType: SourceType, docs: SourceDoc[]): Promise<void> {
    const seenKeys = new Set(docs.map(d => d.key));
    for (const key of Object.keys(this.data.files)) {
      if (key.startsWith(`${sourceType}:`) && !seenKeys.has(key)) {
        this.removeFileEntry(key);
      }
    }
    for (const doc of docs) {
      await this.indexOneDoc(doc);
    }
  }

  private async indexOneDoc(doc: SourceDoc): Promise<void> {
    const hash = crypto.createHash('sha1').update(doc.text).digest('hex');
    const existing = this.data.files[doc.key];
    if (existing && existing.hash === hash) return; // unchanged — nothing to do
    if (existing) this.removeFileEntry(doc.key); // stale chunks from a prior version of this file

    const pieces = this.chunkText(doc.text);
    const chunkIds: string[] = [];
    for (const text of pieces) {
      const id = `chunk-${this.nextId++}`;
      let vector: number[] | undefined;
      if (!this.isFallbackMode && this.provider.getEmbeddings) {
        try {
          vector = await this.provider.getEmbeddings(text);
        } catch (e) {
          console.warn(`Embeddings failed while indexing ${doc.source}. Falling back to keyword search.`, e);
          this.isFallbackMode = true;
        }
      }
      this.data.chunks.push({ id, source: doc.source, sourceType: doc.sourceType, text, vector });
      chunkIds.push(id);
    }
    this.data.files[doc.key] = { hash, chunkIds };
  }

  private removeFileEntry(key: string): void {
    const entry = this.data.files[key];
    if (!entry) return;
    const idSet = new Set(entry.chunkIds);
    this.data.chunks = this.data.chunks.filter(c => !idSet.has(c.id));
    delete this.data.files[key];
  }

  /** Paragraph-packing chunker with overlap: each new chunk is seeded with
   *  the tail of the previous one, so a sentence or code block that straddles
   *  a chunk boundary is still whole in at least one of the two chunks
   *  instead of being cut and lost to both. A single paragraph bigger than
   *  the max (a giant minified line, a huge function) is hard-sliced with
   *  the same overlap rather than becoming one oversized chunk. */
  private chunkText(text: string, maxChars: number = CHUNK_MAX_CHARS, overlapChars: number = CHUNK_OVERLAP_CHARS): string[] {
    const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
    if (paragraphs.length === 0) return [];

    const chunks: string[] = [];
    let current = '';
    const flush = () => { if (current.trim()) chunks.push(current.trim()); };

    for (const para of paragraphs) {
      if (para.length > maxChars) {
        flush();
        current = '';
        for (let i = 0; i < para.length; i += maxChars - overlapChars) {
          chunks.push(para.slice(i, i + maxChars));
        }
        continue;
      }

      const candidate = current ? `${current}\n\n${para}` : para;
      if (candidate.length > maxChars && current) {
        flush();
        const tail = current.slice(Math.max(0, current.length - overlapChars));
        current = `${tail}\n\n${para}`;
      } else {
        current = candidate;
      }
    }
    flush();
    return chunks;
  }

  // ─── Search ───────────────────────────────────────────────────────────

  /** Hybrid semantic + keyword search: embedding cosine similarity (normalized
   *  to 0..1) combined with lexical overlap, so an exact term match still
   *  helps rank a chunk even when its embedding isn't the single closest
   *  vector — pure cosine similarity alone tends to miss short, specific
   *  chunks (like a single command template) against a longer, vaguer one. */
  async search(query: string, limit: number = 6): Promise<TextChunk[]> {
    await this.initializedPromise;
    if (!query || this.data.chunks.length === 0) return [];

    if (this.isFallbackMode || !this.provider.getEmbeddings) {
      return this.keywordSearch(query, limit);
    }

    try {
      const queryVector = await this.provider.getEmbeddings(query);
      const kwScores = this.keywordScores(query);

      const scored = this.data.chunks
        .filter(c => c.vector !== undefined)
        .map(chunk => {
          const simNorm = (this.cosineSimilarity(queryVector, chunk.vector!) + 1) / 2;
          const kw = kwScores.get(chunk.id) || 0;
          return { chunk, score: simNorm * 0.7 + kw * 0.3 };
        });

      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, limit).map(s => s.chunk);
    } catch (e) {
      console.warn('Embeddings search failed. Using keyword search fallback.', e);
      this.isFallbackMode = true;
      return this.keywordSearch(query, limit);
    }
  }

  /** Simple cosine similarity calculation. */
  private cosineSimilarity(vecA: number[], vecB: number[]): number {
    let dotProduct = 0.0;
    let normA = 0.0;
    let normB = 0.0;
    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /** Term-overlap score (0..1) per chunk id, shared by keyword-only fallback
   *  search and as the lexical half of hybrid search. */
  private keywordScores(query: string): Map<string, number> {
    const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'do', 'does', 'did', 'to', 'for', 'in', 'of', 'on', 'with', 'at', 'by', 'from', 'it', 'this', 'that', 'how', 'i', 'my', 'me', 'you', 'your', 'and', 'or', 'so']);
    const queryTokens = query.toLowerCase().split(/\W+/).filter(t => t.length > 1 && !stopWords.has(t));
    const scores = new Map<string, number>();
    if (queryTokens.length === 0) return scores;

    for (const chunk of this.data.chunks) {
      const textLower = chunk.text.toLowerCase();
      let matches = 0;
      for (const token of queryTokens) {
        if (textLower.includes(token)) matches++;
      }
      scores.set(chunk.id, matches / queryTokens.length);
    }
    return scores;
  }

  private keywordSearch(query: string, limit: number): TextChunk[] {
    const scores = this.keywordScores(query);
    if (scores.size === 0) return [];
    const scored = this.data.chunks.map(chunk => ({ chunk, score: scores.get(chunk.id) || 0 }));
    scored.sort((a, b) => b.score - a.score);
    return scored.filter(s => s.score >= 0.25).slice(0, limit).map(s => s.chunk);
  }
}
