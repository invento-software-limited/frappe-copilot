import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import AdmZip from 'adm-zip';

const SKILLS_DIR = 'skills';
// Same 150KB guardrail as ToolExecutor.readFile — a skill bundle can ship large
// assets (the erpnextdesign font stylesheet is ~450KB, roughly 110k tokens), and
// loading one into the prompt would blow the context window on its own.
const MAX_SKILL_BYTES = 150 * 1024;
const BUNDLE_ENTRY_NAMES = ['SKILL.md', 'skill.md'];

/** Words too common in this domain to discriminate between skills — every
 *  description mentions "frappe", "skill", "use", "when". */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'this', 'that', 'these', 'those',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'to', 'of', 'in', 'on', 'at', 'for',
  'with', 'by', 'from', 'as', 'it', 'its', 'i', 'you', 'me', 'my', 'we', 'us', 'our',
  'can', 'do', 'does', 'how', 'what', 'when', 'where', 'which', 'who', 'why', 'want',
  'need', 'use', 'using', 'used', 'make', 'please', 'help', 'skill', 'skills', 'frappe',
  'erpnext', 'app', 'code', 'file', 'files', 'not', 'no', 'yes', 'all', 'any', 'so',
]);

/** Lowercased alphanumeric words, stopwords and very short tokens removed. */
function tokenize(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 2 && !STOPWORDS.has(t));
}

export interface SkillMeta {
  id: string;
  name: string;
  description: string;
  source: 'builtin' | 'user';
}

export interface SkillImportResult {
  id?: string;
  error?: string;
}

/** File-based skills library. A skill is either:
 *  - a single file: .frappe-copilot/skills/<id>.md, with a two-line
 *    HTML-comment metadata header:
 *      <!-- name: Custom Print Format Boilerplate -->
 *      <!-- description: Reusable script + JSON template. -->
 *  - a bundle: .frappe-copilot/skills/<id>/SKILL.md plus sibling
 *    reference/asset files (imported from a .zip), same shape Claude Code's
 *    own skills use.
 *  Bundled (extension-shipped, read-only) skills live under a separate
 *  `bundledSkillsDir` and are merged into the catalog; a user skill with the
 *  same id overrides the bundled one. Parsing is defensive throughout — a
 *  malformed or unreadable skill is skipped, never fatal to the rest. */
export class SkillsStore {
  constructor(
    private frappeCopilotPath: string,
    private bundledSkillsDir?: string
  ) {}

  private get skillsDir(): string {
    return path.join(this.frappeCopilotPath, SKILLS_DIR);
  }

  private flatFilePath(id: string): string {
    return path.join(this.skillsDir, `${id}.md`);
  }

  private bundleEntryPath(dir: string): string | null {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;
    for (const name of BUNDLE_ENTRY_NAMES) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  private slugify(name: string): string {
    const slug = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return slug || `skill-${Date.now().toString(36)}`;
  }

  /** Minimal YAML-frontmatter reader for just `name` and `description` — the
   *  metadata format Claude Code skills use (`---\nname: x\ndescription: >-\n
   *  folded text\n---`). Deliberately not a YAML parser: only these two keys
   *  matter, and pulling in a dependency to read them isn't worth it. */
  private parseFrontmatter(content: string): { name?: string; description?: string } {
    const block = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!block) return {};

    const out: { name?: string; description?: string } = {};
    const lines = block[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const kv = lines[i].match(/^(name|description):\s*(.*)$/);
      if (!kv) continue;
      const key = kv[1] as 'name' | 'description';
      let value = kv[2].trim();

      if (/^[>|][-+]?$/.test(value)) {
        // Block scalar — consume the following more-indented lines.
        const parts: string[] = [];
        while (i + 1 < lines.length) {
          const next = lines[i + 1];
          if (next.trim() && !/^\s/.test(next)) break;
          parts.push(next.trim());
          i++;
        }
        value = parts.join(' ').replace(/\s+/g, ' ').trim();
      } else {
        value = value.replace(/^["']|["']$/g, '');
      }
      out[key] = value;
    }
    return out;
  }

  /** Last-resort metadata for a plain-markdown skill carrying neither
   *  frontmatter nor a comment header: the first '# Heading' is the name and the
   *  paragraph under it the description. Without this such a skill lists its own
   *  id as its description, which tells the model nothing about when to load it. */
  private deriveFromMarkdown(content: string): { name?: string; description?: string } {
    const lines = content.split(/\r?\n/);
    let name: string | undefined;
    const paragraph: string[] = [];

    for (const raw of lines) {
      const line = raw.trim();
      if (!name) {
        const heading = line.match(/^#\s+(.+)$/);
        if (heading) name = heading[1].trim();
        continue;
      }
      if (!line) {
        if (paragraph.length) break;
        continue;
      }
      if (line.startsWith('#')) break;
      paragraph.push(line);
    }
    return { name, description: paragraph.join(' ').trim() || undefined };
  }

  /** Accepts any of the three metadata styles in use: YAML frontmatter (Claude
   *  Code skills, which is what most bundled ones use), the older two-line HTML
   *  comment header, or plain markdown via deriveFromMarkdown. */
  private parseMeta(id: string, content: string, source: SkillMeta['source']): SkillMeta {
    const fm = this.parseFrontmatter(content);
    const nameMatch = content.match(/<!--\s*name:\s*(.+?)\s*-->/);
    const descMatch = content.match(/<!--\s*description:\s*(.+?)\s*-->/);
    const derived = this.deriveFromMarkdown(content);
    return {
      id,
      name: fm.name || (nameMatch ? nameMatch[1] : derived.name) || id,
      description: fm.description || (descMatch ? descMatch[1] : derived.description) || '',
      source
    };
  }

  private safeReadMeta(id: string, filePath: string, source: SkillMeta['source']): SkillMeta | null {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return this.parseMeta(id, content, source);
    } catch {
      return null;
    }
  }

  /** List all skills, sorted by name — builtin (bundled) skills first, then
   *  user flat files, then user bundle directories; a later entry overrides
   *  an earlier one with the same id, so user skills always win over builtin. */
  /** Collects every skill in one directory — flat `<id>.md` files and bundle
   *  directories alike — into `into`, overwriting same-id entries already there. */
  private scanSkillsDir(dir: string, source: SkillMeta['source'], into: Map<string, SkillMeta>): void {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        const id = entry.name.slice(0, -3);
        const meta = this.safeReadMeta(id, path.join(dir, entry.name), source);
        if (meta) into.set(id, meta);
      } else if (entry.isDirectory()) {
        const entryFile = this.bundleEntryPath(path.join(dir, entry.name));
        if (entryFile) {
          const meta = this.safeReadMeta(entry.name, entryFile, source);
          if (meta) into.set(entry.name, meta);
        }
      }
    }
  }

