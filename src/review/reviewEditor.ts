import * as vscode from 'vscode';
import { ReviewController } from './reviewController';
import { Hunk } from './hunks';

export const BASELINE_SCHEME = 'frappe-copilot-baseline';
const CONTEXT_KEY = 'frappeCopilot.reviewPending';

/** Accept/reject inside the editor: green highlights on lines the agent
 *  added, a red marker (with the old text on hover) where it removed lines,
 *  and Accept / Reject CodeLens buttons above every hunk. */
export class ReviewEditor implements vscode.CodeLensProvider, vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly lensesChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.lensesChanged.event;
  private readonly baselineChanged = new vscode.EventEmitter<vscode.Uri>();
  /** Keeps an open "before" diff side in step as hunks are accepted. */
  readonly onDidChange = this.baselineChanged.event;
  private readonly added = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  private readonly removed = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderColor: new vscode.ThemeColor('editorGutter.deletedBackground'),
    borderStyle: 'solid',
    borderWidth: '2px 0 0 0',
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  private disposables: vscode.Disposable[] = [];

  constructor(private review: ReviewController) {
    this.disposables.push(
      review.onDidChange(() => this.redraw()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.redraw()),
      vscode.window.onDidChangeTextEditorSelection(() => this.updateContextKey()),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateContextKey()),
    );
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.review.baseline(uri.path.replace(/^\//, ''));
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.review.isTracked(doc.uri)) return [];
    const rel = this.review.relPath(doc.uri);
    const hunks = this.review.hunksFor(rel);
    if (hunks.length === 0) return [];
    const top = new vscode.Range(0, 0, 0, 0);
    const lenses = [
      new vscode.CodeLens(top, { title: `$(check-all) Accept file (${hunks.length} change${hunks.length > 1 ? 's' : ''})`, command: 'frappe-copilot.review.acceptFile', arguments: [rel] }),
      new vscode.CodeLens(top, { title: '$(discard) Reject file', command: 'frappe-copilot.review.rejectFile', arguments: [rel] }),
      new vscode.CodeLens(top, { title: '$(diff) Open diff', command: 'frappe-copilot.review.openDiff', arguments: [rel] }),
    ];
    hunks.forEach((h, i) => {
      const at = new vscode.Range(anchorLine(h, doc), 0, anchorLine(h, doc), 0);
      lenses.push(
        new vscode.CodeLens(at, { title: '$(check) Accept', tooltip: 'Keep this change (Alt+Enter)', command: 'frappe-copilot.review.acceptHunk', arguments: [rel, i] }),
        new vscode.CodeLens(at, { title: '$(close) Reject', tooltip: 'Undo this change (Shift+Alt+Backspace)', command: 'frappe-copilot.review.rejectHunk', arguments: [rel, i] }),
      );
    });
    return lenses;
  }

  /** The hunk under the cursor of the active editor, for keyboard shortcuts. */
  hunkAtCursor(): { rel: string; index: number } | null {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !this.review.isTracked(editor.document.uri)) return null;
    const rel = this.review.relPath(editor.document.uri);
    const line = editor.selection.active.line;
    const index = this.review.hunksFor(rel).findIndex(h => line >= h.currentStart && line <= Math.max(h.currentStart, h.currentStart + h.currentLines.length - 1));
    return index === -1 ? null : { rel, index };
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
    this.added.dispose();
    this.removed.dispose();
    this.lensesChanged.dispose();
    this.baselineChanged.dispose();
  }

  private redraw(): void {
    for (const editor of vscode.window.visibleTextEditors) this.decorate(editor);
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme === BASELINE_SCHEME) this.baselineChanged.fire(doc.uri);
    }
    this.lensesChanged.fire();
    this.updateContextKey();
  }

  private decorate(editor: vscode.TextEditor): void {
    const tracked = this.review.isTracked(editor.document.uri);
    const hunks = tracked ? this.review.hunksFor(this.review.relPath(editor.document.uri)) : [];
    const addedRanges: vscode.Range[] = [];
    const removedMarks: vscode.DecorationOptions[] = [];
    for (const h of hunks) {
      if (h.currentLines.length) addedRanges.push(new vscode.Range(h.currentStart, 0, h.currentStart + h.currentLines.length - 1, 0));
      if (h.baseLines.length) {
        const line = Math.min(h.currentStart, Math.max(0, editor.document.lineCount - 1));
        const hover = new vscode.MarkdownString().appendMarkdown(`**Removed ${h.baseLines.length} line(s):**`).appendCodeblock(h.baseLines.join(''), editor.document.languageId);
        removedMarks.push({ range: new vscode.Range(line, 0, line, 0), hoverMessage: hover });
      }
    }
    editor.setDecorations(this.added, addedRanges);
    editor.setDecorations(this.removed, removedMarks);
  }

  private updateContextKey(): void {
    void vscode.commands.executeCommand('setContext', CONTEXT_KEY, !!this.hunkAtCursor());
  }
}

