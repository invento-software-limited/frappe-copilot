import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ReviewStore } from './reviewStore';
import { Hunk, acceptHunk, changeStats, computeHunks, rejectHunk } from './hunks';

/** One file with pending agent changes, as the chat's review bar shows it. */
export interface PendingFile {
  path: string;
  added: number;
  removed: number;
  isNew: boolean;
}

/** Accept/reject review of the agent's edits. Edits land on disk right away
 *  (the agent runs migrations and tests against them); this keeps what each
 *  file looked like before, so the user can keep or undo every change — all
 *  at once, per file, or hunk by hunk. */
export class ReviewController implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires whenever the set of pending changes may have changed. */
  readonly onDidChange = this.changed.event;
  private disposables: vscode.Disposable[] = [];
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private root: string, private store: ReviewStore) {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument(e => { if (this.isTracked(e.document.uri)) this.scheduleRefresh(); }),
      vscode.workspace.onDidSaveTextDocument(doc => { if (this.isTracked(doc.uri)) this.scheduleRefresh(); }),
    );
  }

  /** Called before the agent writes a file. `before` is null for a new file,
   *  undefined when the file was too big to snapshot (not reviewable). */
  track(relPath: string, before: string | null | undefined): void {
    if (before === undefined) return;
    this.store.track(relPath, before);
  }

  /** Re-reads pending files after the agent (or the user) changed them. */
  refresh(): void {
    for (const rel of this.store.paths()) {
      if (this.hunksFor(rel).length === 0 && !this.createdAndExists(rel)) this.store.remove(rel);
    }
    this.changed.fire();
  }

  pending(): PendingFile[] {
    return this.store.paths().map(rel => {
      const isNew = this.store.get(rel)?.baseline === null;
      return { path: rel, isNew, ...changeStats(this.hunksFor(rel)) };
    });
  }

  hunksFor(relPath: string): Hunk[] {
    const entry = this.store.get(relPath);
    if (!entry) return [];
    const current = this.currentText(relPath);
    if (current === null) return [];
    return computeHunks(entry.baseline ?? '', current);
  }

  baseline(relPath: string): string {
    return this.store.get(relPath)?.baseline ?? '';
  }

  absPath(relPath: string): string {
    return path.resolve(this.root, relPath);
  }

  relPath(uri: vscode.Uri): string {
    return path.relative(this.root, uri.fsPath).replace(/\\/g, '/');
  }

  isTracked(uri: vscode.Uri): boolean {
    return uri.scheme === 'file' && !!this.store.get(this.relPath(uri));
  }

  async acceptHunk(relPath: string, index: number): Promise<void> {
    const hunk = this.hunksFor(relPath)[index];
    if (!hunk) return;
    this.store.setBaseline(relPath, acceptHunk(this.baseline(relPath), hunk));
    this.refresh();
  }

  async rejectHunk(relPath: string, index: number): Promise<void> {
    const hunk = this.hunksFor(relPath)[index];
    const current = this.currentText(relPath);
    if (!hunk || current === null) return;
    await this.writeCurrent(relPath, rejectHunk(current, hunk));
    this.refresh();
  }

  acceptFile(relPath: string): void {
    this.store.remove(relPath);
    this.changed.fire();
  }

  /** Restores the file as it was before the agent touched it — deleting it
   *  if the agent created it. */
  async rejectFile(relPath: string): Promise<void> {
    const entry = this.store.get(relPath);
    if (!entry) return;
    if (entry.baseline === null) await this.deleteFile(relPath);
    else await this.writeCurrent(relPath, entry.baseline);
    this.store.remove(relPath);
    this.changed.fire();
  }

  acceptAll(): void {
    for (const rel of this.store.paths()) this.store.remove(rel);
    this.changed.fire();
  }

  async rejectAll(): Promise<void> {
    for (const rel of this.store.paths()) await this.rejectFile(rel);
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.disposables.forEach(d => d.dispose());
    this.changed.dispose();
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => { this.refreshTimer = null; this.refresh(); }, 150);
  }

  /** A created file stays pending (as an all-new file) until accepted. */
  private createdAndExists(relPath: string): boolean {
    return this.store.get(relPath)?.baseline === null && this.currentText(relPath) !== null;
  }

  /** The open editor's text when the file is open (it may be unsaved), else disk. */
  private currentText(relPath: string): string | null {
    const abs = path.resolve(this.root, relPath);
    const doc = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && d.uri.fsPath === abs);
    if (doc) return doc.getText();
    try {
      return fs.readFileSync(abs, 'utf-8');
    } catch {
      return null; // deleted since — nothing left to review
    }
  }

  /** Writes through an open editor (keeping its undo stack) or to disk. */
  private async writeCurrent(relPath: string, text: string): Promise<void> {
    const abs = path.resolve(this.root, relPath);
    const doc = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && d.uri.fsPath === abs);
    if (!doc) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, text, 'utf-8');
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text);
    await vscode.workspace.applyEdit(edit);
    await doc.save();
  }

  private async deleteFile(relPath: string): Promise<void> {
    const abs = path.resolve(this.root, relPath);
    if (!fs.existsSync(abs)) return;
    const edit = new vscode.WorkspaceEdit();
    edit.deleteFile(vscode.Uri.file(abs), { ignoreIfNotExists: true });
    if (!(await vscode.workspace.applyEdit(edit))) fs.rmSync(abs);
  }
}