  listSkills(): SkillMeta[] {
    const byId = new Map<string, SkillMeta>();
    // Bundled first so a user skill of the same id overrides it.
    if (this.bundledSkillsDir) this.scanSkillsDir(this.bundledSkillsDir, 'builtin', byId);
    this.scanSkillsDir(this.skillsDir, 'user', byId);
    return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Resolves a skill id to its entry file on disk, in the same
   *  user-flat -> user-bundle -> builtin precedence as listSkills(). */
  /** User skills first, so they override a bundled skill with the same id. */
  private skillRoots(): string[] {
    const roots = [this.skillsDir];
    if (this.bundledSkillsDir) roots.push(this.bundledSkillsDir);
    return roots;
  }

  private resolveEntryFile(id: string): { filePath: string; bundleDir?: string; skillId: string } | null {
    const slash = id.indexOf('/');
    if (slash !== -1) {
      return this.resolveBundleFile(id.slice(0, slash), id.slice(slash + 1));
    }

    for (const root of this.skillRoots()) {
      const flat = path.join(root, `${id}.md`);
      if (fs.existsSync(flat)) return { filePath: flat, skillId: id };

      const dir = path.join(root, id);
      if (this.bundleEntryPath(dir)) {
        return { filePath: this.bundleEntryPath(dir)!, bundleDir: dir, skillId: id };
      }
    }
    return null;
  }

  /** Resolves one reference file inside a bundle, addressed as
   *  '<skill-id>/<path-within-skill>' (e.g. 'frappe-app-dev/references/doctypes.md').
   *  Bundled skills live in the extension directory, outside the workspace, so
   *  their references can't be reached with read_file — this is how the agent
   *  pulls them in, and it keeps progressive disclosure working for both
   *  bundled and user skills through one mechanism. */
  private resolveBundleFile(skillId: string, relPath: string): { filePath: string; skillId: string } | null {
    for (const root of this.skillRoots()) {
      const dir = path.join(root, skillId);
      if (!this.bundleEntryPath(dir)) continue;

      const base = path.resolve(dir);
      const target = path.resolve(base, relPath);
      // A '../' in the requested path must never escape the skill directory.
      if (target !== base && !target.startsWith(base + path.sep)) return null;
      if (fs.existsSync(target) && fs.statSync(target).isFile()) {
        return { filePath: target, skillId };
      }
    }
    return null;
  }

  /** Path to open in the editor for a given skill id (used by the openSkill command). */
  resolveSkillFilePath(id: string): string | null {
    return this.resolveEntryFile(id)?.filePath ?? null;
  }

  /** Recursively lists every file under `dir` except `excludeAbsPath`, as paths
   *  relative to the bundle root (with size), so each becomes a `use_skill` id
   *  of the form '<skill-id>/<relative-path>'. Sizes are shown because a skill
   *  can carry large assets — a 450KB stylesheet is ~110k tokens, and the model
   *  should be able to see that before pulling one in. */
  private listSiblingFiles(dir: string, excludeAbsPath: string): { rel: string; kb: number }[] {
    const results: { rel: string; kb: number }[] = [];
    const walk = (current: string) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (full !== excludeAbsPath) {
          const rel = path.relative(dir, full).split(path.sep).join('/');
          let kb = 0;
          try { kb = Math.max(1, Math.round(fs.statSync(full).size / 1024)); } catch { /* unreadable */ }
          results.push({ rel, kb });
        }
      }
    };
    try {
      walk(dir);
    } catch {
      // ignore unreadable subpaths
    }
    return results.sort((a, b) => a.rel.localeCompare(b.rel));
  }

  /** Full content of one skill, size-capped like read_file. For a bundle, the
   *  entry file's content is followed by a listing of its reference/asset files,
   *  each addressable as its own `use_skill` id — progressive disclosure, so a
   *  large skill costs only its SKILL.md until a specific reference is needed. */
  readSkill(id: string): string | null {
    const resolved = this.resolveEntryFile(id);
    if (!resolved) return null;

    const stat = fs.statSync(resolved.filePath);
    if (stat.size > MAX_SKILL_BYTES) {
      return `Error: '${id}' is too large (${Math.round(stat.size / 1024)}KB) — max ` +
        `${Math.round(MAX_SKILL_BYTES / 1024)}KB. It is likely a bundled asset (font, sprite, ` +
        `template) not meant to be read into context.`;
    }

    let content: string;
    try {
      content = fs.readFileSync(resolved.filePath, 'utf-8');
    } catch {
      return null;
    }

    if (resolved.bundleDir) {
      const refs = this.listSiblingFiles(resolved.bundleDir, resolved.filePath);
      if (refs.length > 0) {
        content += `\n\n---\nReference files in this skill — load one with use_skill using the id shown:\n` +
          refs.map(r => `- ${resolved.skillId}/${r.rel} (${r.kb}KB)`).join('\n');
      }
    }
    return content;
  }

  /** Scaffolds a new skill file and returns its path for the editor to open. */
  createSkill(name: string, description: string): string {
    if (!fs.existsSync(this.skillsDir)) fs.mkdirSync(this.skillsDir, { recursive: true });
    const id = this.slugify(name);
    const p = this.flatFilePath(id);
    const content = `<!-- name: ${name} -->\n<!-- description: ${description} -->\n\n## ${name}\n\n`;
    fs.writeFileSync(p, content, 'utf-8');
    return p;
  }

  /** Only ever touches the user skills dir — a builtin id simply won't match
   *  either the flat-file or bundle-dir path here, so it can't be deleted. */
  deleteSkill(id: string): boolean {
    const flat = this.flatFilePath(id);
    if (fs.existsSync(flat)) {
      try { fs.unlinkSync(flat); return true; } catch { return false; }
    }
    const bundleDir = path.join(this.skillsDir, id);
    if (this.bundleEntryPath(bundleDir)) {
      try { fs.rmSync(bundleDir, { recursive: true, force: true }); return true; } catch { return false; }
    }
    return false;
  }

  /** Imports a standalone .md file as a new flat skill. */
  importMarkdownFile(sourcePath: string): SkillImportResult {
    let content: string;
    try {
      content = fs.readFileSync(sourcePath, 'utf-8');
    } catch (err: any) {
      return { error: `Could not read file: ${err.message || err}` };
    }

    const nameMatch = content.match(/<!--\s*name:\s*(.+?)\s*-->/);
    const name = nameMatch ? nameMatch[1] : path.basename(sourcePath, '.md');
    const id = this.slugify(name);

    if (!fs.existsSync(this.skillsDir)) fs.mkdirSync(this.skillsDir, { recursive: true });
    fs.writeFileSync(this.flatFilePath(id), content, 'utf-8');
    return { id };
  }

  /** Imports a .zip bundle (a SKILL.md plus reference/asset files — same
   *  shape Claude Code's own skills use) as a new skill directory. Unwraps a
   *  single top-level wrapping folder if the zip has one, which is common for
   *  downloaded archives. */
  importZipFile(sourcePath: string): SkillImportResult {
    let zip: AdmZip;
    try {
      zip = new AdmZip(sourcePath);
    } catch (err: any) {
      return { error: `Could not read zip file: ${err.message || err}` };
    }

    const entries = zip.getEntries();
    const skillEntry = entries.find(e => {
      const normalized = e.entryName.replace(/\\/g, '/').replace(/\/$/, '');
      const parts = normalized.split('/');
      return parts.length <= 2 && BUNDLE_ENTRY_NAMES.some(n => n.toLowerCase() === parts[parts.length - 1].toLowerCase());
    });
    if (!skillEntry) {
      return { error: 'No SKILL.md found at the zip root or one folder deep — not a valid skill bundle.' };
    }

    const normalizedEntryName = skillEntry.entryName.replace(/\\/g, '/');
    const wrapperFolder = normalizedEntryName.split('/').length === 2
      ? normalizedEntryName.split('/')[0]
      : null;

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frappe-copilot-skill-'));
    try {
      zip.extractAllTo(tempDir, true);
      const bundleRoot = wrapperFolder ? path.join(tempDir, wrapperFolder) : tempDir;

      const skillMdContent = fs.readFileSync(path.join(tempDir, normalizedEntryName), 'utf-8');
      const nameMatch = skillMdContent.match(/<!--\s*name:\s*(.+?)\s*-->/);
      const name = nameMatch ? nameMatch[1] : path.basename(sourcePath, '.zip');
      const id = this.slugify(name);

      const destDir = path.join(this.skillsDir, id);
      if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true });
      fs.mkdirSync(this.skillsDir, { recursive: true });
      fs.cpSync(bundleRoot, destDir, { recursive: true });

      return { id };
    } catch (err: any) {
      return { error: `Failed to extract skill bundle: ${err.message || err}` };
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  /** Small, always-injected "here's what's available" listing — deliberately
   *  just name + one-liner per skill so it stays cheap even with dozens of
   *  skills; full content is loaded on demand via the use_skill tool. */
  buildCatalog(): string {
    const skills = this.listSkills();
    if (skills.length === 0) return '';
    return skills.map(s => `- ${s.id}: ${s.description || s.name}`).join('\n');
  }

  /** Picks the skills whose descriptions best match a request, so the relevant
   *  one is already in context instead of depending on the model noticing the
   *  catalog and spending a round-trip on use_skill.
   *
   *  Scoring is deliberately plain lexical overlap: skill descriptions are
   *  written as trigger lists ("Use this skill any time the user mentions:
   *  creating or modifying a DocType..."), so the words that matter are the
   *  domain nouns, and a rarer term appearing in only one skill is far more
   *  telling than one shared by several — hence the inverse-frequency weight.
   *  Matches in the id/name count double, since those are the most deliberate
   *  naming signal. The score is normalised by query length so the threshold
   *  means the same thing for a short and a long request. */
  suggestSkills(query: string, limit = 1, minScore = 0.12): SkillMeta[] {
    const skills = this.listSkills();
    if (skills.length === 0) return [];

    const queryTerms = Array.from(new Set(tokenize(query)));
    if (queryTerms.length === 0) return [];

    const haystacks = skills.map(s => ({
      strong: new Set(tokenize(`${s.id} ${s.name}`)),
      all: new Set(tokenize(`${s.id} ${s.name} ${s.description}`)),
    }));

    // How many skills each term appears in — a term in all of them says nothing.
    const docFreq = new Map<string, number>();
    for (const term of queryTerms) {
      docFreq.set(term, haystacks.filter(h => h.all.has(term)).length);
    }

    const scored = skills.map((meta, i) => {
      let score = 0;
      for (const term of queryTerms) {
        const freq = docFreq.get(term) || 0;
        if (freq === 0 || !haystacks[i].all.has(term)) continue;
        const rarity = Math.log(1 + skills.length / freq);
        score += rarity * (haystacks[i].strong.has(term) ? 2 : 1);
      }
      return { meta, score: score / queryTerms.length };
    });

    return scored
      .filter(s => s.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(s => s.meta);
  }

  /** One-time, silent, additive migration of the old flat skills_memory.md
   *  into the new library — never deletes the original, just renames it so it
   *  stops being picked up, matching the "nothing on disk is destroyed"
   *  convention already established for messages.jsonl. */
  migrateLegacyMemoryIfNeeded(): void {
    const legacyPath = path.join(this.frappeCopilotPath, 'skills_memory.md');
    if (!fs.existsSync(legacyPath)) return;

    const alreadyMigrated = fs.existsSync(this.skillsDir) && fs.readdirSync(this.skillsDir).length > 0;
    if (alreadyMigrated) return;

    try {
      const content = fs.readFileSync(legacyPath, 'utf-8');
      if (!fs.existsSync(this.skillsDir)) fs.mkdirSync(this.skillsDir, { recursive: true });
      const migrated = `<!-- name: Legacy Skills Memory -->\n<!-- description: Auto-migrated from skills_memory.md on first use of the new skills system. -->\n\n${content}`;
      fs.writeFileSync(path.join(this.skillsDir, 'legacy-memory.md'), migrated, 'utf-8');
      fs.renameSync(legacyPath, `${legacyPath}.migrated`);
    } catch (err) {
      console.error('Failed to migrate legacy skills_memory.md:', err);
    }
  }
}
