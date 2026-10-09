import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { AuthorizedSourceSetting, SessionNavigatorScanResult } from '../../src/experimental/session-navigator/types';

const host = vi.hoisted(() => ({
  config: new Map<string, unknown>(), state: new Map<string, unknown>(),
  commands: new Map<string, (...args: any[]) => unknown>(),
  roots: [] as AuthorizedSourceSetting[], scan: vi.fn(), scanPage: vi.fn(), picker: vi.fn(), dialog: vi.fn(),
  configuration: undefined as undefined | ((event: { affectsConfiguration: (key: string) => boolean }) => void),
  visibility: undefined as undefined | ((event: { visible: boolean }) => void),
  view: { visible: false, message: undefined as string | undefined, dispose() {}, onDidChangeVisibility: vi.fn() },
  progress: vi.fn(), intake: vi.fn(), probe: vi.fn(), execute: vi.fn(), persist: vi.fn(),
}));
vi.mock('vscode', () => ({
  EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
  TreeItem: class { constructor(public label: string, public collapsibleState: number) {} },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1 },
  ThemeIcon: class { constructor(public id: string) {} },
  Uri: {
    joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: join(base.fsPath, ...parts) }),
    file: (path: string) => ({ fsPath: path, toString: () => pathToFileURL(path).toString() }),
    parse: (value: string) => ({ fsPath: fileURLToPath(value), toString: () => value }),
  },
  ConfigurationTarget: { Global: 1 },
  window: { createTreeView: () => host.view, registerWebviewViewProvider: () => ({ dispose() {} }), withProgress: host.progress, showQuickPick: host.picker, showOpenDialog: host.dialog, showWarningMessage: vi.fn(), showErrorMessage: vi.fn() },
  workspace: {
    fs: { createDirectory: async ({ fsPath }: { fsPath: string }) => { const { mkdir } = await import('node:fs/promises'); await mkdir(fsPath, { recursive: true }); } },
    getConfiguration: () => ({
      get: (key: string, fallback: unknown) => host.config.get(key) ?? fallback,
      update: async (key: string, value: unknown) => {
        host.config.set(key, value);
        host.configuration?.({ affectsConfiguration: (query) => query === 'jsonlView.sessionNavigator' || query === 'jsonlView.' + key });
      },
    }),
    onDidChangeConfiguration: (listener: typeof host.configuration) => { host.configuration = listener; return { dispose() {} }; },
  },
  commands: { executeCommand: host.execute, registerCommand: (id: string, handler: (...args: any[]) => unknown) => { host.commands.set(id, handler); return { dispose() {} }; } },
}));
vi.mock('../../src/experimental/session-navigator/source-config', async (original) => {
  const actual = await original<typeof import('../../src/experimental/session-navigator/source-config')>();
  return { ...actual, discoverDefaultSources: () => host.roots, mergeSourceSettings: (configured: AuthorizedSourceSetting[]) => actual.mergeSourceSettings(configured, host.roots) };
});
vi.mock('../../src/experimental/session-navigator/file-provider', () => ({ createSessionNavigatorProvider: () => ({ scan: host.scan, scanPage: host.scanPage, probe: host.probe }) }));
vi.mock('../../src/experimental/session-navigator/source-intake', () => ({ SourceIntakePanel: class { show() { host.intake(); } async dispose() {} } }));
import { SessionNavigatorTreeProvider } from '../../src/experimental/session-navigator/tree-provider';
import { RevealIntentRegistry } from '../../src/experimental/session-navigator/reveal-intents';

