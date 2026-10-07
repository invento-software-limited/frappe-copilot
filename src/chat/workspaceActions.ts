import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

/** Opens a file link from the chat, selecting an `#L10-L20` range if given. */
export async function openFileLink(link: string): Promise<void> {
  try {
    const uri = vscode.Uri.parse(link);
    const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri.with({ fragment: '' })));
    const match = uri.fragment.match(/^L(\d+)(?:-L(\d+))?$/);
    if (!match) return;
    const start = Math.max(0, parseInt(match[1], 10) - 1);
    const end = match[2] ? Math.max(0, parseInt(match[2], 10) - 1) : start;
    const selection = new vscode.Selection(new vscode.Position(start, 0), new vscode.Position(end, 1000));
    editor.selection = selection;
    editor.revealRange(selection, vscode.TextEditorRevealType.InCenter);
  } catch (e) {
    console.error('Failed to open file from webview:', e);
  }
}

/** Saves a download from the chat. The webview iframe is sandboxed without
 *  allow-downloads, so the save has to happen on the extension host. */
export async function saveDownload(msg: { data?: string; defaultName?: string; encoding?: string }): Promise<void> {
  if (!msg.data) return;
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(root, msg.defaultName || 'download')),
    saveLabel: 'Save',
  });
  if (!uri) return;
  try {
    fs.writeFileSync(uri.fsPath, Buffer.from(msg.data, msg.encoding === 'base64' ? 'base64' : 'utf8'));
    vscode.window.showInformationMessage(`Frappe Copilot: saved ${path.basename(uri.fsPath)}`);
  } catch (e: any) {
    vscode.window.showErrorMessage(`Frappe Copilot: could not save file — ${e.message || e}`);
  }
}