/** Where a hunk's buttons go: its first new line, or where lines were removed. */
function anchorLine(h: Hunk, doc: vscode.TextDocument): number {
  return Math.min(h.currentStart, Math.max(0, doc.lineCount - 1));
}

/** Registers the review commands, CodeLens, highlights and diff view. */
export function registerReview(context: vscode.ExtensionContext, review: ReviewController): ReviewEditor {
  const editor = new ReviewEditor(review);
  const fromCursor = (fn: (rel: string, i: number) => Promise<void>) => async (rel?: string, index?: number) => {
    const target = typeof rel === 'string' && typeof index === 'number' ? { rel, index } : editor.hunkAtCursor();
    if (target) await fn(target.rel, target.index);
  };
  const fileArg = (rel?: string) => rel ?? (vscode.window.activeTextEditor && review.relPath(vscode.window.activeTextEditor.document.uri));

  context.subscriptions.push(
    editor,
    review,
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, editor),
    vscode.workspace.registerTextDocumentContentProvider(BASELINE_SCHEME, editor),
    vscode.commands.registerCommand('frappe-copilot.review.acceptHunk', fromCursor((r, i) => review.acceptHunk(r, i))),
    vscode.commands.registerCommand('frappe-copilot.review.rejectHunk', fromCursor((r, i) => review.rejectHunk(r, i))),
    vscode.commands.registerCommand('frappe-copilot.review.acceptFile', (rel?: string) => { const r = fileArg(rel); if (r) review.acceptFile(r); }),
    vscode.commands.registerCommand('frappe-copilot.review.rejectFile', async (rel?: string) => { const r = fileArg(rel); if (r) await review.rejectFile(r); }),
    vscode.commands.registerCommand('frappe-copilot.review.acceptAll', () => review.acceptAll()),
    vscode.commands.registerCommand('frappe-copilot.review.rejectAll', () => confirmRejectAll(review)),
    vscode.commands.registerCommand('frappe-copilot.review.openDiff', (rel: string) => openDiff(review, rel)),
  );
  return editor;
}

/** Rejecting everything can't be undone from the chat, so it asks first. */
export async function confirmRejectAll(review: ReviewController): Promise<void> {
  const count = review.pending().length;
  if (count === 0) return;
  const choice = await vscode.window.showWarningMessage(
    `Reject the agent's changes to ${count} file(s)? Each file goes back to how it was before the agent edited it.`,
    { modal: true }, 'Reject All'
  );
  if (choice === 'Reject All') await review.rejectAll();
}

/** Side-by-side diff: the file before the agent's edits vs now. */
export async function openDiff(review: ReviewController, rel: string): Promise<void> {
  const fileUri = vscode.Uri.file(review.absPath(rel));
  const before = vscode.Uri.from({ scheme: BASELINE_SCHEME, path: '/' + rel });
  await vscode.commands.executeCommand('vscode.diff', before, fileUri, `${rel} (agent changes)`);
}