let root: string;
let tree: SessionNavigatorTreeProvider;
function createTree(): SessionNavigatorTreeProvider {
  return new SessionNavigatorTreeProvider({
    globalStorageUri: { fsPath: root },
    globalState: { get: (key: string, fallback: unknown) => host.state.get(key) ?? fallback, update: async (key: string, value: unknown) => { await host.persist(); host.state.set(key, value); } },
  } as unknown as vscode.ExtensionContext, new RevealIntentRegistry());
}
const snapshot: SessionNavigatorScanResult = {
  fingerprint: 'stable', snapshot: {
    schemaVersion: 1, provider: 'codex', sourceId: 'fixture', snapshotId: 'fixture', sourceGeneration: 'scan-1',
    capturedAt: '2026-10-08T00:00:00Z', redaction: 'metadata-only', truncated: false,
    entities: [{ sourceId: 'fixture', nativeId: 'thread-1', kind: 'session', label: 'A real session boundary', confidence: 'source' }], relations: [],
    locations: [{ nativeId: 'thread-1', relativePath: 'sessions/thread.jsonl', rowOrdinal: '0' }],
  },
};
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'jsonlview-navigator-lifecycle-'));
  host.config.clear(); host.state.clear(); host.commands.clear();
  host.config.set('sessionNavigator.enabled', true);
  host.roots = [{ provider: 'codex', rootUri: pathToFileURL(join(root, 'provider')).toString() }];
  host.scan.mockReset().mockResolvedValue(snapshot); host.scanPage.mockReset(); host.dialog.mockReset(); host.picker.mockReset(); host.intake.mockReset();
  host.probe.mockReset().mockResolvedValue('stable'); host.execute.mockReset().mockResolvedValue(undefined);
  host.persist.mockReset().mockResolvedValue(undefined);
  host.view.visible = false;
  host.view.message = undefined;
  host.progress.mockReset().mockImplementation(async (_options: unknown, callback: () => Promise<void>) => callback());
  host.view.onDidChangeVisibility.mockImplementation((listener: typeof host.visibility) => { host.visibility = listener; return { dispose() {} }; });
  tree = createTree();
  tree.register();
});
afterEach(async () => { tree.dispose(); await rm(root, { recursive: true, force: true }); });

