import * as fs from 'fs';
import * as path from 'path';

/** What a file looked like before the agent first touched it, since the
 *  user last accepted it. `null` means the agent created the file. */
export interface ReviewEntry {
  baseline: string | null;
}

interface ReviewFile {
  files: Record<string, ReviewEntry>;
}

/** Files the agent changed that the user hasn't accepted or rejected yet,
 *  saved to `.frappe-copilot/review.json` so a reload keeps them pending.
 *  Keys are workspace-relative paths with forward slashes. */
export class ReviewStore {
  private entries = new Map<string, ReviewEntry>();

  constructor(private file: string | null) {
    this.load();
  }

  /** Records a file's pre-edit content — only the first time, so the
   *  baseline stays what the user last saw, across several agent runs. */
  track(relPath: string, baseline: string | null): boolean {
    const key = normalize(relPath);
    if (this.entries.has(key)) return false;
    this.entries.set(key, { baseline });
    this.save();
    return true;
  }

  get(relPath: string): ReviewEntry | undefined {
    return this.entries.get(normalize(relPath));
  }

  setBaseline(relPath: string, baseline: string): void {
    this.entries.set(normalize(relPath), { baseline });
    this.save();
  }

  remove(relPath: string): void {
    if (this.entries.delete(normalize(relPath))) this.save();
  }

  paths(): string[] {
    return [...this.entries.keys()];
  }

  private load(): void {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as ReviewFile;
      for (const [key, entry] of Object.entries(data.files || {})) this.entries.set(key, entry);
    } catch (e) {
      console.warn(`[frappe-copilot] Could not read ${this.file}; pending reviews start empty:`, e instanceof Error ? e.message : e);
    }
  }

  private save(): void {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const data: ReviewFile = { files: Object.fromEntries(this.entries) };
      fs.writeFileSync(this.file, JSON.stringify(data), 'utf-8');
    } catch (e) {
      console.warn(`[frappe-copilot] Could not save ${this.file}:`, e instanceof Error ? e.message : e);
    }
  }
}

function normalize(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/^\.\//, '');
}
