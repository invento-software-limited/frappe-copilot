import * as vscode from 'vscode';

export type ApprovalMode = 'ask' | 'auto';

/** Single source of truth for whether high-risk agent actions need confirming.
 *  Read fresh on every call rather than cached: the mode is toggled from the
 *  chat UI mid-session, and a stale copy would leave an in-flight run still
 *  prompting (or, worse, still auto-approving) under the old setting. */
export function getApprovalMode(): ApprovalMode {
  const mode = vscode.workspace.getConfiguration('frappe-copilot').get<string>('approvalMode', 'ask');
  return mode === 'auto' ? 'auto' : 'ask';
}

export function isAutoApprove(): boolean {
  return getApprovalMode() === 'auto';
}
