import * as fs from 'fs';
import * as path from 'path';
import { ToolResult, ok, fail } from './result';
import { asBool, asInt, asJson, asString } from './args';
import { imageAttachment, imageMediaType } from './images';

const DEFAULT_READ_LINES = 2000;
const MAX_LINE_CHARS = 2000;
const MAX_READ_BYTES = 10 * 1024 * 1024;
const MAX_READ_OUTPUT_CHARS = 120_000;

interface EditSpec {
  search: string;
  replace: string;
  replace_all?: boolean;
}

/** read_file / write_file / edit_file / multi_edit with Claude Code-style
 *  safety: numbered reads with paging, and edits refused on a file the agent
 *  hasn't read, or that changed on disk since it last read it. */
export class FileTools {
  /** Absolute path -> mtimeMs at the agent's last read or write. */
  private seen = new Map<string, number>();

  constructor(private resolvePath: (rel: string) => Promise<string>) {}

  async read(args: Record<string, any>): Promise<ToolResult> {
    const rel = asString(args.path);
    if (!rel) return fail('Missing path parameter');
    const abs = await this.resolvePath(rel);
    if (!fs.existsSync(abs)) return fail(`File not found: ${rel}`);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) return fail(`'${rel}' is a directory. Use list_dir or glob instead.`);
    if (stat.size > MAX_READ_BYTES) return fail(`File '${rel}' is ${(stat.size / 1048576).toFixed(1)}MB — too large. Use grep_search to locate the relevant section.`);

    if (imageMediaType(abs)) return this.readImage(abs, rel);
    const text = fs.readFileSync(abs, 'utf8');
    if (text.includes('\0')) return fail(`'${rel}' looks like a binary file.`);
    this.markSeen(abs);
    if (text.length === 0) return ok(`(file '${rel}' exists but is empty)`);

    const offset = Math.max(1, asInt(args.offset) ?? 1);
    const limit = Math.max(1, asInt(args.limit) ?? DEFAULT_READ_LINES);
    return ok(numberLines(text.split('\n'), offset, limit, rel));
  }

  /** Image files come back as an attachment the model can look at. */
  private readImage(abs: string, rel: string): ToolResult {
    const { image, problem } = imageAttachment(abs);
    if (!image) return fail(`Can't show '${rel}': ${problem}.`);
    return ok(`Image '${rel}' is attached below.`, [image]);
  }

  async write(args: Record<string, any>): Promise<ToolResult> {
    const rel = asString(args.path);
    if (!rel) return fail('Missing path parameter');
    const abs = await this.resolvePath(rel);
    if (fs.existsSync(abs)) {
      const stale = this.staleReason(abs, rel);
      if (stale) return fail(stale);
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, asString(args.content) ?? '', 'utf8');
    this.markSeen(abs);
    return ok(`Successfully wrote ${rel}`);
  }

  async edit(args: Record<string, any>): Promise<ToolResult> {
    const search = asString(args.search ?? args.old_string);
    const replace = asString(args.replace ?? args.new_string);
    if (search === undefined || replace === undefined) return fail('Missing search or replace parameters');
    return this.applyEdits(args.path, [{ search, replace, replace_all: asBool(args.replace_all) }]);
  }

  async multiEdit(args: Record<string, any>): Promise<ToolResult> {
    const edits = asJson<EditSpec[]>(args.edits);
    if (!Array.isArray(edits) || edits.length === 0) {
      return fail('multi_edit needs a non-empty "edits" array of {search, replace, replace_all?}.');
    }
    return this.applyEdits(args.path, edits);
  }

  /** Applies every edit in memory first, so a failing edit leaves the file untouched. */
  private async applyEdits(rawPath: unknown, edits: EditSpec[]): Promise<ToolResult> {
    const rel = asString(rawPath);
    if (!rel) return fail('Missing path parameter');
    const abs = await this.resolvePath(rel);
    if (!fs.existsSync(abs)) return fail(`File not found: ${rel}. Use write_file to create a new file.`);
    const stale = this.staleReason(abs, rel);
    if (stale) return fail(stale);

    const original = fs.readFileSync(abs, 'utf8');
    const crlf = original.includes('\r\n');
    let content = original.replace(/\r\n/g, '\n');
    let firstChange = -1;

    for (let i = 0; i < edits.length; i++) {
      const res = applyOne(content, edits[i], rel);
      if (typeof res === 'string') return fail(edits.length > 1 ? `Edit #${i + 1} failed: ${res} No edits were applied.` : res);
      content = res.content;
      if (firstChange < 0) firstChange = res.index;
    }

    fs.writeFileSync(abs, crlf ? content.replace(/\n/g, '\r\n') : content, 'utf8');
    this.markSeen(abs);
    const label = edits.length > 1 ? `Applied ${edits.length} edits to ${rel}` : `Edited ${rel}`;
    return ok(`${label}. Snippet around the first change:\n${snippetAround(content, firstChange)}`);
  }

  private staleReason(abs: string, rel: string): string | null {
    const seenAt = this.seen.get(abs);
    if (seenAt === undefined) {
      return `You must read_file '${rel}' before modifying it, so the change is based on its current content.`;
    }
    if (fs.statSync(abs).mtimeMs !== seenAt) {
      return `'${rel}' changed on disk since you last read it (edited by the user or a tool). read_file it again before modifying.`;
    }
    return null;
  }

  private markSeen(abs: string): void {
    this.seen.set(abs, fs.statSync(abs).mtimeMs);
  }
}

