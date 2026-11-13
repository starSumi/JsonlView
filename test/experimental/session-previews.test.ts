import { mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type * as vscode from 'vscode';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ dialog: vi.fn(), open: vi.fn(), error: vi.fn(), info: vi.fn(),
  commands: new Map<string, (node: unknown) => unknown>(),
  writeTarget: '', failWrite: false, replaceTarget: false, overwriteBeforeRead: false, beforeWrite: undefined as undefined | (() => Promise<void>),
}));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    if (args[0] !== host.writeTarget || args[1] !== 'wx+') return handle;
    return new Proxy(handle, { get(target, property) {
      if (property === 'read' && host.overwriteBeforeRead) return async (...values: unknown[]) => {
        host.overwriteBeforeRead = false;
        await actual.writeFile(host.writeTarget, 'external changed');
        return Reflect.apply(target.read, target, values);
      };
      if (property === 'writeFile') return async (bytes: Buffer) => {
        await host.beforeWrite?.();
        if (host.failWrite) {
          await target.writeFile(bytes.subarray(0, 1));
          if (host.replaceTarget) { await actual.rename(host.writeTarget, host.writeTarget + '.partial'); await actual.writeFile(host.writeTarget, 'replacement'); }
          throw new Error('synthetic disk full');
        }
        return target.writeFile(bytes);
      };
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
});
function uri(path: string): vscode.Uri {
  return { scheme: 'file', authority: '', query: '', fragment: '', fsPath: path, toString: () => pathToFileURL(path).toString() } as vscode.Uri;
}
vi.mock('vscode', () => ({
  EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
  TreeItem: class { constructor(public label: string, public collapsibleState: number) {} },
  TreeItemCollapsibleState: { None: 0 }, ThemeIcon: class { constructor(public id: string) {} },
  Uri: { file: uri },
  window: { showSaveDialog: host.dialog, showErrorMessage: host.error, showInformationMessage: host.info, createTreeView: () => ({ dispose() {} }) },
  commands: { executeCommand: host.open, registerCommand: (id: string, handler: (node: unknown) => unknown) => { host.commands.set(id, handler); return { dispose() {} }; } },
}));
import { derivePreviewFilename, SessionPreviews } from '../../src/experimental/session-navigator/session-previews';
import { RecentPreviewsTreeProvider } from '../../src/experimental/session-navigator/recent-previews';

let previews: SessionPreviews;
let directory: string;
beforeEach(async () => {
  previews = new SessionPreviews();
  directory = await mkdtemp(join(tmpdir(), 'jsonlview-preview-save-test-'));
  host.dialog.mockReset().mockResolvedValue(undefined);
  host.open.mockReset().mockResolvedValue(undefined);
  host.error.mockReset(); host.info.mockReset();
  host.commands.clear(); host.writeTarget = ''; host.failWrite = false; host.replaceTarget = false; host.overwriteBeforeRead = false; host.beforeWrite = undefined;
});
afterEach(async () => { await previews.dispose(); await rm(directory, { recursive: true, force: true }); });
const signal = (): AbortSignal => new AbortController().signal;

it('keeps metadata only and reopens a preview during this session', async () => {
  const preview = await previews.create('{"synthetic":"秘密"}\r\n', 1, signal());
  expect(previews.list()).toEqual([expect.objectContaining({ id: preview!.id, recordCount: 1, status: 'temporary' })]);
  expect(JSON.stringify(previews.list())).not.toContain('秘密');
  await previews.reopen(preview!.id);
  expect(host.open).toHaveBeenCalledWith('vscode.openWith', preview!.sourceUri, 'jsonlView.editor');
  const tree = new RecentPreviewsTreeProvider(previews); tree.register();
  const [node] = tree.getChildren();
  expect(tree.getTreeItem(node!).description).toContain('1 records');
  await host.commands.get('jsonlView.previews.open')!({ id: node!.id });
  expect(host.open).toHaveBeenCalledTimes(2);
  await host.commands.get('jsonlView.previews.open')!({ id: 'forged', sourceUri: uri(join(directory, 'other')) });
  expect(host.open).toHaveBeenCalledTimes(2); tree.dispose();
});

it('cancels without losing the original and saves exact UTF-8 Unicode and CRLF bytes', async () => {
  const text = '{"synthetic":"文😀"}\r\nnull\r\n';
  const preview = (await previews.create(text, 2, signal()))!;
  expect(await previews.saveAs(preview.sourceUri)).toBe('cancelled');
  expect(previews.get(preview.sourceUri)?.status).toBe('temporary');
  const target = uri(join(directory, 'saved.jsonl'));
  host.dialog.mockResolvedValue(target);
  expect(await previews.saveAs(preview.sourceUri)).toBe('saved');
  expect(await readFile(target.fsPath)).toEqual(Buffer.from(text, 'utf8'));
  expect(previews.get(preview.sourceUri)?.status).toBe('saved');
  expect(previews.get(preview.sourceUri)?.savedUri?.toString()).toBe(target.toString());
  await previews.dispose();
  expect(await readFile(target.fsPath, 'utf8')).toBe(text);
  await expect(readFile(preview.sourceUri.fsPath)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('opens Save As with a bounded default filename outside the owned temporary directory', async () => {
  const preview = (await previews.create('{}\n', 1, signal()))!;
  expect(await previews.saveAs(preview.sourceUri)).toBe('cancelled');
  const options = host.dialog.mock.calls[0]?.[0] as { defaultUri?: vscode.Uri } | undefined;
  expect(options?.defaultUri?.fsPath).toBe(join(dirname(dirname(preview.sourceUri.fsPath)), basename(preview.sourceUri.fsPath)));
  expect(options?.defaultUri?.fsPath).toMatch(/\.jsonl$/iu);
  expect(options?.defaultUri?.fsPath).not.toBe(preview.sourceUri.fsPath);
});

it.each([
  ['sample.ndjson', 'sample.ndjson'],
  ['sample.txt', 'sample.jsonl'],
  ['CON', 'jsonlview-preview-preview-1.jsonl'],
  ['', 'jsonlview-preview-preview-1.jsonl'],
] as const)('normalizes the Save As filename for %s', (name, expected) => {
  expect(derivePreviewFilename(name === '' ? uri('') : uri(join(directory, name)), 'preview-1')).toBe(expected);
});

it('bounds a hostile source basename without dropping the JSONL extension', () => {
  const longName = 'x'.repeat(240) + '.jsonl';
  const filename = derivePreviewFilename(uri(join(directory, longName)), 'preview-1');
  expect(filename).toHaveLength(120);
  expect(filename).toMatch(/\.jsonl$/u);
});

it('refuses an existing destination and preserves the temporary preview', async () => {
  const preview = (await previews.create('{}\n', 1, signal()))!;
  const target = uri(join(directory, 'existing.jsonl'));
  await writeFile(target.fsPath, 'existing');
  host.dialog.mockResolvedValue(target);
  expect(await previews.saveAs(preview.sourceUri)).toBe('failed');
  expect(await readFile(target.fsPath, 'utf8')).toBe('existing');
  expect(await readFile(preview.sourceUri.fsPath, 'utf8')).toBe('{}\n');
  expect(previews.get(preview.sourceUri)?.status).toBe('temporary');
});

it('coalesces concurrent saves and settles a dialog that returns after its owner becomes stale', async () => {
  const preview = (await previews.create('{}', 1, signal()))!;
  let choose!: (target: vscode.Uri) => void;
  host.dialog.mockImplementation(() => new Promise<vscode.Uri>((resolve) => { choose = resolve; }));
  let current = true;
  const first = previews.saveAs(preview.sourceUri, () => current);
  const second = previews.saveAs(preview.sourceUri, () => current);
  expect(previews.get(preview.sourceUri)?.status).toBe('saving');
  expect(host.dialog).toHaveBeenCalledTimes(1);
  current = false;
  const target = uri(join(directory, 'late.jsonl'));
  choose(target);
  expect(await first).toBe('cancelled'); expect(await second).toBe('cancelled');
  await expect(readFile(target.fsPath)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(previews.get(preview.sourceUri)?.status).toBe('temporary');
});

it('settles a late dialog on disposal and retains externally edited preview files', async () => {
  const preview = (await previews.create('{}', 1, signal()))!;
  let choose!: (target: vscode.Uri) => void;
  host.dialog.mockImplementation(() => new Promise<vscode.Uri>((resolve) => { choose = resolve; }));
  const saving = previews.saveAs(preview.sourceUri);
  await writeFile(preview.sourceUri.fsPath, 'externally edited');
  const disposing = previews.dispose();
  choose(uri(join(directory, 'disposed.jsonl')));
  expect(await saving).toBe('cancelled'); await disposing;
  expect(await readFile(preview.sourceUri.fsPath, 'utf8')).toBe('externally edited');
  await rm(preview.sourceUri.fsPath);
  await rmdir(dirname(preview.sourceUri.fsPath));
});

it('keeps a successfully saved copy when opening it fails', async () => {
  const preview = (await previews.create('{}', 1, signal()))!;
  const target = uri(join(directory, 'saved-open-failed.jsonl'));
  host.dialog.mockResolvedValue(target); host.open.mockRejectedValue(new Error('synthetic'));
  expect(await previews.saveAs(preview.sourceUri)).toBe('saved-open-failed');
  expect(previews.get(preview.sourceUri)?.status).toBe('saved');
  expect(await readFile(target.fsPath, 'utf8')).toBe('{}');
});

it.each(['saved', 'saved-open-failed'] as const)('publishes one follow-up after the open attempt settles as %s', async (outcome) => {
  const preview = (await previews.create('{}', 1, signal()))!;
  const target = uri(join(directory, 'follow-up.jsonl'));
  let settleOpen!: () => void;
  host.dialog.mockResolvedValue(target);
  host.open.mockImplementationOnce(() => new Promise<void>((resolve, reject) => {
    settleOpen = outcome === 'saved' ? resolve : () => reject(new Error('synthetic open failure'));
  }));
  const saved = vi.fn(); previews.onDidSave(saved);
  const first = previews.saveAs(preview.sourceUri);
  const second = previews.saveAs(preview.sourceUri);
  await vi.waitFor(() => expect(settleOpen).toBeTypeOf('function'));
  expect(saved).not.toHaveBeenCalled();
  expect(await readFile(target.fsPath, 'utf8')).toBe('{}');
  settleOpen();
  expect(await first).toBe(outcome); expect(await second).toBe(outcome);
  expect(saved).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ fsPath: target.fsPath }), outcome);
  expect(host.info).not.toHaveBeenCalled();
});

it('does not offer saved-file actions when the exclusive copy fails', async () => {
  const preview = (await previews.create('{}', 1, signal()))!;
  const target = uri(join(directory, 'occupied.jsonl'));
  await writeFile(target.fsPath, 'existing');
  host.dialog.mockResolvedValue(target);
  const saved = vi.fn(); previews.onDidSave(saved);
  expect(await previews.saveAs(preview.sourceUri)).toBe('failed');
  expect(saved).not.toHaveBeenCalled();
  expect(await readFile(target.fsPath, 'utf8')).toBe('existing');
});

it('settles disposal after a saved copy even if opening the editor never settles', async () => {
  const preview = (await previews.create('{}', 1, signal()))!;
  const target = uri(join(directory, 'saved-open-pending.jsonl')); host.dialog.mockResolvedValue(target);
  host.open.mockImplementation(() => new Promise(() => {}));
  const saving = previews.saveAs(preview.sourceUri);
  await vi.waitFor(() => expect(host.open).toHaveBeenCalledTimes(1));
  await previews.dispose();
  expect(await saving).toBe('saved');
  expect(await readFile(target.fsPath, 'utf8')).toBe('{}');
});

it.each([false, true])('retains a partial or replaced target when its ownership is uncertain; replacement=%s', async (replaceTarget) => {
  const preview = (await previews.create('{"synthetic":true}', 1, signal()))!;
  const target = uri(join(directory, 'partial.jsonl')); host.dialog.mockResolvedValue(target);
  host.writeTarget = target.fsPath; host.failWrite = true; host.replaceTarget = replaceTarget;
  expect(await previews.saveAs(preview.sourceUri)).toBe('failed');
  if (replaceTarget) expect(await readFile(target.fsPath, 'utf8')).toBe('replacement');
  else expect(await readFile(target.fsPath, 'utf8')).toBe('{');
  expect(await readFile(preview.sourceUri.fsPath, 'utf8')).toBe('{"synthetic":true}');
  expect(previews.get(preview.sourceUri)?.status).toBe('temporary');
});

it('removes a failed target only while its empty creation identity is unchanged', async () => {
  const preview = (await previews.create('{}', 1, signal()))!;
  const target = uri(join(directory, 'empty-failure.jsonl')); host.dialog.mockResolvedValue(target);
  host.writeTarget = target.fsPath; host.beforeWrite = async () => { throw new Error('synthetic write unavailable'); };
  expect(await previews.saveAs(preview.sourceUri)).toBe('failed');
  await expect(readFile(target.fsPath)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(preview.sourceUri.fsPath, 'utf8')).toBe('{}');
});

it('preserves an external same-inode overwrite when destination verification fails', async () => {
  const preview = (await previews.create('{"synthetic":true}', 1, signal()))!;
  const target = uri(join(directory, 'external-write.jsonl')); host.dialog.mockResolvedValue(target);
  host.writeTarget = target.fsPath; host.overwriteBeforeRead = true;
  expect(await previews.saveAs(preview.sourceUri)).toBe('failed');
  expect(await readFile(target.fsPath, 'utf8')).toBe('external changed');
  expect(await readFile(preview.sourceUri.fsPath, 'utf8')).toBe('{"synthetic":true}');
});

it('drains a dispatched write on disposal and preserves its saved destination', async () => {
  const preview = (await previews.create('{}', 1, signal()))!;
  const target = uri(join(directory, 'drained.jsonl')); host.dialog.mockResolvedValue(target); host.writeTarget = target.fsPath;
  let finish!: () => void;
  host.beforeWrite = () => new Promise<void>((resolve) => { finish = resolve; });
  const saving = previews.saveAs(preview.sourceUri);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  const disposing = previews.dispose(); finish();
  expect(await saving).toBe('saved'); await disposing;
  expect(await readFile(target.fsPath, 'utf8')).toBe('{}'); expect(host.open).not.toHaveBeenCalled();
});

it('refuses changed sources and destinations inside its owned temporary directory', async () => {
  const preview = (await previews.create('{}', 1, signal()))!;
  host.dialog.mockResolvedValue(preview.sourceUri);
  expect(await previews.saveAs(preview.sourceUri)).toBe('failed');
  host.dialog.mockResolvedValue(uri(join(dirname(preview.sourceUri.fsPath), '..hidden.jsonl')));
  expect(await previews.saveAs(preview.sourceUri)).toBe('failed');
  await writeFile(preview.sourceUri.fsPath, 'changed source');
  const target = uri(join(directory, 'changed.jsonl')); host.dialog.mockResolvedValue(target);
  expect(await previews.saveAs(preview.sourceUri)).toBe('failed');
  await expect(readFile(target.fsPath)).rejects.toMatchObject({ code: 'ENOENT' });
  await rm(preview.sourceUri.fsPath);
});

it('caps this session without evicting previews or silently replacing an unsaved source', async () => {
  for (let index = 0; index < 20; index += 1) await previews.create('{}', 1, signal());
  const first = previews.list()[0]!;
  await expect(previews.create('{}', 1, signal())).rejects.toThrow('20 previews');
  expect(previews.list()).toHaveLength(20); expect(await readFile(first.sourceUri.fsPath, 'utf8')).toBe('{}');
});

it('coalesces saves that reenter from a metadata observer', async () => {
  const preview = (await previews.create('{}', 1, signal()))!;
  const observer = previews.onDidChange(() => { if (previews.get(preview.sourceUri)?.status === 'saving') void previews.saveAs(preview.sourceUri); });
  expect(await previews.saveAs(preview.sourceUri)).toBe('cancelled');
  expect(host.dialog).toHaveBeenCalledTimes(1); observer.dispose();
});
