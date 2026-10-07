/** A minimal stand-in for the `vscode` module so extension code runs under
 *  plain Node in tests. Settings live in `settings` and the workspace root in
 *  `setWorkspace`; window prompts resolve to `promptAnswers` (default: none). */

export const settings = new Map<string, unknown>();
export const shownMessages: { level: string; text: string }[] = [];
export const promptAnswers: { warning?: string } = {};
let folders: { uri: Uri; name: string; index: number }[] | undefined;

export function setWorkspace(root: string | null): void {
  folders = root ? [{ uri: Uri.file(root), name: 'test', index: 0 }] : undefined;
}

export function resetStub(): void {
  settings.clear();
  shownMessages.length = 0;
  delete promptAnswers.warning;
}

export class Uri {
  private constructor(readonly scheme: string, readonly fsPath: string, readonly fragment = '') {}
  static file(p: string): Uri { return new Uri('file', p); }
  static parse(s: string): Uri {
    const [base, fragment = ''] = s.split('#');
    return new Uri('file', base.replace(/^file:\/\//, ''), fragment);
  }
  with(change: { fragment?: string }): Uri { return new Uri(this.scheme, this.fsPath, change.fragment ?? this.fragment); }
  toString(): string { return `file://${this.fsPath}${this.fragment ? '#' + this.fragment : ''}`; }
}

export class EventEmitter<T> {
  private listeners: ((e: T) => void)[] = [];
  event = (listener: (e: T) => void) => { this.listeners.push(listener); return { dispose() {} }; };
  fire(e: T): void { this.listeners.forEach(l => l(e)); }
  dispose(): void { this.listeners = []; }
}

export class TreeItem { constructor(public label: string, public collapsibleState?: number) {} }
export class ThemeIcon { constructor(public id: string) {} }
export class Position { constructor(public line: number, public character: number) {} }
export class Selection { constructor(public anchor: Position, public active: Position) {} }
export class RelativePattern { constructor(public base: unknown, public pattern: string) {} }
export class Disposable { constructor(private fn: () => void = () => {}) {} dispose(): void { this.fn(); } }

export class Range { constructor(public start: unknown, public end: unknown) {} }
export class WorkspaceEdit {
  replace(): void {}
  deleteFile(): void {}
}

export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
export const ViewColumn = { One: 1, Two: 2 };
export const TextEditorRevealType = { InCenter: 2 };

function configuration(section?: string) {
  const key = (k: string) => (section ? `${section}.${k}` : k);
  return {
    get<T>(k: string, fallback?: T): T { return (settings.has(key(k)) ? settings.get(key(k)) : fallback) as T; },
    has(k: string): boolean { return settings.has(key(k)); },
    inspect<T>(k: string) { return settings.has(key(k)) ? { globalValue: settings.get(key(k)) as T } : undefined; },
    async update(k: string, value: unknown): Promise<void> { settings.set(key(k), value); },
  };
}

const noopWatcher = { onDidChange: () => ({ dispose() {} }), onDidCreate: () => ({ dispose() {} }), onDidDelete: () => ({ dispose() {} }), dispose() {} };

export const workspace = {
  get workspaceFolders() { return folders; },
  getConfiguration: configuration,
  onDidChangeConfiguration: () => ({ dispose() {} }),
  createFileSystemWatcher: () => noopWatcher,
  findFiles: async () => [],
  asRelativePath: (p: string | Uri) => (typeof p === 'string' ? p : p.fsPath),
  openTextDocument: async () => ({}),
  textDocuments: [] as unknown[],
  onDidChangeTextDocument: () => ({ dispose() {} }),
  onDidSaveTextDocument: () => ({ dispose() {} }),
  applyEdit: async () => false,
};

const record = (level: string) => async (text: string) => { shownMessages.push({ level, text }); return undefined; };
export const window = {
  showInformationMessage: record('info'),
  showErrorMessage: record('error'),
  showWarningMessage: async (text: string) => { shownMessages.push({ level: 'warning', text }); return promptAnswers.warning; },
  showInputBox: async () => undefined,
  showQuickPick: async () => undefined,
  showSaveDialog: async () => undefined,
  showOpenDialog: async () => undefined,
  showTextDocument: async () => ({ selection: null, revealRange() {} }),
  createOutputChannel: () => ({ appendLine() {}, append() {}, show() {}, dispose() {} }),
  createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
  withProgress: async (_o: unknown, task: (p: unknown) => Promise<unknown>) => task({ report() {} }),
  activeTextEditor: undefined,
};

export const commands = {
  executeCommand: async () => undefined,
  registerCommand: () => ({ dispose() {} }),
};
