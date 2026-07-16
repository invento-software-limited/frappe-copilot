import * as vscode from 'vscode';
import { SkillsStore, SkillMeta } from './skillsStore';

/** Sidebar tree view for the skills library — mirrors SessionManager's
 *  TreeDataProvider implementation. Editing happens in the native VS Code
 *  text editor, not an in-webview UI. */
export class SkillsProvider implements vscode.TreeDataProvider<SkillItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SkillItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private store: SkillsStore) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: SkillItem): vscode.TreeItem {
    return element;
  }

  getChildren(): SkillItem[] {
    return this.store.listSkills().map(s => new SkillItem(s));
  }

  getParent(): vscode.ProviderResult<SkillItem> {
    return null; // flat list, no parent
  }
}

export class SkillItem extends vscode.TreeItem {
  constructor(public readonly skill: SkillMeta) {
    super(skill.name, vscode.TreeItemCollapsibleState.None);
    this.tooltip = skill.description || skill.name;
    this.description = skill.description;
    this.contextValue = 'frappeSkill';
    this.iconPath = new vscode.ThemeIcon('symbol-snippet');
    this.command = {
      command: 'frappe-copilot.openSkill',
      title: 'Open Skill',
      arguments: [skill.id]
    };
  }
}