describe('Session Navigator host lifecycle', () => {
  async function loadedEntity() {
    await tree.refresh();
    const [source] = await tree.getChildren();
    const [entity] = await tree.getChildren(source!);
    if (entity?.nodeKind !== 'entity') throw new Error('Expected a loaded session');
    return entity;
  }

  it.each(['codex', 'claude'] as const)('opens a current %s transcript despite unrelated provider activity', async (provider) => {
    host.roots = [{ ...host.roots[0]!, provider }];
    await mkdir(join(root, 'provider', 'sessions'), { recursive: true });
    await writeFile(join(root, 'provider', 'sessions', 'thread.jsonl'), '{}\n');
    const entity = await loadedEntity();
    host.probe.mockResolvedValue('new-provider-activity');
    await tree.reveal(entity);
    expect(host.execute).toHaveBeenCalledWith('vscode.openWith', expect.objectContaining({ fsPath: join(root, 'provider', 'sessions', 'thread.jsonl') }), 'jsonlView.editor');
    const [source] = await tree.getChildren();
    expect(tree.getTreeItem(source!).description).toContain('updates available');
  });

  it('retains fingerprint protection for generic record anchors', async () => {
    host.roots = [{ ...host.roots[0]!, provider: 'generic' }];
    await mkdir(join(root, 'provider', 'sessions'), { recursive: true });
    await writeFile(join(root, 'provider', 'sessions', 'thread.jsonl'), '{}\n{}\n');
    host.scan.mockResolvedValueOnce({ ...snapshot, snapshot: { ...snapshot.snapshot, locations: [{ nativeId: 'thread-1', relativePath: 'sessions/thread.jsonl', rowOrdinal: '1' }] } });
    const entity = await loadedEntity();
    host.probe.mockResolvedValue('changed');
    await tree.reveal(entity);
    expect(host.execute).not.toHaveBeenCalled();
  });

  it.each(['C:\\old-home\\session.jsonl', '/old-home/session.jsonl', '..\\outside\\session.jsonl', '../outside/session.jsonl', 'C:session.jsonl', '\\\\server\\share\\session.jsonl'])('rejects malformed cached location %s before probing or joining', async (relativePath) => {
    host.scan.mockResolvedValueOnce({ ...snapshot, snapshot: { ...snapshot.snapshot, locations: [{ nativeId: 'thread-1', relativePath, rowOrdinal: '0' }] } });
    const entity = await loadedEntity();
    await tree.reveal(entity);
    expect(host.probe).not.toHaveBeenCalled();
    expect(host.execute).not.toHaveBeenCalled();
  });

  it('still opens a stable generic nested record after location validation', async () => {
    host.roots = [{ ...host.roots[0]!, provider: 'generic' }];
    await mkdir(join(root, 'provider', 'sessions'), { recursive: true });
    await writeFile(join(root, 'provider', 'sessions', 'thread.jsonl'), '{}\n{}\n');
    host.scan.mockResolvedValueOnce({ ...snapshot, snapshot: { ...snapshot.snapshot, locations: [{ nativeId: 'thread-1', relativePath: 'sessions/thread.jsonl', rowOrdinal: '1' }] } });
    const entity = await loadedEntity();
    await tree.reveal(entity);
    expect(host.execute).toHaveBeenCalledWith('vscode.openWith', expect.objectContaining({ fsPath: join(root, 'provider', 'sessions', 'thread.jsonl') }), 'jsonlView.editor');
  });

  it('rejects a transcript reached through a junction outside its authorized root', async () => {
    await mkdir(join(root, 'outside'));
    await writeFile(join(root, 'outside', 'thread.jsonl'), '{}\n');
    await mkdir(join(root, 'provider'));
    await symlink(join(root, 'outside'), join(root, 'provider', 'sessions'), process.platform === 'win32' ? 'junction' : 'dir');
    const entity = await loadedEntity();
    await tree.reveal(entity);
    expect(host.execute).not.toHaveBeenCalled();
  });

  it('discards reveal when disposed during the provider probe', async () => {
    const entity = await loadedEntity();
    let complete!: (value: string) => void;
    host.probe.mockImplementation(() => new Promise<string>((resolve) => { complete = resolve; }));
    const reveal = tree.reveal(entity);
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
    tree.dispose(); complete('changed'); await reveal;
    expect(host.execute).not.toHaveBeenCalled();
  });

  it('stops late authorization persistence after disposal', async () => {
    host.picker.mockResolvedValue({ value: 'codex' });
    let complete!: () => void;
    host.persist.mockImplementation(() => new Promise<void>((resolve) => { complete = resolve; }));
    const authorize = host.commands.get('jsonlView.sessionNavigator.authorizeAgent')!();
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
    tree.dispose(); complete(); await authorize;
    expect(host.config.has('sessionNavigator.sources')).toBe(false);
    expect(host.scan).not.toHaveBeenCalled();
  });

  it('shows waiting and loading before completion, then a trustworthy count', async () => {
    const [source] = await tree.getChildren();
    expect(tree.getTreeItem(source!).description).toBe('Waiting to load…');
    let complete!: (value: SessionNavigatorScanResult) => void;
    host.scan.mockImplementationOnce(() => new Promise<SessionNavigatorScanResult>((resolve) => { complete = resolve; }));
    const refresh = tree.refresh();
    expect(host.view.message).toBe('Loading sessions…');
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
    expect(tree.getTreeItem(source!).description).toBe('Loading…');
    complete(snapshot);
    await refresh;
    const [loaded] = await tree.getChildren();
    expect(tree.getTreeItem(loaded!).description).toBe('1 session');
    expect(host.view.message).not.toBe('Loading sessions…');
  });

  it('shows a first-load error instead of zero and retries on reopening the view', async () => {
    host.scan.mockRejectedValueOnce(new Error('temporary failure'));
    host.view.visible = true; host.visibility!({ visible: true });
    await tree.refresh();
    const [source] = await tree.getChildren();
    expect(tree.getTreeItem(source!).description).toBe('Could not load · Retry');
    expect(host.scan).toHaveBeenCalledTimes(1);
    host.view.visible = false; host.visibility!({ visible: false });
    host.view.visible = true; host.visibility!({ visible: true });
    await tree.refresh();
    const [loaded] = await tree.getChildren();
    expect(tree.getTreeItem(loaded!).description).toBe('1 session');
    expect(host.scan).toHaveBeenCalledTimes(2);
  });

  it('reopens from the durable catalog and skips a full scan when the source fingerprint is unchanged', async () => {
    await tree.refresh();
    expect(host.scan).toHaveBeenCalledTimes(1);
    tree.dispose();
    host.scan.mockClear();
    host.probe.mockClear().mockResolvedValue('stable');

    tree = createTree();
    tree.register();
    const [cachedSource] = await tree.getChildren();
    expect(tree.getTreeItem(cachedSource!).description).toBe('1 session');
    await tree.refresh();

    expect(host.probe).toHaveBeenCalledTimes(1);
    expect(host.scan).not.toHaveBeenCalled();
    const [source] = await tree.getChildren();
    expect(await tree.getChildren(source)).toHaveLength(1);
    expect(tree.getTreeItem(source!).description).toBe('1 session');
  });

  it('keeps cached rows visible while a changed source is being replaced', async () => {
    await tree.refresh();
    tree.dispose();
    host.scan.mockClear();
    host.probe.mockClear().mockResolvedValue('changed');
    const replacement = { ...snapshot, fingerprint: 'changed', snapshot: { ...snapshot.snapshot, entities: [{ ...snapshot.snapshot.entities[0]!, label: 'Rebuilt session' }] } };
    let complete!: (value: SessionNavigatorScanResult) => void;
    host.scan.mockImplementationOnce(() => new Promise<SessionNavigatorScanResult>((resolve) => { complete = resolve; }));

    tree = createTree();
    tree.register();
    const refresh = tree.refresh();
    await vi.waitFor(() => expect(host.scan).toHaveBeenCalledTimes(1));
    const [sourceWhileRefreshing] = await tree.getChildren();
    expect(tree.getTreeItem(sourceWhileRefreshing!).description).toContain('Refreshing');
    expect((await tree.getChildren(sourceWhileRefreshing!))[0]).toMatchObject({ nodeKind: 'entity', entity: { label: 'A real session boundary' } });

    complete(replacement);
    await refresh;
    const [source] = await tree.getChildren();
    expect((await tree.getChildren(source))[0]).toMatchObject({ nodeKind: 'entity', entity: { label: 'Rebuilt session' } });
    expect(tree.getTreeItem(source!).description).toBe('1 session');
  });

  it('retries a transient empty Claude page before committing a zero-session partial index', async () => {
    host.roots = [{ ...host.roots[0]!, provider: 'claude' }];
    host.view.visible = true;
    host.visibility!({ visible: true });
    host.scan
      .mockResolvedValueOnce({
        ...snapshot,
        snapshot: { ...snapshot.snapshot, provider: 'claude', entities: [], locations: [], truncated: true, truncatedReason: 'record_limit' },
      })
      .mockResolvedValueOnce({
        ...snapshot,
        snapshot: { ...snapshot.snapshot, provider: 'claude' },
      });

    await tree.refresh();

    expect(host.scan).toHaveBeenCalledTimes(2);
    const [source] = await tree.getChildren();
    expect(tree.getTreeItem(source!).description).toBe('1 session');
  });

  it('eagerly reconciles a Claude child whose parent arrives on the first continuation page', async () => {
    host.roots = [{ ...host.roots[0]!, provider: 'claude' }];
    host.view.visible = true;
    host.visibility!({ visible: true });
    const child = { sourceId: 'fixture', nativeId: 'child', kind: 'subagent' as const, label: 'Child worker', relationship: 'orphan' as const, confidence: 'source' as const };
    const parent = { sourceId: 'fixture', nativeId: 'parent', kind: 'session' as const, label: 'Parent session', relationship: 'root' as const, confidence: 'source' as const };
    host.scan.mockResolvedValueOnce({
      fingerprint: 'page-1',
      nextCursor: 'page-2',
      snapshot: { ...snapshot.snapshot, provider: 'claude', truncated: true, entities: [child], relations: [{ sourceId: 'fixture', fromNativeId: 'child', toNativeId: 'parent', kind: 'parent' }], locations: [{ nativeId: 'child', relativePath: 'child.jsonl', rowOrdinal: '0' }] },
    });
    host.scanPage.mockResolvedValueOnce({
      fingerprint: 'page-2',
      snapshot: { ...snapshot.snapshot, provider: 'claude', truncated: false, entities: [parent], relations: [], locations: [{ nativeId: 'parent', relativePath: 'parent.jsonl', rowOrdinal: '0' }] },
    });

    await tree.refresh();

    expect(host.scanPage).toHaveBeenCalledWith(expect.any(AbortSignal), expect.any(Object), 'page-2');
    const [source] = await tree.getChildren();
    const roots = await tree.getChildren(source);
    expect(roots.map((node) => node.nodeKind === 'entity' ? node.entity.nativeId : '')).toEqual(['parent']);
    expect((await tree.getChildren(roots[0]!)).map((node) => node.nodeKind === 'entity' ? node.entity.nativeId : '')).toEqual(['child']);
  });

  it('keeps source-level progress and marks partial counts', async () => {
    host.scan.mockResolvedValueOnce({ ...snapshot, snapshot: { ...snapshot.snapshot, truncated: true, truncatedReason: 'entity_limit' } });
    await tree.refresh();
    const [source] = await tree.getChildren();
    expect(tree.getTreeItem(source!).description).toBe('1 session · partial index');
    expect(host.progress).toHaveBeenCalledWith({ location: { viewId: 'jsonlView.sessionNavigator' } }, expect.any(Function));
  });

  it('keeps a removed default home excluded when it had an explicit SQLite override', async () => {
    host.config.set('sessionNavigator.sources', [{ ...host.roots[0], stateRootUri: pathToFileURL(join(root, 'external-state')).toString() }]);
    await tree.refresh();
    const [source] = await tree.getChildren();
    await host.commands.get('jsonlView.sessionNavigator.removeSource')!(source);
    await tree.refresh();
    expect(await tree.getChildren()).toEqual([]);
  });

  it('authorizes a detected provider without a folder picker and keeps removal across refresh', async () => {
    host.picker.mockResolvedValue({ value: 'codex' });
    await host.commands.get('jsonlView.sessionNavigator.authorizeAgent')!();
    expect(host.dialog).not.toHaveBeenCalled();
    const sources = await tree.getChildren();
    expect(sources).toHaveLength(1);
    expect(await tree.getChildren(sources[0])).toHaveLength(1);
    await host.commands.get('jsonlView.sessionNavigator.removeSource')!(sources[0]);
    await tree.refresh();
    expect(await tree.getChildren()).toEqual([]);
    expect(host.config.get('sessionNavigator.sources')).toEqual([]);
    await host.commands.get('jsonlView.sessionNavigator.authorizeAgent')!();
    expect(await tree.getChildren()).toHaveLength(1);
  });

  it('opens the intake form without a provider picker or automatic clipboard read', async () => {
    await host.commands.get('jsonlView.sessionNavigator.addSource')!();
    expect(host.intake).toHaveBeenCalledTimes(1);
    expect(host.picker).not.toHaveBeenCalled();
    expect(host.dialog).not.toHaveBeenCalled();
  });

  it('drops obsolete source errors when the configured source is removed', async () => {
    host.scan.mockRejectedValueOnce(new Error('no access'));
    await tree.refresh();
    expect(host.view.message).toContain('could not load');
    host.roots = [];
    await tree.refresh();
    expect(await tree.getChildren()).toEqual([]);
    expect(host.view.message).toBe('');
  });

  it('coalesces refreshes and discards a late scan after disabling without deleting the catalog', async () => {
    await tree.refresh();
    let complete!: (value: SessionNavigatorScanResult) => void;
    host.probe.mockResolvedValueOnce('changed');
    host.scan.mockImplementationOnce(() => new Promise<SessionNavigatorScanResult>((resolve) => { complete = resolve; }));
    const first = tree.refresh();
    const second = tree.refresh();
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
    expect(host.scan).toHaveBeenCalledTimes(2);
    await host.commands.get('jsonlView.sessionNavigator.disable')!();
    complete({ ...snapshot, snapshot: { ...snapshot.snapshot, entities: [], locations: [] } });
    await Promise.all([first, second]);
    expect(await tree.getChildren()).toEqual([]);
    host.config.set('sessionNavigator.enabled', true);
    const [source] = await tree.getChildren();
    expect(await tree.getChildren(source)).toHaveLength(1);
  });

  it('retries an aborted initial refresh when the view is shown before it settles', async () => {
    let complete!: (value: SessionNavigatorScanResult) => void;
    host.scan.mockImplementationOnce(() => new Promise<SessionNavigatorScanResult>((resolve) => { complete = resolve; }));
    host.view.visible = true; host.visibility!({ visible: true });
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
    host.view.visible = false; host.visibility!({ visible: false });
    host.view.visible = true; host.visibility!({ visible: true });
    complete(snapshot);
    await tree.refresh();
    expect(host.scan).toHaveBeenCalledTimes(2);
    const [source] = await tree.getChildren();
    expect(await tree.getChildren(source)).toHaveLength(1);
    host.view.visible = false; host.visibility!({ visible: false });
    host.view.visible = true; host.visibility!({ visible: true });
    await Promise.resolve();
    expect(host.scan).toHaveBeenCalledTimes(2);
  });
});
