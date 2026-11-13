import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

vi.mock('vscode', () => ({
  EventEmitter: class {
    event = (listener: (value: unknown) => void) => ({ dispose() {} });
    fire() {}
    dispose() {}
  },
  TreeItem: class {
    public id: string | undefined;
    public contextValue: string | undefined;
    public description: string | undefined;
    public iconPath: unknown;
    public command: unknown;
    constructor(public label: string, public collapsibleState: number) {}
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class { constructor(public id: string) {} },
  Uri: { parse: (value: string) => {
    const url = new URL(value);
    return { scheme: url.protocol.slice(0, -1), authority: url.host, fsPath: fileURLToPath(url), path: decodeURIComponent(url.pathname), toString: () => url.href };
  } },
  window: { showWarningMessage: vi.fn() },
}));

import { SourceNavigatorTreeProvider } from '../../src/experimental/session-navigator/source-tree-provider';

function localUri(name: string) {
  const fsPath = resolve(tmpdir(), name);
  const url = pathToFileURL(fsPath);
  return { scheme: 'file', fsPath, path: decodeURIComponent(url.pathname), toString: () => url.href };
}

describe('native Add Source tree', () => {
  it('preserves the exact native Uri when Explorer also supplies the same text/uri-list', async () => {
    const uri = localUri('sample.jsonl');
    const previewFile = vi.fn().mockResolvedValue(undefined);
    const provider = new SourceNavigatorTreeProvider({ action: vi.fn(), previewFile, authorizePath: vi.fn() });
    await provider.handleDrop(undefined, {
      forEach(callback: (item: unknown) => void) { callback({ asFile: () => ({ uri }) }); },
      get: () => ({ asString: async () => uri.toString() }),
    } as unknown as vscode.DataTransfer, { isCancellationRequested: false } as vscode.CancellationToken);
    expect(previewFile).toHaveBeenCalledOnce();
    expect(previewFile.mock.calls[0]![0]).toBe(uri);
  });
  it('exposes only the file, folder, and paste source actions', () => {
    const provider = new SourceNavigatorTreeProvider({
      action: vi.fn(), previewFile: vi.fn(), authorizePath: vi.fn(),
    });
    expect(provider.dropMimeTypes).toEqual(['files', 'text/uri-list']);
    const root = provider.getChildren()[0]!;
    expect(provider.getTreeItem(root)).toMatchObject({ label: 'Add source', description: 'Drop JSONL or folder here' });
    const children = provider.getChildren(root);
    expect(children.filter((node) => node.kind === 'action').map((node) => node.action)).toEqual(['files', 'folder', 'paste']);
    expect(children).toHaveLength(3);
  });

  it('routes native file handles to preview or authorization callbacks', async () => {
    const previewFile = vi.fn().mockResolvedValue(undefined);
    const authorizePath = vi.fn().mockResolvedValue(undefined);
    const provider = new SourceNavigatorTreeProvider({
      action: vi.fn(), previewFile, authorizePath,
    });
    const token = { isCancellationRequested: false } as vscode.CancellationToken;
    await provider.handleDrop(undefined, {
      forEach(callback: (item: vscode.DataTransferItem) => void) {
        callback({ asFile: () => ({ uri: localUri('sample.jsonl') }) } as unknown as vscode.DataTransferItem);
      },
      get: () => undefined,
    } as unknown as vscode.DataTransfer, token);
    expect(previewFile).toHaveBeenCalledTimes(1);
    expect(authorizePath).not.toHaveBeenCalled();
  });

  it('settles normally when a native preview is cancelled during async validation', async () => {
    const state = { isCancellationRequested: false };
    const previewFile = vi.fn(async (_uri: vscode.Uri, cancelled: () => boolean) => {
      await Promise.resolve();
      state.isCancellationRequested = true;
      if (cancelled()) throw new Error('Source preview was cancelled.');
    });
    const authorizePath = vi.fn().mockResolvedValue(undefined);
    const provider = new SourceNavigatorTreeProvider({ action: vi.fn(), previewFile, authorizePath });
    const token = state as vscode.CancellationToken;
    const uri = localUri('sample.jsonl');

    await expect(provider.handleDrop(undefined, {
      forEach(callback: (item: vscode.DataTransferItem) => void) {
        callback({ asFile: () => ({ uri }) } as unknown as vscode.DataTransferItem);
      },
      get: () => undefined,
    } as unknown as vscode.DataTransfer, token)).resolves.toBeUndefined();

    expect(previewFile).toHaveBeenCalledOnce();
    expect(authorizePath).not.toHaveBeenCalled();
  });

  it('rejects more than 32 native file handles before dispatching any callbacks', async () => {
    const previewFile = vi.fn().mockResolvedValue(undefined);
    const authorizePath = vi.fn().mockResolvedValue(undefined);
    const provider = new SourceNavigatorTreeProvider({ action: vi.fn(), previewFile, authorizePath });
    const token = { isCancellationRequested: false } as vscode.CancellationToken;
    const items = Array.from({ length: 33 }, (_, index) => ({
      asFile: () => ({ uri: localUri(`source-${String(index)}.jsonl`) }),
    } as unknown as vscode.DataTransferItem));
    await provider.handleDrop(undefined, {
      forEach(callback: (item: vscode.DataTransferItem) => void) { items.forEach(callback); },
      get: () => undefined,
    } as unknown as vscode.DataTransfer, token);
    expect(previewFile).not.toHaveBeenCalled();
    expect(authorizePath).not.toHaveBeenCalled();
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('32'));
  });

  it('rejects an oversized URI list before parsing or dispatching it', async () => {
    const previewFile = vi.fn().mockResolvedValue(undefined);
    const authorizePath = vi.fn().mockResolvedValue(undefined);
    const provider = new SourceNavigatorTreeProvider({ action: vi.fn(), previewFile, authorizePath });
    const token = { isCancellationRequested: false } as vscode.CancellationToken;
    const uriList = `file:///${'x'.repeat(65_000)}.jsonl`;
    await provider.handleDrop(undefined, {
      forEach() {},
      get: () => ({ asString: async () => uriList }),
    } as unknown as vscode.DataTransfer, token);
    expect(previewFile).not.toHaveBeenCalled();
    expect(authorizePath).not.toHaveBeenCalled();
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('32'));
  });
});
