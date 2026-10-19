import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { AuthorizedSourceSetting, SessionNavigatorScanResult } from '../../src/experimental/session-navigator/types';
import type { SessionNavigatorTreeNode } from '../../src/experimental/session-navigator/tree-provider';

const host = vi.hoisted(() => ({
  config: new Map<string, unknown>(), state: new Map<string, unknown>(),
  commands: new Map<string, (...args: any[]) => unknown>(),
  roots: [] as AuthorizedSourceSetting[], scan: vi.fn(), scanPage: vi.fn(), picker: vi.fn(), dialog: vi.fn(),
  configuration: undefined as undefined | ((event: { affectsConfiguration: (key: string) => boolean }) => void),
  visibility: undefined as undefined | ((event: { visible: boolean }) => void),
  sourceDropVisibilityListeners: new Set<(visible: boolean) => void>(),
  view: { visible: false, message: undefined as string | undefined, dispose() {}, onDidChangeVisibility: vi.fn() },
  progress: vi.fn(), intake: vi.fn(), probe: vi.fn(), execute: vi.fn(), persist: vi.fn(), info: vi.fn(), warning: vi.fn(), updates: vi.fn(), overridden: false,
}));
vi.mock('vscode', () => ({
  EventEmitter: class {
    readonly listeners = new Set<(value: unknown) => void>();
    event = (listener: (value: unknown) => void) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
    fire(value: unknown) { for (const listener of this.listeners) listener(value); }
    dispose() { this.listeners.clear(); }
  },
  TreeItem: class { constructor(public label: string, public collapsibleState: number) {} },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1 },
  ThemeIcon: class { constructor(public id: string) {} },
  Uri: {
    joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: join(base.fsPath, ...parts) }),
    file: (path: string) => ({ fsPath: path, toString: () => pathToFileURL(path).toString() }),
    parse: (value: string) => ({ scheme: new URL(value).protocol.replace(':', ''), fsPath: fileURLToPath(value), toString: () => value }),
  },
  ConfigurationTarget: { Global: 1 },
  window: { createTreeView: () => host.view, registerWebviewViewProvider: () => ({ dispose() {} }), withProgress: host.progress, showQuickPick: host.picker, showOpenDialog: host.dialog, showSaveDialog: host.dialog, showInformationMessage: host.info, showWarningMessage: host.warning, showErrorMessage: vi.fn() },
  workspace: {
    fs: { createDirectory: async ({ fsPath }: { fsPath: string }) => { const { mkdir } = await import('node:fs/promises'); await mkdir(fsPath, { recursive: true }); } },
    getConfiguration: () => ({
      get: (key: string, fallback: unknown) => host.config.get(key) ?? fallback,
      update: async (key: string, value: unknown) => {
        host.updates(key, value);
        if (!host.overridden) host.config.set(key, value);
        host.configuration?.({ affectsConfiguration: (query) => query === 'jsonlView.sessionNavigator' || query === 'jsonlView.' + key });
      },
    }),
    asRelativePath: ({ fsPath }: { fsPath: string }) => fsPath.replaceAll('\\', '/'),
    onDidChangeConfiguration: (listener: typeof host.configuration) => { host.configuration = listener; return { dispose() {} }; },
  },
  commands: { executeCommand: host.execute, registerCommand: (id: string, handler: (...args: any[]) => unknown) => { host.commands.set(id, handler); return { dispose() {} }; } },
  env: { clipboard: { writeText: vi.fn() } },
}));
vi.mock('../../src/experimental/session-navigator/source-config', async (original) => {
  const actual = await original<typeof import('../../src/experimental/session-navigator/source-config')>();
  return { ...actual, discoverDefaultSources: () => host.roots, mergeSourceSettings: (configured: AuthorizedSourceSetting[], discovered: AuthorizedSourceSetting[] = host.roots) => actual.mergeSourceSettings(configured, discovered) };
});
vi.mock('../../src/experimental/session-navigator/provider-factory', () => ({ createSessionNavigatorProvider: (setting: AuthorizedSourceSetting) => ({
  provider: setting.provider, sourceId: setting.provider, rootUri: setting.rootUri,
  scan: (signal: AbortSignal, budget: unknown) => host.scan(signal, budget, setting.provider),
  scanPage: (signal: AbortSignal, budget: unknown, cursor?: string) => host.scanPage(signal, budget, cursor, setting.provider),
  probe: (signal: AbortSignal) => host.probe(signal, setting.provider),
}) }));
vi.mock('../../src/experimental/session-navigator/source-intake', () => ({ SourceIntakePanel: class {
  onDidChangeVisibility = (listener: (visible: boolean) => void) => { host.sourceDropVisibilityListeners.add(listener); return { dispose: () => host.sourceDropVisibilityListeners.delete(listener) }; };
  show() { host.intake(); }
  async dispose() {}
} }));
import { SessionNavigatorTreeProvider } from '../../src/experimental/session-navigator/tree-provider';
import { RevealIntentRegistry } from '../../src/experimental/session-navigator/reveal-intents';
import { CatalogStore, type CatalogChildrenPage } from '../../src/experimental/session-navigator/catalog-store';

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
  host.sourceDropVisibilityListeners.clear();
  host.config.set('sessionNavigator.enabled', true);
  host.roots = [{ provider: 'codex', rootUri: pathToFileURL(join(root, 'provider')).toString() }];
  host.config.set('sessionNavigator.sources', host.roots);
  host.scan.mockReset().mockResolvedValue(snapshot); host.scanPage.mockReset(); host.dialog.mockReset(); host.picker.mockReset(); host.intake.mockReset();
  host.probe.mockReset().mockResolvedValue('stable'); host.execute.mockReset().mockResolvedValue(undefined);
  host.persist.mockReset().mockResolvedValue(undefined);
  host.info.mockReset().mockResolvedValue(undefined); host.warning.mockReset().mockResolvedValue(undefined); host.updates.mockReset(); host.overridden = false;
  host.view.visible = false;
  host.view.message = undefined;
  host.progress.mockReset().mockImplementation(async (_options: unknown, callback: () => Promise<void>) => callback());
  host.view.onDidChangeVisibility.mockImplementation((listener: typeof host.visibility) => { host.visibility = listener; return { dispose() {} }; });
  tree = createTree();
  tree.register();
});
afterEach(async () => { vi.restoreAllMocks(); tree.dispose(); await rm(root, { recursive: true, force: true }); });

