import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import AdmZip from 'adm-zip';

const SKILLS_DIR = 'skills';
const MAX_SKILL_BYTES = 1 * 1024 * 1024; // same 1MB guardrail as ToolExecutor.readFile
const BUNDLE_ENTRY_NAMES = ['SKILL.md', 'skill.md'];

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

  /** The workspace root, derived from frappeCopilotPath (<root>/.frappe-copilot),
   *  used to produce workspace-relative paths a `read_file` call can use. */
  private get workspaceRoot(): string {
    return path.dirname(this.frappeCopilotPath);
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

  private parseMeta(id: string, content: string, source: SkillMeta['source']): SkillMeta {
    const nameMatch = content.match(/<!--\s*name:\s*(.+?)\s*-->/);
    const descMatch = content.match(/<!--\s*description:\s*(.+?)\s*-->/);
    return {
      id,
      name: nameMatch ? nameMatch[1] : id,
      description: descMatch ? descMatch[1] : '',
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
  listSkills(): SkillMeta[] {
    const byId = new Map<string, SkillMeta>();

    if (this.bundledSkillsDir && fs.existsSync(this.bundledSkillsDir)) {
      for (const file of fs.readdirSync(this.bundledSkillsDir)) {
        if (!file.endsWith('.md')) continue;
        const id = file.slice(0, -3);
        const meta = this.safeReadMeta(id, path.join(this.bundledSkillsDir, file), 'builtin');
        if (meta) byId.set(id, meta);
      }
    }

    if (fs.existsSync(this.skillsDir)) {
      for (const entry of fs.readdirSync(this.skillsDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.md')) {
          const id = entry.name.slice(0, -3);
          const meta = this.safeReadMeta(id, path.join(this.skillsDir, entry.name), 'user');
          if (meta) byId.set(id, meta);
        } else if (entry.isDirectory()) {
          const entryFile = this.bundleEntryPath(path.join(this.skillsDir, entry.name));
          if (entryFile) {
            const meta = this.safeReadMeta(entry.name, entryFile, 'user');
            if (meta) byId.set(entry.name, meta);
          }
        }
      }
    }

    return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Resolves a skill id to its entry file on disk, in the same
   *  user-flat -> user-bundle -> builtin precedence as listSkills(). */
  private resolveEntryFile(id: string): { filePath: string; isBundle: boolean } | null {
    const flat = this.flatFilePath(id);
    if (fs.existsSync(flat)) return { filePath: flat, isBundle: false };

    const bundleDir = path.join(this.skillsDir, id);
    const bundleEntry = this.bundleEntryPath(bundleDir);
    if (bundleEntry) return { filePath: bundleEntry, isBundle: true };

    if (this.bundledSkillsDir) {
      const builtin = path.join(this.bundledSkillsDir, `${id}.md`);
      if (fs.existsSync(builtin)) return { filePath: builtin, isBundle: false };
    }
    return null;
  }

  /** Path to open in the editor for a given skill id (used by the openSkill command). */
  resolveSkillFilePath(id: string): string | null {
    return this.resolveEntryFile(id)?.filePath ?? null;
  }

  /** Recursively lists every file under `dir` except `excludeAbsPath`, as
   *  paths relative to the workspace root — so the agent can `read_file` them directly. */
  private listSiblingFiles(dir: string, excludeAbsPath: string): string[] {
    const results: string[] = [];
    const walk = (current: string) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (full !== excludeAbsPath) {
          results.push(path.relative(this.workspaceRoot, full));
        }
      }
    };
    try {
      walk(dir);
    } catch {
      // ignore unreadable subpaths
    }
    return results;
  }

  /** Full content of one skill, size-capped like read_file. For a bundle, the
   *  entry file's content is followed by a listing of sibling reference/asset
   *  files the agent can pull in via read_file — no second tool needed. */
  readSkill(id: string): string | null {
    const resolved = this.resolveEntryFile(id);
    if (!resolved) return null;

    const stat = fs.statSync(resolved.filePath);
    if (stat.size > MAX_SKILL_BYTES) {
      return `Error: skill '${id}' is too large (${(stat.size / 1024 / 1024).toFixed(2)}MB) — max 1.00MB.`;
    }

    let content: string;
    try {
      content = fs.readFileSync(resolved.filePath, 'utf-8');
    } catch {
      return null;
    }

    if (resolved.isBundle) {
      const siblings = this.listSiblingFiles(path.dirname(resolved.filePath), resolved.filePath);
      if (siblings.length > 0) {
        content += `\n\n---\nOther files in this skill (read via read_file with the path shown):\n` +
          siblings.map(s => `- ${s}`).join('\n');
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
