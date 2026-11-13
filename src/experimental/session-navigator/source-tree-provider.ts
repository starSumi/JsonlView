import { isAbsolute } from 'node:path';
import * as vscode from 'vscode';
import { hasJsonlExtension } from './source-intake-contract';
import { SOURCE_INTAKE_MAX_SOURCES, SOURCE_INTAKE_MAX_URI_LENGTH, SOURCE_INTAKE_MAX_URI_LIST_CHARS } from './source-intake-limits';

export type SourceTreeAction = 'files' | 'folder' | 'paste';

type SourceTreeNode =
  | { readonly kind: 'root' }
  | { readonly kind: 'action'; readonly action: SourceTreeAction };

export interface SourceTreeCallbacks {
  readonly action: (action: SourceTreeAction) => void | Promise<void>;
  readonly previewFile: (uri: vscode.Uri, cancelled: () => boolean) => Promise<void>;
  readonly authorizePath: (uri: vscode.Uri, cancelled: () => boolean) => Promise<void>;
}

/** Native Add Source surface. OS drops are handled by VS Code before they reach extension code. */
export class SourceNavigatorTreeProvider implements vscode.TreeDataProvider<SourceTreeNode>, vscode.TreeDragAndDropController<SourceTreeNode>, vscode.Disposable {
  readonly #changed = new vscode.EventEmitter<SourceTreeNode | undefined | null | void>();
  readonly #callbacks: SourceTreeCallbacks;
  readonly #root: SourceTreeNode = { kind: 'root' };
  #disposed = false;

  public readonly onDidChangeTreeData = this.#changed.event;
  public readonly dropMimeTypes = ['files', 'text/uri-list'];
  public readonly dragMimeTypes: string[] = [];

  public constructor(callbacks: SourceTreeCallbacks) {
    this.#callbacks = callbacks;
  }

  public getTreeItem(node: SourceTreeNode): vscode.TreeItem {
    if (node.kind === 'root') {
      const item = new vscode.TreeItem('Add source', vscode.TreeItemCollapsibleState.Expanded);
      item.id = 'jsonlView.sourceDrop.root';
      item.contextValue = 'jsonlView.sourceDrop.root';
      item.iconPath = new vscode.ThemeIcon('add');
      item.description = 'Drop JSONL or folder here';
      return item;
    }
    if (node.kind === 'action') {
      const labels: Record<SourceTreeAction, [string, string, string]> = {
        files: ['Files', 'JSONL and NDJSON', 'file'],
        folder: ['Folder', 'A local source folder', 'folder'],
        paste: ['Paste', 'Paste JSONL for a temporary preview', 'edit'],
      };
      const [label, description, icon] = labels[node.action];
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
      item.id = `jsonlView.sourceDrop.${node.action}`;
      item.contextValue = 'jsonlView.sourceDrop.action';
      item.description = description;
      item.iconPath = new vscode.ThemeIcon(icon);
      item.command = { command: `jsonlView.sessionNavigator.source.${node.action}`, title: label, arguments: [] };
      return item;
    }
    throw new Error('Unknown Add Source tree node.');
  }

  public getChildren(node?: SourceTreeNode): SourceTreeNode[] {
    if (node === undefined) return [this.#root];
    if (node.kind === 'root') {
      return [
        { kind: 'action', action: 'files' },
        { kind: 'action', action: 'folder' },
        { kind: 'action', action: 'paste' },
      ];
    }
    return [];
  }

  public refresh(): void {
    if (!this.#disposed) this.#changed.fire(undefined);
  }

  public async handleDrop(_target: SourceTreeNode | undefined, dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): Promise<void> {
    if (token.isCancellationRequested || this.#disposed) return;
    const candidates = new Map<string, vscode.Uri>();
    let exceedsLimit = false;
    dataTransfer.forEach((item) => {
      if (exceedsLimit) return;
      const file = item.asFile();
      if (file?.uri?.scheme === 'file' && isLocalPath(file.uri.fsPath)) {
        const key = file.uri.toString();
        if (!candidates.has(key) && candidates.size === SOURCE_INTAKE_MAX_SOURCES) exceedsLimit = true;
        else candidates.set(key, file.uri);
      }
    });
    if (exceedsLimit) {
      void vscode.window.showWarningMessage(`Drop up to ${String(SOURCE_INTAKE_MAX_SOURCES)} local sources at a time.`);
      return;
    }
    const uriList = dataTransfer.get('text/uri-list');
    if (uriList !== undefined) {
      const text = await uriList.asString();
      if (token.isCancellationRequested || this.#disposed) return;
      if (text.length > SOURCE_INTAKE_MAX_URI_LIST_CHARS) {
        void vscode.window.showWarningMessage(`Drop up to ${String(SOURCE_INTAKE_MAX_SOURCES)} local sources at a time.`);
        return;
      }
      for (const line of text.split(/\r?\n/u)) {
        const value = line.trim();
        if (!value || value.startsWith('#')) continue;
        if (value.length > SOURCE_INTAKE_MAX_URI_LENGTH) {
          exceedsLimit = true;
          break;
        }
        try {
          const uri = vscode.Uri.parse(value);
          if (uri.scheme === 'file' && isLocalUri(uri)) {
            const key = uri.toString();
            if (!candidates.has(key) && candidates.size === SOURCE_INTAKE_MAX_SOURCES) {
              exceedsLimit = true;
              break;
            }
            if (!candidates.has(key)) candidates.set(key, uri);
          }
        } catch {
          // Ignore malformed transfer items and continue with valid candidates.
        }
      }
    }
    if (exceedsLimit) {
      void vscode.window.showWarningMessage(`Drop up to ${String(SOURCE_INTAKE_MAX_SOURCES)} local sources at a time.`);
      return;
    }
    const unique = [...candidates.values()];
    if (unique.length === 0) {
      void vscode.window.showWarningMessage('Drop a local JSONL file or folder onto Add source.');
      return;
    }
    const cancelled = () => token.isCancellationRequested || this.#disposed;
    for (const uri of unique) {
      if (cancelled()) return;
      try {
        if (hasJsonlExtension(uri.path)) await this.#callbacks.previewFile(uri, cancelled);
        else await this.#callbacks.authorizePath(uri, cancelled);
      } catch (error) {
        if (cancelled()) return;
        throw error;
      }
    }
  }

  public dispose(): void {
    this.#disposed = true;
    this.#changed.dispose();
  }
}

function isLocalPath(path: string): boolean {
  return isAbsolute(path) && !/^[\\/]{2}/u.test(path);
}

function isLocalUri(uri: vscode.Uri): boolean {
  return (uri.authority === undefined || uri.authority === '') && isLocalPath(uri.fsPath);
}