/** Exact match first, then two recoveries for the most common model slips:
 *  line-number prefixes copied from read_file output, and trailing whitespace. */
function applyOne(content: string, e: EditSpec, rel: string): { content: string; index: number } | string {
  const search = (e.search ?? '').replace(/\r\n/g, '\n');
  const replace = (e.replace ?? '').replace(/\r\n/g, '\n');
  if (!search) return 'search must not be empty — use write_file to create or overwrite a whole file.';
  if (search === replace) return 'search and replace are identical; nothing to change.';

  const exact = replaceExact(content, search, replace, !!e.replace_all, rel);
  if (typeof exact !== 'string' || !exact.startsWith('NOT_FOUND')) return exact;

  const unnumbered = stripLineNumbers(search);
  if (unnumbered !== null) {
    const res = replaceExact(content, unnumbered, stripLineNumbers(replace) ?? replace, !!e.replace_all, rel);
    if (typeof res !== 'string' || !res.startsWith('NOT_FOUND')) return res;
  }

  const loose = replaceIgnoringTrailingSpace(content, search, replace, !!e.replace_all);
  if (loose) return loose;
  return `The search text was not found in '${rel}'. It must match the file exactly (indentation, blank lines). read_file the region again and copy the text without the line-number prefix.${nearestHint(content, search)}`;
}

function replaceExact(content: string, search: string, replace: string, all: boolean, rel: string): { content: string; index: number } | string {
  const count = content.split(search).length - 1;
  if (count === 0) return 'NOT_FOUND';
  if (count > 1 && !all) {
    return `The search text matches ${count} places in '${rel}'. Add surrounding lines to make it unique, or set replace_all to change every occurrence.`;
  }
  const index = content.indexOf(search);
  const next = all ? content.split(search).join(replace) : content.replace(search, () => replace);
  return { content: next, index };
}

function replaceIgnoringTrailingSpace(content: string, search: string, replace: string, all: boolean): { content: string; index: number } | null {
  const lines = content.split('\n');
  const want = search.split('\n').map(l => l.trimEnd());
  const hits: number[] = [];
  for (let i = 0; i + want.length <= lines.length; i++) {
    if (want.every((w, k) => lines[i + k].trimEnd() === w)) hits.push(i);
  }
  if (hits.length === 0 || (hits.length > 1 && !all)) return null;
  const repl = replace.split('\n');
  for (const start of [...hits].reverse()) lines.splice(start, want.length, ...repl);
  const index = lines.slice(0, hits[0]).join('\n').length;
  return { content: lines.join('\n'), index };
}

function stripLineNumbers(text: string): string | null {
  const lines = text.split('\n');
  const numbered = /^\s*\d+\t/;
  if (!lines.filter(l => l.trim()).every(l => numbered.test(l))) return null;
  return lines.map(l => l.replace(numbered, '')).join('\n');
}

function nearestHint(content: string, search: string): string {
  const first = search.split('\n').map(l => l.trim()).find(l => l.length > 3);
  if (!first) return '';
  const lines = content.split('\n');
  const at = lines.findIndex(l => l.includes(first));
  if (at < 0) return '';
  return `\nThe first search line does appear near line ${at + 1}:\n${snippetLines(lines, at, at + 4)}`;
}

function numberLines(lines: string[], offset: number, limit: number, rel: string): string {
  if (offset > lines.length) return `(offset ${offset} is past the end of '${rel}', which has ${lines.length} lines)`;
  const end = Math.min(lines.length, offset - 1 + limit);
  let out = '';
  let lastLine = offset - 1;
  for (let i = offset - 1; i < end; i++) {
    const line = lines[i].length > MAX_LINE_CHARS ? lines[i].slice(0, MAX_LINE_CHARS) + '… [line truncated]' : lines[i];
    const row = `${String(i + 1).padStart(6)}\t${line}\n`;
    if (out.length + row.length > MAX_READ_OUTPUT_CHARS) break;
    out += row;
    lastLine = i + 1;
  }
  if (lastLine < lines.length) {
    out += `\n[Showing lines ${offset}-${lastLine} of ${lines.length}. Pass offset=${lastLine + 1} to continue.]`;
  }
  return out;
}

function snippetAround(content: string, index: number): string {
  const lines = content.split('\n');
  const line = Math.max(0, content.slice(0, Math.max(0, index)).split('\n').length - 1);
  return snippetLines(lines, Math.max(0, line - 3), line + 8);
}

function snippetLines(lines: string[], from: number, to: number): string {
  return lines.slice(from, Math.min(lines.length, to))
    .map((l, k) => `${String(from + k + 1).padStart(6)}\t${l}`)
    .join('\n');
}
