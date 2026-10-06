import * as fs from 'fs';
import * as path from 'path';
import type { GrepQuery } from './searchTools';

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', 'env', 'dist', '.frappe-copilot']);
const SKIP_EXT = /\.(min\.js|map|png|jpe?g|gif|ico|woff2?|ttf|eot|zip|gz|tar|pdf|lock|pyc)$/i;
const TYPE_EXT: Record<string, string[]> = {
  py: ['.py'], js: ['.js', '.mjs', '.cjs'], ts: ['.ts', '.tsx'], json: ['.json'],
  html: ['.html', '.htm'], css: ['.css', '.scss', '.less'], md: ['.md'], vue: ['.vue'], sql: ['.sql'],
};
const MAX_LINES = 5000;

/** Pure-JS grep used only when no ripgrep binary is available. Emits lines
 *  in ripgrep's format so both paths share one formatter. */
export function jsGrep(q: GrepQuery): string[] {
  const re = new RegExp(q.pattern, q.ignoreCase ? 'i' : '');
  const globRe = q.glob ? globToRegExp(q.glob) : null;
  const exts = q.type ? TYPE_EXT[q.type] : null;
  const out: string[] = [];

  const visit = (file: string) => {
    if (out.length >= MAX_LINES) return;
    const name = path.basename(file);
    if (SKIP_EXT.test(name)) return;
    if (exts && !exts.includes(path.extname(name))) return;
    if (globRe && !globRe.test(q.glob!.includes('/') ? path.relative(q.root, file) : name)) return;
    scanFile(file, re, q, out);
  };

  if (fs.statSync(q.root).isFile()) visit(q.root);
  else walk(q.root, visit);
  return out;
}

function walk(dir: string, visit: (file: string) => void): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(full, visit);
    } else if (e.isFile()) {
      visit(full);
    }
  }
}

function scanFile(file: string, re: RegExp, q: GrepQuery, out: string[]): void {
  let text: string;
  try {
    if (fs.statSync(file).size > 2 * 1024 * 1024) return;
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  if (text.includes('\0')) return;
  const lines = text.split('\n');
  const hits: number[] = [];
  lines.forEach((l, i) => { if (re.test(l)) hits.push(i); });
  if (hits.length === 0) return;

  if (q.mode === 'files_with_matches') return void out.push(file);
  if (q.mode === 'count') return void out.push(`${file}:${hits.length}`);

  const hitSet = new Set(hits);
  const shown = new Set<number>();
  for (const h of hits) {
    for (let i = Math.max(0, h - q.context); i <= Math.min(lines.length - 1, h + q.context); i++) {
      if (shown.has(i)) continue;
      shown.add(i);
      const sep = hitSet.has(i) ? ':' : '-';
      out.push(`${file}${sep}${i + 1}${sep}${lines[i].slice(0, 300)}`);
    }
  }
}

/** Minimal glob support: **, *, ?, and {a,b} alternation. */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
      if (glob[i + 1] === '/') i++;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') re += '(';
    else if (c === '}') re += ')';
    else if (c === ',') re += '|';
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
