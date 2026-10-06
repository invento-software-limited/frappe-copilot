import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { ToolResult, ok, fail } from './result';
import { asBool, asInt, asString } from './args';
import { jsGrep } from './jsGrep';

const MAX_OUTPUT_CHARS = 20_000;
const DEFAULT_HEAD_LIMIT = 200;
const MAX_GLOB_RESULTS = 200;
const EXCLUDES = ['node_modules', '.git', '__pycache__', '.venv', 'venv', 'env', 'dist', '.frappe-copilot'];

export type GrepMode = 'content' | 'files_with_matches' | 'count';

export interface GrepQuery {
  pattern: string;
  root: string;
  glob?: string;
  type?: string;
  mode: GrepMode;
  ignoreCase: boolean;
  context: number;
  headLimit: number;
}

/** grep_search (ripgrep, with a pure-JS fallback) and glob. */
export class SearchTools {
  private rgPath: string | null | undefined;

  constructor(
    private resolvePath: (rel: string) => Promise<string>,
    private workspaceRoot: () => string
  ) {}

  async grep(args: Record<string, any>): Promise<ToolResult> {
    const pattern = asString(args.pattern ?? args.query);
    if (!pattern) return fail('Missing pattern parameter');
    const mode = (['content', 'files_with_matches', 'count'].includes(args.output_mode) ? args.output_mode : 'content') as GrepMode;
    const q: GrepQuery = {
      pattern,
      root: args.path ? await this.resolvePath(asString(args.path)!) : this.workspaceRoot(),
      glob: asString(args.glob),
      type: asString(args.type),
      mode,
      ignoreCase: asBool(args.case_insensitive ?? args['-i'], false),
      context: Math.min(10, Math.max(0, asInt(args.context) ?? 0)),
      headLimit: Math.max(1, asInt(args.head_limit) ?? DEFAULT_HEAD_LIMIT),
    };
    try {
      new RegExp(pattern);
    } catch (e: any) {
      return fail(`Invalid regex '${pattern}': ${e.message}. Escape special characters like ( [ { . * + ? for a literal match.`);
    }
    const rg = this.findRipgrep();
    const lines = rg ? await this.runRipgrep(rg, q) : jsGrep(q);
    return ok(this.formatGrep(lines, q));
  }

  async glob(args: Record<string, any>): Promise<ToolResult> {
    const pattern = asString(args.pattern);
    if (!pattern) return fail('Missing pattern parameter');
    const base = args.path ? await this.resolvePath(asString(args.path)!) : this.workspaceRoot();
    const exclude = `{${EXCLUDES.map(d => `**/${d}/**`).join(',')}}`;
    const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(base, pattern), exclude, 5000);
    if (uris.length === 0) return ok(`No files match '${pattern}' under ${this.rel(base) || '.'}`);

    // Most recently modified first — usually what the agent is working on.
    const files = uris
      .map(u => ({ p: u.fsPath, t: safeMtime(u.fsPath) }))
      .sort((a, b) => b.t - a.t)
      .map(f => this.rel(f.p));
    const shown = files.slice(0, MAX_GLOB_RESULTS).join('\n');
    const more = files.length > MAX_GLOB_RESULTS ? `\n[${files.length - MAX_GLOB_RESULTS} more not shown — narrow the pattern or path]` : '';
    return ok(shown + more);
  }

  private runRipgrep(rg: string, q: GrepQuery): Promise<string[]> {
    const argv = ['--no-heading', '--color', 'never', '--max-columns', '300', '--max-columns-preview', '--max-filesize', '2M'];
    if (q.mode === 'files_with_matches') argv.push('--files-with-matches');
    else if (q.mode === 'count') argv.push('--count');
    else argv.push('--line-number', '--with-filename');
    if (q.mode === 'content' && q.context > 0) argv.push('-C', String(q.context));
    if (q.ignoreCase) argv.push('-i');
    if (q.glob) argv.push('--glob', q.glob);
    if (q.type) argv.push('--type', q.type);
    for (const d of EXCLUDES) argv.push('--glob', `!**/${d}/**`);
    argv.push('--glob', '!*.min.js', '--glob', '!*.map', '-e', q.pattern, q.root);

    return new Promise(resolve => {
      execFile(rg, argv, { maxBuffer: 20 * 1024 * 1024, timeout: 30_000, cwd: this.workspaceRoot() }, (_err, stdout) => {
        // Exit code 1 just means "no matches"; partial stdout is still usable on errors.
        resolve((stdout || '').split('\n').filter(l => l.length > 0));
      });
    });
  }

  private formatGrep(lines: string[], q: GrepQuery): string {
    if (lines.length === 0) return `No matches for /${q.pattern}/${q.glob ? ` in ${q.glob}` : ''}.`;
    const rows = lines.slice(0, q.headLimit).map(l => this.relLine(l));
    let out = '';
    let shown = 0;
    for (const r of rows) {
      if (out.length + r.length > MAX_OUTPUT_CHARS) break;
      out += r + '\n';
      shown++;
    }
    if (shown < lines.length) {
      out += `\n[Showing ${shown} of ${lines.length} result lines. Narrow with path/glob/type, or use output_mode=files_with_matches.]`;
    }
    return out.trimEnd();
  }

  /** rg prints absolute paths when given an absolute root — shorten them. */
  private relLine(line: string): string {
    const root = this.workspaceRoot();
    return line.startsWith(root + path.sep) ? line.slice(root.length + 1) : line;
  }

  private rel(abs: string): string {
    return path.relative(this.workspaceRoot(), abs) || abs;
  }

  /** VS Code-family editors bundle ripgrep; fall back to one on PATH. */
  private findRipgrep(): string | null {
    if (this.rgPath !== undefined) return this.rgPath;
    const bin = process.platform === 'win32' ? 'rg.exe' : 'rg';
    const candidates = ['node_modules', 'node_modules.asar.unpacked']
      .map(d => path.join(vscode.env.appRoot, d, '@vscode', 'ripgrep', 'bin', bin));
    for (const dir of (process.env.PATH || '').split(path.delimiter)) candidates.push(path.join(dir, bin));
    this.rgPath = candidates.find(isExecutable) ?? null;
    return this.rgPath;
  }
}

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function safeMtime(p: string): number {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}