describe('Session Navigator host lifecycle', () => {
  it('aggregates visible child views without coupling Add Source visibility to Sessions scanning', async () => {
    const values: boolean[] = [];
    const registration = tree.onDidChangeVisibility((visible) => values.push(visible));
    for (const listener of host.sourceDropVisibilityListeners) listener(true);

    expect(values).toEqual([true]);
    expect(host.scan).not.toHaveBeenCalled();

    host.visibility?.({ visible: true });
    for (const listener of host.sourceDropVisibilityListeners) listener(false);
    expect(values).toEqual([true]);
    await vi.waitFor(() => expect(host.scan).toHaveBeenCalled());

    host.visibility?.({ visible: false });
    expect(values).toEqual([true, false]);
    registration.dispose();
  });

  it('publishes only actual TreeView visibility transitions', () => {
    host.config.set('sessionNavigator.enabled', false);
    const values: boolean[] = [];
    const registration = tree.onDidChangeVisibility((visible) => values.push(visible));

    host.visibility?.({ visible: true });
    host.visibility?.({ visible: true });
    host.visibility?.({ visible: false });

    expect(values).toEqual([true, false]);
    registration.dispose();
  });

  it.each(['Cancel', undefined, 'Settings'])('does no scan, persistence, or catalog IO when disabled and choosing %s', async (choice) => {
    host.config.set('sessionNavigator.enabled', false); host.info.mockResolvedValue(choice);
    const opening = vi.spyOn(CatalogStore, 'open');
    await tree.open();
    expect(host.updates).not.toHaveBeenCalled(); expect(host.scan).not.toHaveBeenCalled();
    expect(host.probe).not.toHaveBeenCalled(); expect(opening).not.toHaveBeenCalled();
    expect(await tree.getChildren()).toEqual([]);
    if (choice === 'Settings') expect(host.execute).toHaveBeenCalledWith('workbench.action.openSettings', 'jsonlView.sessionNavigator.enabled');
    else expect(host.execute).not.toHaveBeenCalled();
  });

  it('keeps metadata-only previews in the Sessions tree without opening the catalog when disabled', async () => {
    host.config.set('sessionNavigator.enabled', false);
    const opening = vi.spyOn(CatalogStore, 'open');
    const preview = await tree.previews.create('{"synthetic":true}\n', 1, new AbortController().signal);
    expect(preview).toBeDefined();
    const roots = await tree.getChildren();
    const group = roots.find((node) => node.nodeKind === 'preview-group');
    expect(group).toBeDefined();
    expect(roots.filter((node) => node.nodeKind === 'preview-group')).toHaveLength(1);
    const children = await tree.getChildren(group);
    expect(children).toHaveLength(1);
    const child = children[0]!;
    const item = tree.getTreeItem(child);
    expect(item.contextValue).toBe('jsonlView.preview.temporary');
    expect(item.description).toContain('1 records');
    expect(item.command).toMatchObject({ command: 'jsonlView.previews.open' });
    host.execute.mockClear();
    await host.commands.get('jsonlView.previews.open')!(child);
    expect(host.execute).toHaveBeenCalledWith('vscode.openWith', preview!.sourceUri, 'jsonlView.editor');
    host.dialog.mockResolvedValue(undefined);
    expect(await host.commands.get('jsonlView.previews.saveAs')!(child)).toBe('cancelled');
    expect(host.scan).not.toHaveBeenCalled();
    expect(host.probe).not.toHaveBeenCalled();
    expect(opening).not.toHaveBeenCalled();
  });

  it('remembers explicit Enable and opens later without repeating the authorization prompt', async () => {
    host.config.set('sessionNavigator.enabled', false); host.info.mockResolvedValue('Enable');
    await tree.open();
    expect(host.info).toHaveBeenCalledWith(
      'Enable the built-in Session Navigator? This choice is remembered.',
      { modal: true },
      'Enable',
      'Settings',
    );
    await tree.open();
    expect(host.updates).toHaveBeenCalledExactlyOnceWith('sessionNavigator.enabled', true);
    expect(host.info).toHaveBeenCalledTimes(1);
    expect(host.execute).toHaveBeenCalledTimes(2);
    expect(host.intake).not.toHaveBeenCalled();
  });

  it('does not turn detected homes into authorized sources when enabling a visible Navigator', async () => {
    host.config.set('sessionNavigator.enabled', false); host.config.set('sessionNavigator.sources', []);
    host.info.mockResolvedValue('Enable'); host.view.visible = true;
    await tree.open(); await tree.refresh();
    expect(await tree.getChildren()).toEqual([]);
    expect(host.config.get('sessionNavigator.sources')).toEqual([]);
    expect(host.scan).not.toHaveBeenCalled(); expect(host.probe).not.toHaveBeenCalled();
  });

  it('opens the empty Navigator after enablement without a second source-authorization modal', async () => {
    host.config.set('sessionNavigator.sources', []);
    const result = await tree.open();
    expect(result).toMatchObject({
      status: 'opened',
      enabled: 'enabled',
      authorization: 'not-requested',
      authorizationReadback: 'not-requested',
      action: 'focus-sessions',
    });
    expect(host.info).not.toHaveBeenCalled();
    expect(host.execute).toHaveBeenCalledExactlyOnceWith('workbench.view.extension.jsonlViewSessionNavigator');
    expect(host.scan).not.toHaveBeenCalled();
  });

  it('returns opened only after persisted authorization is visible on readback', async () => {
    const result = await tree.open();
    expect(result).toMatchObject({
      status: 'opened',
      enabled: 'enabled',
      authorization: 'granted',
      authorizationReadback: 'confirmed',
      action: 'focus-sessions',
    });
    expect(host.execute).toHaveBeenCalledExactlyOnceWith('workbench.view.extension.jsonlViewSessionNavigator');
  });

  it('rejects an authorization whose effective settings readback omits the source', async () => {
    host.config.set('sessionNavigator.sources', []);
    host.overridden = true;
    host.picker.mockResolvedValue({ value: 'codex' });
    await host.commands.get('jsonlView.sessionNavigator.authorizeAgent')!();
    expect(host.config.get('sessionNavigator.sources')).toEqual([]);
    expect(host.scan).not.toHaveBeenCalled();
  });

  it('records only the explicitly selected source without enabling a disabled Navigator', async () => {
    host.config.set('sessionNavigator.enabled', false); host.config.set('sessionNavigator.sources', []);
    host.roots = [...host.roots, { provider: 'claude', rootUri: pathToFileURL(join(root, 'other-home')).toString() }];
    host.picker.mockResolvedValue({ value: 'codex' });
    await host.commands.get('jsonlView.sessionNavigator.authorizeAgent')!();
    expect(host.config.get('sessionNavigator.sources')).toEqual([host.roots[0]]);
    expect(host.config.get('sessionNavigator.enabled')).toBe(false);
    expect(host.scan).not.toHaveBeenCalled(); expect(host.probe).not.toHaveBeenCalled();
  });

  it('reads effective enablement after a workspace override and settles late dialog disposal', async () => {
    host.config.set('sessionNavigator.enabled', false); host.overridden = true; host.info.mockResolvedValueOnce('Enable');
    await tree.open(); expect(host.execute).not.toHaveBeenCalled(); expect(host.scan).not.toHaveBeenCalled();
    let choose!: (choice: string) => void;
    host.info.mockImplementationOnce(() => new Promise<string>((resolve) => { choose = resolve; }));
    const opening = tree.open(); tree.dispose(); choose('Enable'); await opening;
    expect(host.updates).toHaveBeenCalledTimes(1);
  });

  async function loadedEntity() {
    await tree.refresh();
    const [source] = await tree.getChildren();
    const [entity] = await tree.getChildren(source!);
    if (entity?.nodeKind !== 'entity') throw new Error('Expected a loaded session');
    return entity;
  }

  it('routes source context actions to the authorized source root without session semantics', async () => {
    await tree.refresh();
    const [source] = await tree.getChildren();
    if (source?.nodeKind !== 'source') throw new Error('Expected a source node');
    await host.commands.get('jsonlView.sessionNavigator.revealInFileExplorer')!(source);
    await host.commands.get('jsonlView.sessionNavigator.openInIntegratedTerminal')!(source);
    await host.commands.get('jsonlView.sessionNavigator.copyPath')!(source);
    await host.commands.get('jsonlView.sessionNavigator.copyRelativePath')!(source);
    expect(host.execute).toHaveBeenNthCalledWith(1, 'revealFileInOS', expect.objectContaining({ fsPath: join(root, 'provider') }));
    expect(host.execute).toHaveBeenNthCalledWith(2, 'openInIntegratedTerminal', expect.objectContaining({ fsPath: join(root, 'provider') }));
    expect(host.commands.has('jsonlView.sessionNavigator.copySessionId')).toBe(true);
  });

  it.each(['codex', 'claude', 'pi', 'kimi'] as const)('opens a current %s transcript despite unrelated provider activity', async (provider) => {
    host.roots = [{ ...host.roots[0]!, provider }];
    host.config.set('sessionNavigator.sources', host.roots);
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
    host.config.set('sessionNavigator.sources', host.roots);
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
    host.config.set('sessionNavigator.sources', host.roots);
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
    host.config.delete('sessionNavigator.sources');
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

  it('refreshes the catalog when a visible background probe detects source changes', async () => {
    await tree.refresh();
    host.scan.mockClear();
    host.probe.mockReset().mockResolvedValue('changed');
    host.scan.mockResolvedValueOnce({
      ...snapshot, fingerprint: 'changed',
      snapshot: { ...snapshot.snapshot, entities: [{ ...snapshot.snapshot.entities[0]!, label: 'Updated session' }] },
    });
    host.view.visible = true;

    await (tree as unknown as { probeVisibleSources: () => Promise<void> }).probeVisibleSources();

    expect(host.scan).toHaveBeenCalledTimes(1);
    const [source] = await tree.getChildren();
    const [entity] = await tree.getChildren(source!);
    expect(entity).toMatchObject({ nodeKind: 'entity', entity: { label: 'Updated session' } });
    expect(tree.getTreeItem(source!).description).not.toContain('updates available');
  });

  it('queues a second refresh when a source changes after its turn in the active refresh', async () => {
    host.roots = [
      { provider: 'kimi', rootUri: pathToFileURL(join(root, 'kimi')).toString() },
      { provider: 'codex', rootUri: pathToFileURL(join(root, 'codex')).toString() },
    ];
    await mkdir(join(root, 'kimi', 'sessions'), { recursive: true });
    await mkdir(join(root, 'codex', 'sessions'), { recursive: true });
    host.config.set('sessionNavigator.sources', host.roots);
    await tree.refresh();
    expect(await tree.getChildren()).toHaveLength(2);

    host.scan.mockReset();
    let completeCodex!: (value: SessionNavigatorScanResult) => void;
    host.scan.mockImplementationOnce(() => new Promise<SessionNavigatorScanResult>((resolve) => { completeCodex = resolve; }));
    host.scan.mockResolvedValueOnce({
      ...snapshot, fingerprint: 'changed-kimi',
      snapshot: { ...snapshot.snapshot, entities: [{ ...snapshot.snapshot.entities[0]!, label: 'Updated Kimi session' }] },
    });
    host.probe.mockReset()
      .mockResolvedValueOnce('stable')
      .mockResolvedValueOnce('changed-codex')
      .mockResolvedValueOnce('changed-kimi')
      .mockResolvedValueOnce('changed-codex')
      .mockResolvedValueOnce('changed-kimi')
      .mockResolvedValue('changed-codex');
    const refreshing = tree.refresh();
    await vi.waitFor(() => expect(completeCodex).toBeTypeOf('function'));

    host.view.visible = true;
    const probing = (tree as unknown as { probeVisibleSources: () => Promise<void> }).probeVisibleSources();
    await vi.waitFor(() => expect(host.probe).toHaveBeenCalledTimes(4));
    completeCodex({
      ...snapshot, fingerprint: 'changed-codex',
      snapshot: { ...snapshot.snapshot, entities: [{ ...snapshot.snapshot.entities[0]!, label: 'Updated Codex session' }] },
    });
    await Promise.all([refreshing, probing]);

    expect(host.scan.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(host.probe.mock.calls.length).toBeGreaterThanOrEqual(4);
    const sources = await tree.getChildren();
    const kimi = sources.find((node) => node.nodeKind === 'source' && node.source.provider === 'kimi');
    if (kimi?.nodeKind !== 'source') throw new Error('Expected the Kimi source');
    expect(await tree.getChildren(kimi)).toMatchObject([{ nodeKind: 'entity', entity: { label: 'Updated Kimi session' } }]);
  });

  it('re-probes when a concurrent scan commits beyond an observed fingerprint baseline', async () => {
    host.roots = [
      { provider: 'kimi', rootUri: pathToFileURL(join(root, 'kimi')).toString() },
      { provider: 'codex', rootUri: pathToFileURL(join(root, 'codex')).toString() },
    ];
    await mkdir(join(root, 'kimi', 'sessions'), { recursive: true });
    await mkdir(join(root, 'codex', 'sessions'), { recursive: true });
    host.config.set('sessionNavigator.sources', host.roots);
    await tree.refresh();

    let completeKimi!: (value: SessionNavigatorScanResult) => void;
    host.scan.mockReset()
      .mockImplementationOnce(() => new Promise<SessionNavigatorScanResult>((resolve) => { completeKimi = resolve; }))
      .mockResolvedValueOnce({
        ...snapshot, fingerprint: 'kimi-fingerprint-3',
        snapshot: { ...snapshot.snapshot, entities: [{ ...snapshot.snapshot.entities[0]!, label: 'Kimi version 3' }] },
      });
    const fingerprints = new Map<string, string[]>([
      ['kimi', ['kimi-fingerprint-2', 'kimi-fingerprint-2', 'kimi-fingerprint-3']],
      ['codex', ['stable', 'stable', 'stable']],
    ]);
    host.probe.mockReset().mockImplementation((_signal: AbortSignal, provider: string) => fingerprints.get(provider)?.shift() ?? 'stable');

    const refreshing = tree.refresh();
    await vi.waitFor(() => expect(completeKimi).toBeTypeOf('function'));
    host.view.visible = true;
    const probing = (tree as unknown as { probeVisibleSources: () => Promise<void> }).probeVisibleSources();
    await vi.waitFor(() => expect(host.probe).toHaveBeenCalledTimes(4));
    completeKimi({
      ...snapshot, fingerprint: 'kimi-fingerprint-2',
      snapshot: { ...snapshot.snapshot, entities: [{ ...snapshot.snapshot.entities[0]!, label: 'Kimi version 2' }] },
    });
    await Promise.all([refreshing, probing]);

    expect(host.scan).toHaveBeenCalledTimes(2);
    expect(host.probe).toHaveBeenCalledTimes(6);
    const sources = await tree.getChildren();
    const kimi = sources.find((node) => node.nodeKind === 'source' && node.source.provider === 'kimi');
    if (kimi?.nodeKind !== 'source') throw new Error('Expected the Kimi source');
    expect(await tree.getChildren(kimi)).toMatchObject([{ nodeKind: 'entity', entity: { label: 'Kimi version 3' } }]);
  });

  it('starts Kimi within the bounded refresh window even when it is listed last', async () => {
    host.roots = [
      { provider: 'codex', rootUri: pathToFileURL(join(root, 'codex')).toString() },
      { provider: 'claude', rootUri: pathToFileURL(join(root, 'claude')).toString() },
      { provider: 'pi', rootUri: pathToFileURL(join(root, 'pi')).toString() },
      { provider: 'kimi', rootUri: pathToFileURL(join(root, 'kimi')).toString() },
    ];
    host.config.set('sessionNavigator.sources', host.roots);
    let active = 0;
    let maximumActive = 0;
    const completions = new Map<string, (value: SessionNavigatorScanResult) => void>();
    const resultFor = (provider: string): SessionNavigatorScanResult => ({
      ...snapshot,
      snapshot: { ...snapshot.snapshot, provider: provider as 'codex' | 'claude' | 'pi' | 'kimi' },
    });
    host.scan.mockReset().mockImplementation((_signal: AbortSignal, _budget: unknown, provider: string) => new Promise<SessionNavigatorScanResult>((resolve) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      completions.set(provider, (result) => { active -= 1; resolve(result); });
    }));

    const refreshing = tree.refresh();
    await vi.waitFor(() => expect(host.scan).toHaveBeenCalledTimes(3));
    expect(host.scan.mock.calls.map((call) => call[2])).toEqual(['kimi', 'codex', 'claude']);
    expect(completions.has('pi')).toBe(false);
    completions.get('claude')?.(resultFor('claude'));
    await vi.waitFor(() => expect(host.scan).toHaveBeenCalledTimes(4));
    expect(maximumActive).toBe(3);
    completions.get('kimi')?.(resultFor('kimi'));
    completions.get('codex')?.(resultFor('codex'));
    completions.get('pi')?.(resultFor('pi'));
    await refreshing;
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
    host.config.set('sessionNavigator.sources', host.roots);
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
    host.config.set('sessionNavigator.sources', host.roots);
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
      fingerprint: 'page-1',
      snapshot: { ...snapshot.snapshot, provider: 'claude', truncated: false, entities: [parent], relations: [], locations: [{ nativeId: 'parent', relativePath: 'parent.jsonl', rowOrdinal: '0' }] },
    });

    await tree.refresh();

    expect(host.scanPage).toHaveBeenCalledWith(expect.any(AbortSignal), expect.any(Object), 'page-2', 'claude');
    const [source] = await tree.getChildren();
    const roots = await tree.getChildren(source);
    expect(roots.map((node) => node.nodeKind === 'entity' ? node.entity.nativeId : '')).toEqual(['parent']);
    expect((await tree.getChildren(roots[0]!)).map((node) => node.nodeKind === 'entity' ? node.entity.nativeId : '')).toEqual(['child']);
  });

  it('keeps committed Claude rows when a live write invalidates the eager continuation', async () => {
    host.roots = [{ ...host.roots[0]!, provider: 'claude' }];
    host.config.set('sessionNavigator.sources', host.roots);
    host.scan.mockResolvedValueOnce({
      ...snapshot, fingerprint: 'claude-page-1', nextCursor: 'claude-page-2',
      snapshot: { ...snapshot.snapshot, provider: 'claude', truncated: true },
    });
    host.scanPage.mockRejectedValueOnce(Object.assign(new Error('Session source changed while loading a page. Refresh the source before loading more.'), { code: 'SESSION_SOURCE_CHANGED' }));

    await tree.refresh();

    const [source] = await tree.getChildren();
    if (source?.nodeKind !== 'source') throw new Error('Expected the Claude source');
    expect(source.source.updateAvailable).toBe(true);
    expect(await tree.getChildren(source)).toMatchObject([{ nodeKind: 'entity', entity: { nativeId: 'thread-1' } }]);
    expect(host.warning).not.toHaveBeenCalled();
  });

  it.each(['generic', 'kimi'] as const)('invalidates a stale %s manual continuation while retaining cached sessions', async (provider) => {
    host.roots = [{ ...host.roots[0]!, provider }];
    host.config.set('sessionNavigator.sources', host.roots);
    host.scan.mockResolvedValueOnce({
      ...snapshot, fingerprint: 'generic-page-1', nextCursor: 'generic-page-2',
      snapshot: { ...snapshot.snapshot, provider, truncated: true },
    });
    host.scanPage.mockRejectedValueOnce(Object.assign(new Error('Session source changed while loading a page. Refresh the source before loading more.'), { code: 'SESSION_SOURCE_CHANGED' }));

    await tree.refresh();
    let [source] = await tree.getChildren();
    if (source?.nodeKind !== 'source') throw new Error('Expected the generic source');
    expect(source.source.nextCursor).toBe('generic-page-2');

    await tree.loadMore(source);

    [source] = await tree.getChildren();
    if (source?.nodeKind !== 'source') throw new Error('Expected the generic source');
    expect(source.source.nextCursor).toBeUndefined();
    expect(source.source.updateAvailable).toBe(true);
    expect(await tree.getChildren(source)).toMatchObject([{ nodeKind: 'entity', entity: { nativeId: 'thread-1' } }]);
    expect(tree.getTreeItem(source).description).toContain('updates available');
    expect(host.warning).not.toHaveBeenCalled();
  });

  it('keeps a retry status visible when a manual continuation fails for another reason', async () => {
    host.roots = [{ ...host.roots[0]!, provider: 'generic' }];
    host.config.set('sessionNavigator.sources', host.roots);
    host.scan.mockResolvedValueOnce({
      ...snapshot, fingerprint: 'generic-page-1', nextCursor: 'generic-page-2',
      snapshot: { ...snapshot.snapshot, provider: 'generic', truncated: true },
    });
    host.scanPage.mockRejectedValueOnce(new Error('temporary page read failure'));

    await tree.refresh();
    const [source] = await tree.getChildren();
    if (source?.nodeKind !== 'source') throw new Error('Expected the generic source');
    await tree.loadMore(source);

    expect(tree.getTreeItem(source).description).toContain('Retry');
  });

  it('publishes a fast source while an earlier Kimi scan is still running', async () => {
    host.roots = [
      { provider: 'kimi', rootUri: pathToFileURL(join(root, 'kimi')).toString() },
      { provider: 'codex', rootUri: pathToFileURL(join(root, 'codex')).toString() },
    ];
    host.config.set('sessionNavigator.sources', host.roots);
    let finishKimi!: (value: SessionNavigatorScanResult) => void;
    host.scan.mockReset()
      .mockImplementationOnce(() => new Promise<SessionNavigatorScanResult>((resolve) => { finishKimi = resolve; }))
      .mockResolvedValueOnce({
        ...snapshot,
        snapshot: { ...snapshot.snapshot, provider: 'codex', entities: [{ ...snapshot.snapshot.entities[0]!, label: 'Fast Codex session' }] },
      });

    const refreshing = tree.refresh();
    await vi.waitFor(() => expect(host.scan).toHaveBeenCalledTimes(2));
    const sources = await tree.getChildren();
    const codex = sources.find((node) => node.nodeKind === 'source' && node.source.provider === 'codex');
    const kimi = sources.find((node) => node.nodeKind === 'source' && node.source.provider === 'kimi');
    if (codex?.nodeKind !== 'source' || kimi?.nodeKind !== 'source') throw new Error('Expected both provider sources');
    await vi.waitFor(async () => expect(await tree.getChildren(codex)).toMatchObject([{ nodeKind: 'entity', entity: { label: 'Fast Codex session' } }]));
    expect(await tree.getChildren(kimi)).toEqual([]);

    finishKimi({
      ...snapshot,
      snapshot: { ...snapshot.snapshot, provider: 'kimi', entities: [{ ...snapshot.snapshot.entities[0]!, label: 'Kimi session' }] },
    });
    await refreshing;
  });

  it('keeps source-level progress and marks partial counts', async () => {
    host.scan.mockResolvedValueOnce({ ...snapshot, snapshot: { ...snapshot.snapshot, truncated: true, truncatedReason: 'entity_limit' } });
    await tree.refresh();
    const [source] = await tree.getChildren();
    expect(tree.getTreeItem(source!).description).toBe('1 session · partial index');
    expect(host.progress).toHaveBeenCalledWith({ location: { viewId: 'jsonlView.sessionNavigator' } }, expect.any(Function));
  });

  it('exposes every root and nested child through bounded catalog page tree nodes', async () => {
    const rootEntities = Array.from({ length: 204 }, (_, index) => ({
      sourceId: 'fixture', nativeId: 'root-' + String(index), kind: 'session' as const, label: 'Root ' + String(index),
      activityAt: '2026-10-08T00:' + String(index % 60).padStart(2, '0') + ':00.000Z', confidence: 'source' as const,
    }));
    const parent = { sourceId: 'fixture', nativeId: 'parent', kind: 'session' as const, label: 'Parent', activityAt: '2026-10-08T23:59:00.000Z', confidence: 'source' as const };
    const nested = Array.from({ length: 205 }, (_, index) => ({
      sourceId: 'fixture', nativeId: 'child-' + String(index), kind: 'subagent' as const, label: 'Child ' + String(index),
      parentNativeId: 'parent', confidence: 'source' as const,
    }));
    host.scan.mockResolvedValueOnce({
      fingerprint: 'many',
      snapshot: { ...snapshot.snapshot, entities: [parent, ...rootEntities, ...nested],
        relations: nested.map((child) => ({ sourceId: 'fixture', fromNativeId: child.nativeId, toNativeId: 'parent', kind: 'parent' as const })),
        locations: [], },
    });

    await tree.refresh();
    const [source] = await tree.getChildren();
    if (source?.nodeKind !== 'source') throw new Error('Expected a source node');
    const roots: SessionNavigatorTreeNode[] = [];
    let page = await tree.getChildren(source);
    while (true) {
      expect(page.length).toBeLessThanOrEqual(201);
      roots.push(...page.filter((node) => node.nodeKind === 'entity'));
      const next = page.find((node) => node.nodeKind === 'catalog-page');
      if (next === undefined) break;
      expect(tree.getTreeItem(next).collapsibleState).toBe(1);
      expect(tree.getTreeItem(next).contextValue).toBe('jsonlView.sessionNavigator.catalogPage');
      await tree.loadMore(next);
      expect(host.scanPage).not.toHaveBeenCalled();
      page = await tree.getChildren(next);
    }
    expect(roots.filter((node) => node.nodeKind === 'entity').map((node) => node.entity.nativeId)).toHaveLength(205);
    expect(new Set(roots.filter((node) => node.nodeKind === 'entity').map((node) => node.entity.nativeId)).size).toBe(205);
    const parentNode = roots.find((node) => node.nodeKind === 'entity' && node.entity.nativeId === 'parent');
    if (parentNode === undefined || parentNode.nodeKind !== 'entity') throw new Error('Expected parent node');
    const children: SessionNavigatorTreeNode[] = [];
    page = await tree.getChildren(parentNode);
    while (true) {
      expect(page.length).toBeLessThanOrEqual(201);
      children.push(...page.filter((node) => node.nodeKind === 'entity'));
      const next = page.find((node) => node.nodeKind === 'catalog-page');
      if (next === undefined) break;
      page = await tree.getChildren(next);
    }
    expect(children.filter((node) => node.nodeKind === 'entity').map((node) => node.entity.nativeId)).toHaveLength(205);
    expect(new Set(children.filter((node) => node.nodeKind === 'entity').map((node) => node.entity.nativeId)).size).toBe(205);
  });

  async function loadedContinuation() {
    host.scan.mockResolvedValueOnce({ ...snapshot, snapshot: { ...snapshot.snapshot,
      entities: Array.from({ length: 205 }, (_, index) => ({ ...snapshot.snapshot.entities[0]!, nativeId: 'root-' + String(index) })), locations: [],
    } });
    await tree.refresh();
    const [source] = await tree.getChildren();
    if (source?.nodeKind !== 'source') throw new Error('Expected source');
    const next = (await tree.getChildren(source)).find((node) => node.nodeKind === 'catalog-page');
    if (next?.nodeKind !== 'catalog-page') throw new Error('Expected child continuation');
    return { source, next };
  }

  it('coalesces repeated expansion of the same catalog page without retaining completed pages', async () => {
    const { next } = await loadedContinuation();
    const read = vi.spyOn(CatalogStore.prototype, 'getChildrenPage');
    const pages = await Promise.all([tree.getChildren(next), tree.getChildren(next)]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(pages[0]).toEqual(pages[1]);
    expect(pages[0]).toHaveLength(5);
    await tree.getChildren(next);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each(['disable', 'dispose', 'refresh', 'remove', 'sort'] as const)('discards a late catalog page after %s', async (action) => {
    const { source, next } = await loadedContinuation();
    const original = CatalogStore.prototype.getChildrenPage;
    let complete!: () => void;
    let pageSignal!: AbortSignal;
    vi.spyOn(CatalogStore.prototype, 'getChildrenPage').mockImplementationOnce(function (this: CatalogStore, ...args) {
      const page = original.apply(this, args);
      pageSignal = args[3]!.signal!;
      return new Promise<CatalogChildrenPage>((resolve) => { complete = () => resolve(page); }) as unknown as CatalogChildrenPage;
    });
    const pending = tree.getChildren(next);
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
    if (action === 'dispose') tree.dispose();
    else if (action === 'refresh') await tree.refresh();
    else if (action === 'remove') await host.commands.get('jsonlView.sessionNavigator.removeSource')!(source);
    else if (action === 'sort') await host.commands.get('jsonlView.sessionNavigator.sortTitle')!();
    else await host.commands.get('jsonlView.sessionNavigator.disable')!();
    expect(pageSignal.aborted).toBe(true);
    complete();
    expect(await pending).toEqual([]);
  });

  it('diagnoses expired, malformed and cross-parent child cursors with a reload action', async () => {
    const { source, next } = await loadedContinuation();
    for (const invalid of [{ ...next, parentNativeId: 'other-parent' }, { ...next, cursor: 'invalid' }]) {
      const [error] = await tree.getChildren(invalid);
      expect(error?.nodeKind).toBe('catalog-error');
      expect(tree.getTreeItem(error!).command?.command).toBe('jsonlView.sessionNavigator.refresh');
    }
    host.probe.mockResolvedValueOnce('changed');
    await tree.refresh();
    expect((await tree.getChildren(next))[0]?.nodeKind).toBe('catalog-error');
    expect((await tree.getChildren(source))[0]?.nodeKind).toBe('catalog-error');
    const [current] = await tree.getChildren();
    expect((await tree.getChildren(current))[0]?.nodeKind).toBe('entity');
  });

  it('rejects a catalog page completed after a new generation commits', async () => {
    const { next } = await loadedContinuation();
    const original = CatalogStore.prototype.getChildrenPage;
    let complete!: () => void;
    let catalog!: CatalogStore;
    vi.spyOn(CatalogStore.prototype, 'getChildrenPage').mockImplementationOnce(function (this: CatalogStore, ...args) {
      catalog = this;
      const page = original.apply(this, args);
      return new Promise<CatalogChildrenPage>((resolve) => { complete = () => resolve(page); }) as unknown as CatalogChildrenPage;
    });
    const pending = tree.getChildren(next);
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
    catalog.replaceSnapshot(next.sourceId, { ...snapshot.snapshot, entities: [], locations: [] }, 'new-generation');
    complete();
    const result = await pending;
    expect(result).toHaveLength(1);
    expect(result[0]?.nodeKind).toBe('catalog-error');
    expect(result.some((node) => node.nodeKind === 'entity')).toBe(false);
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
    host.config.set('sessionNavigator.sources', []);
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

  it('coalesces same-cursor loadMore and aborts it before a revoked source can append', async () => {
    host.scan.mockResolvedValueOnce({
      ...snapshot,
      nextCursor: 'cursor-1',
      snapshot: { ...snapshot.snapshot, truncated: true, nextCursor: 'cursor-1' },
    });
    await tree.refresh();
    const [source] = await tree.getChildren();
    if (source?.nodeKind !== 'source') throw new Error('Expected a source node');
    let complete!: (value: SessionNavigatorScanResult) => void;
    let pageSignal!: AbortSignal;
    host.scanPage.mockImplementationOnce((signal: AbortSignal) => {
      pageSignal = signal;
      return new Promise<SessionNavigatorScanResult>((resolve) => { complete = resolve; });
    });
    const first = tree.loadMore(source);
    const second = tree.loadMore(source);
    await vi.waitFor(() => expect(host.scanPage).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(pageSignal).toBeInstanceOf(AbortSignal));
    await host.commands.get('jsonlView.sessionNavigator.removeSource')!(source);
    expect(pageSignal.aborted).toBe(true);
    complete({ ...snapshot, snapshot: { ...snapshot.snapshot, entities: [{ ...snapshot.snapshot.entities[0]!, nativeId: 'late' }] } });
    await Promise.all([first, second]);
    expect(await tree.getChildren()).toEqual([]);
  });
});
