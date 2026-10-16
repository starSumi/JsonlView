import * as vscode from 'vscode';
import { type SessionPreview, SessionPreviews } from './session-previews';

/** Current-session scratch previews, independent of Agent discovery and catalog. */
export class RecentPreviewsTreeProvider implements vscode.TreeDataProvider<SessionPreview>, vscode.Disposable {
  readonly #changed = new vscode.EventEmitter<void>();
  readonly #registration: vscode.Disposable;
  public readonly onDidChangeTreeData = this.#changed.event;
  public constructor(private readonly previews: SessionPreviews) {
    this.#registration = previews.onDidChange(() => this.#changed.fire());
  }
  public register(): vscode.Disposable[] {
    return [
      vscode.window.createTreeView('jsonlView.recentPreviews', { treeDataProvider: this }),
      vscode.commands.registerCommand('jsonlView.previews.open', (node: unknown) => {
        const item = this.resolve(node);
        if (item !== undefined) return this.previews.reopen(item.id);
      }),
      vscode.commands.registerCommand('jsonlView.previews.saveAs', (node: unknown) => {
        const item = this.resolve(node);
        if (item !== undefined) return this.previews.saveAs(item.sourceUri);
      }),
      vscode.commands.registerCommand('jsonlView.previews.openSavedCopy', async (node: unknown) => {
        const item = this.resolve(node);
        if (item?.savedUri === undefined) return;
        try { await vscode.commands.executeCommand('vscode.openWith', item.savedUri, 'jsonlView.editor'); }
        catch { void vscode.window.showErrorMessage('The saved preview copy could not be opened.'); }
      }),
    ];
  }
  private resolve(node: unknown): SessionPreview | undefined {
    if (node === null || typeof node !== 'object' || !('id' in node) || typeof node.id !== 'string') return undefined;
    return this.previews.list().find((item) => item.id === node.id);
  }
  public getChildren(): SessionPreview[] { return [...this.previews.list()].reverse(); }
  public getTreeItem(preview: SessionPreview): vscode.TreeItem {
    const item = new vscode.TreeItem('Preview · ' + new Date(preview.createdAt).toLocaleTimeString(), vscode.TreeItemCollapsibleState.None);
    item.id = preview.id;
    item.contextValue = preview.savedUri === undefined ? 'jsonlView.preview.temporary' : 'jsonlView.preview.savedCopy';
    item.description = String(preview.recordCount) + ' records · ' + (preview.status === 'saving' ? 'Saving…' : preview.savedUri === undefined ? 'Temporary' : 'Saved copy');
    item.tooltip = new Date(preview.createdAt).toLocaleString() + '\n' + String(preview.sizeBytes) + ' UTF-8 bytes. Temporary source is recoverable during this VS Code session only. Save As keeps a permanent copy.';
    item.iconPath = new vscode.ThemeIcon(preview.status === 'saving' ? 'loading~spin' : 'file');
    item.command = { command: 'jsonlView.previews.open', title: 'Open temporary preview', arguments: [{ id: preview.id }] };
    return item;
  }
  public dispose(): void { this.#registration.dispose(); this.#changed.dispose(); }
}
