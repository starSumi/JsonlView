import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { AuthorizedSourceSetting, SessionNavigatorScanResult } from '../../src/experimental/session-navigator/types';
import type { SessionNavigatorTreeNode } from '../../src/experimental/session-navigator/tree-provider';
import { CollectionsTreeProvider, type CollectionsTreeNode } from '../../src/experimental/session-navigator/collections-tree-provider';
import { CollectionsError, type CollectionsPort } from '../../src/application';

const host = vi.hoisted(() => {
  const sourceDropVisibilityListeners = new Set<(visible: boolean) => void>();
  return {
  config: new Map<string, unknown>(), state: new Map<string, unknown>(),
  commands: new Map<string, (...args: any[]) => unknown>(),
  trees: new Map<string, unknown>(), input: vi.fn(), nativePicker: vi.fn(), previewUri: vi.fn(), previewText: vi.fn(),
  webviews: new Map<string, vscode.WebviewViewProvider>(),
  panels: [] as Array<any>, createPanel: vi.fn(),
  sourceDropVisibilityListeners,
  roots: [] as AuthorizedSourceSetting[], discover: vi.fn(), scan: vi.fn(), scanPage: vi.fn(), picker: vi.fn(), dialog: vi.fn(),
  configuration: undefined as undefined | ((event: { affectsConfiguration: (key: string) => boolean }) => void),
  visibility: undefined as undefined | ((event: { visible: boolean }) => void),
  windowState: { focused: true },
  focus: undefined as undefined | ((event: { focused: boolean }) => void),
  view: { visible: false, description: undefined as string | undefined, message: undefined as string | undefined, dispose() {}, onDidChangeVisibility: vi.fn((listener: (event: { visible: boolean }) => void) => { sourceDropVisibilityListeners.add((visible) => listener({ visible })); return { dispose() {} }; }) },
  progress: vi.fn(), intake: vi.fn(), probe: vi.fn(), execute: vi.fn(), persist: vi.fn(), info: vi.fn(), warning: vi.fn(), validateSource: vi.fn(), previewCollectionFailure: vi.fn(), updates: vi.fn(), overridden: false,
  };
});
vi.mock('vscode', () => ({
  EventEmitter: class {
    readonly listeners = new Set<(value: unknown) => void>();
    event = (listener: (value: unknown) => void) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
    fire(value: unknown) { for (const listener of this.listeners) listener(value); }
    dispose() { this.listeners.clear(); }
  },
  TreeItem: class { constructor(public label: string, public collapsibleState: number) {} },
  DataTransferItem: class { constructor(public value: unknown) {} async asString() { return typeof this.value === 'string' ? this.value : JSON.stringify(this.value); } },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1 },
  ThemeIcon: class { constructor(public id: string) {} },
  Uri: {
    joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: join(base.fsPath, ...parts) }),
    file: (path: string) => ({ fsPath: path, toString: () => pathToFileURL(path).toString() }),
    parse: (value: string) => ({ scheme: new URL(value).protocol.replace(':', ''), fsPath: fileURLToPath(value), toString: () => value }),
  },
  ConfigurationTarget: { Global: 1 },
  ViewColumn: { Active: -1 },
  window: { state: host.windowState, onDidChangeWindowState: (listener: typeof host.focus) => { host.focus = listener; return { dispose() {} }; }, createTreeView: (id: string, options: unknown) => { host.trees.set(id, options); return host.view; }, createWebviewPanel: (...args: unknown[]) => host.createPanel(...args), createQuickPick: host.nativePicker, showInputBox: host.input, registerWebviewViewProvider: (id: string, provider: vscode.WebviewViewProvider) => { host.webviews.set(id, provider); return { dispose() {} }; }, withProgress: host.progress, showQuickPick: host.picker, showOpenDialog: host.dialog, showSaveDialog: host.dialog, showInformationMessage: host.info, showWarningMessage: host.warning, showErrorMessage: vi.fn() },
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
  return { ...actual, discoverDefaultSources: () => { host.discover(); return host.roots; }, mergeSourceSettings: (configured: AuthorizedSourceSetting[], discovered: AuthorizedSourceSetting[] = host.roots) => actual.mergeSourceSettings(configured, discovered) };
});
vi.mock('../../src/experimental/session-navigator/provider-factory', () => ({ createSessionNavigatorProvider: (setting: AuthorizedSourceSetting) => ({
  provider: setting.provider, sourceId: setting.provider, rootUri: setting.rootUri,
  scan: (signal: AbortSignal, budget: unknown) => host.scan(signal, budget, setting.provider),
  scanPage: (signal: AbortSignal, budget: unknown, cursor?: string) => host.scanPage(signal, budget, cursor, setting.provider),
  probe: (signal: AbortSignal) => host.probe(signal, setting.provider),
}) }));
vi.mock('../../src/experimental/session-navigator/source-intake', () => ({
  SourceIntakePanel: class {
    show() { host.intake(); }
    previewUri(uri: vscode.Uri) { return host.previewUri(uri); }
    previewText(text: string, signal: AbortSignal) { return host.previewText(text, signal); }
    offerPreviewSaveAs() {}
    async dispose() {}
  },
  validateLocalSourceUri: (value: string) => host.validateSource(value),
}));
import { SessionNavigatorTreeProvider } from '../../src/experimental/session-navigator/tree-provider';
import { RevealIntentRegistry } from '../../src/experimental/session-navigator/reveal-intents';
import { CatalogStore, type CatalogChildrenPage } from '../../src/experimental/session-navigator/catalog-store';
import { CollectionsStore } from '../../src/infrastructure/navigator/collections-store';
import { COLLECTIONS_PENDING_PREFIX } from '../../src/experimental/session-navigator/collections-recovery';
import { createRevealProtocolFixture } from '../fixtures/reveal-protocol';

let root: string;
let tree: SessionNavigatorTreeProvider;
let visibilityRegistration = 0;
function collectionsState() {
  return { keys: () => [...host.state.keys()], get: (key: string) => host.state.get(key),
    update: async (key: string, value: unknown) => { await host.persist(); if (value === undefined) host.state.delete(key); else host.state.set(key, structuredClone(value)); } };
}
function pendingCollectionCommands(): number {
  const db = new DatabaseSync(join(root, 'collections', 'metadata.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT count(*) AS n FROM collections_pending_command').get()?.n as number; }
  finally { db.close(); }
}
function createTree(registry = new RevealIntentRegistry()): SessionNavigatorTreeProvider {
  return new SessionNavigatorTreeProvider({
    globalStorageUri: { fsPath: root },
    globalState: { ...collectionsState(), get: (key: string, fallback: unknown) => host.state.get(key) ?? fallback },
  } as unknown as vscode.ExtensionContext, registry, undefined, undefined, (error) => host.previewCollectionFailure(error));
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
  visibilityRegistration = 0;
  host.config.clear(); host.state.clear(); host.commands.clear(); host.trees.clear(); host.webviews.clear(); host.panels.length = 0;
  host.createPanel.mockReset().mockImplementation((viewType: string, title: string, column: number, options: unknown) => {
    let receive: ((message: unknown) => void) | undefined;
    let close: (() => void) | undefined;
    const webview = { html: '', options: {}, postMessage: vi.fn().mockResolvedValue(true),
      onDidReceiveMessage: (listener: typeof receive) => { receive = listener; return { dispose() {} }; } };
    const panel = { viewType, title, column, options, webview, reveal: vi.fn(),
      onDidDispose: (listener: typeof close) => { close = listener; return { dispose() {} }; },
      dispose: vi.fn(() => close?.()), receive: (message: unknown) => receive?.(message) };
    host.panels.push(panel);
    return panel;
  });
  host.input.mockReset(); host.nativePicker.mockReset(); host.previewUri.mockReset().mockResolvedValue(undefined); host.previewText.mockReset().mockResolvedValue(undefined);
  mockNativeIntakePicker(undefined);
  host.config.set('sessionNavigator.enabled', true);
  host.roots = [{ provider: 'codex', rootUri: pathToFileURL(join(root, 'provider')).toString() }];
  host.discover.mockReset();
  host.config.set('sessionNavigator.sources', host.roots);
  host.scan.mockReset().mockResolvedValue(snapshot); host.scanPage.mockReset(); host.dialog.mockReset(); host.picker.mockReset(); host.intake.mockReset();
  host.probe.mockReset().mockResolvedValue('stable'); host.execute.mockReset().mockResolvedValue(undefined);
  host.validateSource.mockReset().mockImplementation(async (value: string) => ({
    fsPath: fileURLToPath(value),
    toString: (_skipEncoding?: boolean) => value,
  }));
  host.previewCollectionFailure.mockReset();
  host.persist.mockReset().mockResolvedValue(undefined);
  host.info.mockReset().mockResolvedValue(undefined); host.warning.mockReset().mockResolvedValue(undefined); host.updates.mockReset(); host.overridden = false;
  host.view.visible = false;
  host.view.description = undefined;
  host.windowState.focused = true;
  host.view.message = undefined;
  host.sourceDropVisibilityListeners.clear();
  host.progress.mockReset().mockImplementation(async (_options: unknown, callback: () => Promise<void>) => callback());
  host.view.onDidChangeVisibility.mockImplementation((listener: typeof host.visibility) => {
    if (visibilityRegistration++ === 0) host.sourceDropVisibilityListeners.add((visible) => listener?.({ visible }));
    else host.visibility = (event) => {
      host.view.visible = event.visible;
      listener?.(event);
    };
    return { dispose() {} };
  });
  tree = createTree();
  tree.register();
});
afterEach(async () => { host.validateSource.mockReset(); host.previewCollectionFailure.mockReset(); vi.restoreAllMocks(); tree.dispose(); await rm(root, { recursive: true, force: true }); });

function mockNativeIntakePicker(...actions: Array<string | undefined>): void {
  host.nativePicker.mockImplementation(() => {
    const action = actions.shift();
    let accepted = () => {}; let hidden = () => {};
    const picker = {
      items: [] as Array<{ action: string }>, selectedItems: [] as Array<{ action: string }>,
      onDidAccept: (listener: () => void) => { accepted = listener; return { dispose() {} }; },
      onDidHide: (listener: () => void) => { hidden = listener; return { dispose() {} }; },
      dispose() {}, show() { queueMicrotask(() => {
        if (action === undefined) hidden();
        else { picker.selectedItems = picker.items.filter((item) => item.action === action); accepted(); }
      }); },
    };
    return picker;
  });
}

function upperBoard(): { treeDataProvider: CollectionsTreeProvider; dragAndDropController: vscode.TreeDragAndDropController<CollectionsTreeNode> } {
  return host.trees.get('jsonlView.sourceDrop') as ReturnType<typeof upperBoard>;
}

function sessionBoard(): { treeDataProvider: unknown; canSelectMany: boolean; dragAndDropController: vscode.TreeDragAndDropController<SessionNavigatorTreeNode> } {
  return host.trees.get('jsonlView.sessionNavigator') as ReturnType<typeof sessionBoard>;
}

function probeVisibleSources(): Promise<void> {
  return (tree as unknown as { probeVisibleSources: () => Promise<void> }).probeVisibleSources();
}

describe('Session Navigator host lifecycle', () => {
  function openImportCanvas() {
    expect(host.webviews.has('jsonlView.sourceIntake')).toBe(false);
    host.commands.get('jsonlView.sessionNavigator.openImportCanvas')!();
    return host.panels.at(-1)!;
  }

  it('opens one full-size intake panel from the Collections toolbar without scanning', () => {
    host.config.set('sessionNavigator.enabled', false);
    const panel = openImportCanvas();
    expect(panel).toMatchObject({ viewType: 'jsonlView.sourceImportCanvas', title: 'Use Resources', column: -1,
      options: { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true } });
    expect(panel.webview.html).toContain('Drag one file from File Explorer anywhere on this canvas.');
    expect(host.config.get('sessionNavigator.enabled')).toBe(false);
    expect(host.discover).not.toHaveBeenCalled(); expect(host.scan).not.toHaveBeenCalled();
  });

  it('keeps file and folder pickers explicit and routes them through existing source authorization', async () => {
    const panel = openImportCanvas();
    panel.receive({ intakeProtocolVersion: 1, type: 'pick-files' });
    await vi.waitFor(() => expect(host.dialog).toHaveBeenCalledOnce());
    expect(host.dialog).toHaveBeenLastCalledWith(expect.objectContaining({ canSelectFiles: true, canSelectFolders: false, canSelectMany: true }));
    host.dialog.mockReset().mockResolvedValueOnce(undefined);
    panel.receive({ intakeProtocolVersion: 1, type: 'pick-folder' });
    await vi.waitFor(() => expect(host.dialog).toHaveBeenCalledOnce());
    expect(host.dialog).toHaveBeenLastCalledWith(expect.objectContaining({ canSelectFiles: false, canSelectFolders: true }));
    expect(host.discover).not.toHaveBeenCalled(); expect(host.scan).not.toHaveBeenCalled();
  });

  it('opens one explicitly authorized JSONL file in Data Studio from the Import canvas', async () => {
    host.config.set('sessionNavigator.enabled', false);
    host.config.set('sessionNavigator.sources', []);
    const selectedPath = join(root, 'selected.ndjson');
    await writeFile(selectedPath, '{"message":"synthetic"}\n');
    const selectedUri = { fsPath: selectedPath, toString: () => pathToFileURL(selectedPath).toString() } as vscode.Uri;
    const canonicalUri = { ...selectedUri } as vscode.Uri;
    host.dialog.mockResolvedValueOnce([selectedUri]);
    host.validateSource.mockResolvedValueOnce(canonicalUri);
    host.warning.mockResolvedValueOnce('Add source');
    host.picker.mockResolvedValueOnce({ label: 'Generic JSONL', value: 'generic' });

    const panel = openImportCanvas();
    panel.receive({ intakeProtocolVersion: 1, type: 'pick-files' });

    await vi.waitFor(() => expect(host.execute).toHaveBeenCalledWith('vscode.openWith', canonicalUri, 'jsonlView.editor'));
    expect(host.config.get('sessionNavigator.sources')).toContainEqual({ provider: 'generic', rootUri: canonicalUri.toString() });
    expect(host.config.get('sessionNavigator.enabled')).toBe(false);
    expect(host.scan).not.toHaveBeenCalled();
  });

  it('does not automatically open files when a multi-file selection is authorized', async () => {
    host.config.set('sessionNavigator.enabled', false);
    host.config.set('sessionNavigator.sources', []);
    const firstPath = join(root, 'first.jsonl');
    const secondPath = join(root, 'second.jsonl');
    await writeFile(firstPath, '{}\n');
    await writeFile(secondPath, '{}\n');
    const selectedUris = [firstPath, secondPath].map((selectedPath) => ({
      fsPath: selectedPath,
      toString: () => pathToFileURL(selectedPath).toString(),
    }) as vscode.Uri);
    const canonicalUris = selectedUris.map((uri) => ({ ...uri }) as vscode.Uri);
    host.dialog.mockResolvedValueOnce(selectedUris);
    host.validateSource.mockImplementation(async (value: string) => canonicalUris.find((uri) => uri.toString() === value)!);
    host.warning.mockResolvedValue('Add source');
    host.picker.mockResolvedValue({ label: 'Generic JSONL', value: 'generic' });
    host.info.mockResolvedValueOnce('Enable');

    const panel = openImportCanvas();
    panel.receive({ intakeProtocolVersion: 1, type: 'pick-files' });

    await vi.waitFor(() => expect(host.config.get('sessionNavigator.sources')).toHaveLength(2));
    await vi.waitFor(() => expect(host.config.get('sessionNavigator.enabled')).toBe(true));
    expect(host.info).toHaveBeenCalledWith(
      'Authorized 2 read-only sources. Enable Session Navigator to browse them in the sidebar.',
      'Enable',
    );
    expect(host.execute).not.toHaveBeenCalledWith('vscode.openWith', expect.anything(), 'jsonlView.editor');
  });

  it('does not apply a deferred Navigator-enable choice after the Import canvas closes', async () => {
    host.config.set('sessionNavigator.enabled', false);
    host.config.set('sessionNavigator.sources', []);
    const selectedPaths = [join(root, 'first.jsonl'), join(root, 'second.jsonl')];
    await Promise.all(selectedPaths.map((selectedPath) => writeFile(selectedPath, '{}\n')));
    const selectedUris = selectedPaths.map((selectedPath) => ({
      fsPath: selectedPath,
      toString: () => pathToFileURL(selectedPath).toString(),
    }) as vscode.Uri);
    const canonicalUris = selectedUris.map((uri) => ({ ...uri }) as vscode.Uri);
    host.dialog.mockResolvedValueOnce(selectedUris);
    host.validateSource.mockImplementation(async (value: string) => canonicalUris.find((uri) => uri.toString() === value)!);
    host.warning.mockResolvedValue('Add source');
    host.picker.mockResolvedValue({ label: 'Generic JSONL', value: 'generic' });
    let choose!: (value: string | undefined) => void;
    host.info.mockImplementationOnce(() => new Promise((resolve) => { choose = resolve; }));

    const panel = openImportCanvas();
    panel.receive({ intakeProtocolVersion: 1, type: 'pick-files' });

    await vi.waitFor(() => expect(host.info).toHaveBeenCalledOnce());
    panel.dispose();
    choose('Enable');
    await new Promise((resolve) => setImmediate(resolve));

    expect(host.config.get('sessionNavigator.enabled')).toBe(false);
  });

  it('shows a warning when the deferred Navigator-enable setting cannot be confirmed', async () => {
    host.config.set('sessionNavigator.enabled', false);
    host.config.set('sessionNavigator.sources', []);
    const selectedPaths = [join(root, 'first.jsonl'), join(root, 'second.jsonl')];
    await Promise.all(selectedPaths.map((selectedPath) => writeFile(selectedPath, '{}\n')));
    const selectedUris = selectedPaths.map((selectedPath) => ({
      fsPath: selectedPath,
      toString: () => pathToFileURL(selectedPath).toString(),
    }) as vscode.Uri);
    const canonicalUris = selectedUris.map((uri) => ({ ...uri }) as vscode.Uri);
    host.dialog.mockResolvedValueOnce(selectedUris);
    host.validateSource.mockImplementation(async (value: string) => canonicalUris.find((uri) => uri.toString() === value)!);
    host.warning.mockResolvedValue('Add source');
    host.picker.mockResolvedValue({ label: 'Generic JSONL', value: 'generic' });
    let choose!: (value: string | undefined) => void;
    host.info.mockImplementationOnce(() => new Promise((resolve) => { choose = resolve; }));

    const panel = openImportCanvas();
    panel.receive({ intakeProtocolVersion: 1, type: 'pick-files' });

    await vi.waitFor(() => expect(host.info).toHaveBeenCalledOnce());
    host.overridden = true;
    choose('Enable');

    await vi.waitFor(() => expect(host.warning).toHaveBeenCalledWith(
      'Session Navigator could not be enabled. Check the effective setting and try again.',
    ));
    expect(host.config.get('sessionNavigator.enabled')).toBe(false);
  });

  it('routes pasted JSONL only after the user submits it for a temporary preview', async () => {
    const panel = openImportCanvas();
    panel.receive({ intakeProtocolVersion: 1, type: 'import-jsonl', text: '{"message":"synthetic"}\\n' });
    await vi.waitFor(() => expect(host.previewText).toHaveBeenCalledWith('{"message":"synthetic"}\\n', expect.any(AbortSignal)));
    expect(host.dialog).not.toHaveBeenCalled(); expect(host.updates).not.toHaveBeenCalled();
    expect(host.scan).not.toHaveBeenCalled();
  });

  it('discards a late native file selection after the import canvas closes', async () => {
    const panel = openImportCanvas();
    let select!: (uris: vscode.Uri[]) => void;
    host.dialog.mockImplementationOnce(() => new Promise<vscode.Uri[]>(resolve => { select = resolve; }));
    panel.receive({ intakeProtocolVersion: 1, type: 'pick-files' });
    await vi.waitFor(() => expect(select).toBeTypeOf('function'));
    panel.dispose();
    select([{ fsPath: join(root, 'late.jsonl') } as vscode.Uri]);
    await new Promise(resolve => setImmediate(resolve));
    expect(host.validateSource).not.toHaveBeenCalled(); expect(host.updates).not.toHaveBeenCalled();
    expect(panel.webview.postMessage.mock.calls.at(-1)?.[0].state).toBe('busy');
  });

  it('aggregates visible child views without coupling Collections visibility to Sessions scanning', async () => {
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

  it('does not root-refresh Collections when the Sessions projection changes', async () => {
    const changed: unknown[] = [];
    const registration = upperBoard().treeDataProvider.onDidChangeTreeData((value) => changed.push(value));

    await tree.refresh();

    expect(changed).toEqual([]);
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

  it('offers an explicit source-authorization step after a preview copy is saved', async () => {
    host.config.set('sessionNavigator.enabled', false);
    const preview = await tree.previews.create('{"synthetic":true}\n', 1, new AbortController().signal);
    expect(preview).toBeDefined();
    const savedUri = { scheme: 'file', authority: '', query: '', fragment: '', fsPath: join(root, 'saved-preview.jsonl'), toString: () => pathToFileURL(join(root, 'saved-preview.jsonl')).toString() } as vscode.Uri;
    host.dialog.mockResolvedValue(savedUri);
    host.info.mockResolvedValue('Add as source');
    host.warning.mockResolvedValue('Add source');
    host.picker.mockResolvedValue({ label: 'Generic JSONL', value: 'generic' });
    host.validateSource.mockResolvedValue(savedUri);

    const outcome = await host.commands.get('jsonlView.previews.saveAs')!({ id: preview!.id });

    expect(outcome).toBe('saved');
    expect(host.info).toHaveBeenCalledWith(
      'Saved "saved-preview.jsonl". Add it as a source or file it into a Collection?',
      'Add as source', 'Add to Collection', 'Dismiss',
    );
    expect(host.warning).toHaveBeenCalledWith(
      expect.stringContaining('Add ' + savedUri.fsPath + ' as a read-only source?'),
      { modal: true },
      'Add source',
    );
    expect(host.config.get('sessionNavigator.sources')).toContainEqual({ provider: 'generic', rootUri: savedUri.toString() });
    const group = (await tree.getChildren()).find((node) => node.nodeKind === 'preview-group');
    const savedNode = group === undefined ? undefined : (await tree.getChildren(group))[0];
    expect(savedNode).toBeDefined();
    expect(tree.getTreeItem(savedNode!).command).toMatchObject({ command: 'jsonlView.previews.openSavedCopy' });
    expect(host.scan).not.toHaveBeenCalled();
    expect(host.trees.has('jsonlView.sourceDrop')).toBe(true);
  });

  it('leaves Session Navigator and Collections unchanged when the post-save source action is dismissed', async () => {
    host.config.set('sessionNavigator.enabled', false);
    const sources = host.config.get('sessionNavigator.sources');
    const preview = await tree.previews.create('{"synthetic":true}\n', 1, new AbortController().signal);
    expect(preview).toBeDefined();
    host.dialog.mockResolvedValue({ fsPath: join(root, 'saved-preview.jsonl'), scheme: 'file', authority: '', query: '', fragment: '', toString: () => pathToFileURL(join(root, 'saved-preview.jsonl')).toString() } as vscode.Uri);
    host.info.mockResolvedValue(undefined);

    expect(await host.commands.get('jsonlView.previews.saveAs')!({ id: preview!.id })).toBe('saved');

    expect(host.info).toHaveBeenCalledOnce();
    expect(host.warning).not.toHaveBeenCalled();
    expect(host.config.get('sessionNavigator.sources')).toBe(sources);
    expect(host.scan).not.toHaveBeenCalled();
    expect(host.updates).not.toHaveBeenCalled();
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
    const detectedRoots = await tree.getChildren();
    expect(detectedRoots).toHaveLength(2);
    expect(tree.getTreeItem(detectedRoots[0]!)).toMatchObject({ label: 'Detected sources' });
    expect(tree.getTreeItem(detectedRoots[0]!).collapsibleState).toBe(1);
    expect(tree.getTreeItem(detectedRoots[1]!)).toMatchObject({ label: 'Connect local agent…', command: { command: 'jsonlView.sessionNavigator.authorizeAgent' } });
    expect(host.discover).not.toHaveBeenCalled();
    expect(await tree.getChildren(detectedRoots[0]!)).toHaveLength(1);
    expect(host.discover).toHaveBeenCalledExactlyOnceWith();
    expect(host.roots).toHaveLength(1);
    expect(host.updates.mock.calls.some(([key]) => key === 'sessionNavigator.sources')).toBe(false);
    expect(host.config.get('sessionNavigator.sources')).toEqual([]);
    expect(host.scan).not.toHaveBeenCalled(); expect(host.probe).not.toHaveBeenCalled();

    host.roots = [];
    const emptyRoots = await tree.getChildren();
    expect(emptyRoots).toHaveLength(2);
    expect(tree.getTreeItem(emptyRoots[0]!)).toMatchObject({ label: 'Detected sources' });
    expect(host.discover).toHaveBeenCalledExactlyOnceWith();
    const emptyChildren = await tree.getChildren(emptyRoots[0]!);
    expect(emptyChildren).toHaveLength(1);
    expect(tree.getTreeItem(emptyChildren[0]!)).toMatchObject({ label: 'No additional local agent sources detected' });
    expect(host.discover).toHaveBeenCalledTimes(2);
    expect(host.config.get('sessionNavigator.sources')).toEqual([]);
    expect(host.scan).not.toHaveBeenCalled(); expect(host.probe).not.toHaveBeenCalled();
  });

  it('keeps agent-add actions visible and offers only un-authorized Pi/Kimi candidates after Codex is authorized', async () => {
    const codex = host.roots[0]!;
    const pi = { provider: 'pi' as const, rootUri: pathToFileURL(join(root, 'pi-home')).toString() };
    const kimi = { provider: 'kimi' as const, rootUri: pathToFileURL(join(root, 'kimi-home')).toString() };
    host.roots = [codex, pi, kimi];
    host.config.set('sessionNavigator.sources', [codex]);
    const roots = await tree.getChildren();
    expect(roots.map((node) => node.nodeKind)).toEqual(['source', 'detected-group', 'connect-agent']);
    expect(tree.getTreeItem(roots[2]!).command).toMatchObject({ command: 'jsonlView.sessionNavigator.authorizeAgent' });
    expect(host.discover).not.toHaveBeenCalled();

    const candidates = await tree.getChildren(roots[1]!);
    expect(candidates.map((node) => node.nodeKind === 'detected-source' ? node.provider : node.nodeKind)).toEqual(['pi', 'kimi']);
    expect(host.discover).toHaveBeenCalledExactlyOnceWith();
    expect(host.config.get('sessionNavigator.sources')).toEqual([codex]);
    expect(host.updates.mock.calls.some(([key]) => key === 'sessionNavigator.sources')).toBe(false);
    expect(host.scan).not.toHaveBeenCalled();
    expect(host.probe).not.toHaveBeenCalled();
  });

  it.each(['pi', 'kimi'] as const)('adds %s later through the provider picker without replacing or duplicating Codex', async (provider) => {
    host.config.set('sessionNavigator.enabled', false);
    const codex = host.roots[0]!;
    const pi = { provider: 'pi' as const, rootUri: pathToFileURL(join(root, 'pi-home')).toString() };
    const kimi = { provider: 'kimi' as const, rootUri: pathToFileURL(join(root, 'kimi-home')).toString() };
    host.roots = [codex, pi, kimi];
    host.config.set('sessionNavigator.sources', [codex]);
    host.picker.mockResolvedValue({ value: provider });

    const connect = host.commands.get('jsonlView.sessionNavigator.authorizeAgent')!;
    await connect();
    await connect();

    expect(host.config.get('sessionNavigator.sources')).toEqual([codex, provider === 'pi' ? pi : kimi]);
    expect(host.config.get('sessionNavigator.enabled')).toBe(false);
    expect(host.updates.mock.calls.filter(([key]) => key === 'sessionNavigator.sources')).toEqual([
      ['sessionNavigator.sources', [codex, provider === 'pi' ? pi : kimi]],
      ['sessionNavigator.sources', [codex, provider === 'pi' ? pi : kimi]],
    ]);
    expect(host.scan).not.toHaveBeenCalled();
    expect(host.probe).not.toHaveBeenCalled();
  });

  it('keeps polling dormant while the visible Sessions view has no authorized sources', async () => {
    vi.useFakeTimers();
    try {
      host.config.set('sessionNavigator.sources', []);
      host.visibility!({ visible: true });
      expect(host.view.description).toBeUndefined();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(host.probe).not.toHaveBeenCalled();
      expect(host.scan).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
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

  it('launches Add Source for an unauthorized file without focusing Collections or granting access', async () => {
    host.config.set('sessionNavigator.sources', []);
    const result = await tree.open({ documentId: 'synthetic-document', sourceUri: pathToFileURL(join(root, 'unregistered.jsonl')).toString() });
    expect(result).toMatchObject({ status: 'authorization-required', authorization: 'required', authorizationReadback: 'not-requested', action: 'focus-add-source' });
    expect(host.nativePicker).toHaveBeenCalledOnce();
    expect(host.execute).not.toHaveBeenCalled(); expect(host.updates).not.toHaveBeenCalled();
    expect(host.scan).not.toHaveBeenCalled(); expect(host.probe).not.toHaveBeenCalled();
    expect(await upperBoard().treeDataProvider.getChildren()).toMatchObject([{ kind: 'notice' }]);
  });

  it.each([true, false])('reads back target authorization after explicit Import without filing it: same target %s', async (sameTarget) => {
    host.config.set('sessionNavigator.sources', []);
    const targetPath = join(root, 'target.jsonl'); const importedPath = sameTarget ? targetPath : join(root, 'other.jsonl');
    await writeFile(targetPath, '{}\n'); if (!sameTarget) await writeFile(importedPath, '{}\n');
    const uri = { fsPath: importedPath, toString: () => pathToFileURL(importedPath).toString() };
    mockNativeIntakePicker('import', 'files'); host.dialog.mockResolvedValue([uri]);
    host.validateSource.mockResolvedValue(uri); host.warning.mockResolvedValueOnce('Add source');
    host.picker.mockResolvedValueOnce({ value: 'codex' });
    const result = await tree.open({ documentId: 'synthetic-document', sourceUri: pathToFileURL(targetPath).toString() });
    expect(result).toMatchObject(sameTarget
      ? { status: 'opened', authorization: 'granted', authorizationReadback: 'confirmed', action: 'focus-sessions', targetDocumentId: 'synthetic-document' }
      : { status: 'authorization-required', authorization: 'required', authorizationReadback: 'not-requested', action: 'focus-add-source' });
    expect(host.execute).not.toHaveBeenCalledWith('workbench.action.focusView', 'jsonlView.sourceDrop');
    expect(await upperBoard().treeDataProvider.getChildren()).toMatchObject([{ kind: 'notice' }]);
  });

  it('reads back disabled state after the unauthorized-target picker settles', async () => {
    host.config.set('sessionNavigator.sources', []);
    let hide!: () => void;
    host.nativePicker.mockImplementationOnce(() => ({
      items: [], selectedItems: [], onDidAccept: () => ({ dispose() {} }),
      onDidHide: (listener: () => void) => { hide = listener; return { dispose() {} }; },
      dispose() {}, show() {},
    }));
    const pending = tree.open({ documentId: 'synthetic-document', sourceUri: pathToFileURL(join(root, 'unregistered.jsonl')).toString() });
    await vi.waitFor(() => expect(hide).toBeTypeOf('function'));
    host.config.set('sessionNavigator.enabled', false); hide();
    expect(await pending).toMatchObject({ status: 'cancelled', enabled: 'disabled', authorization: 'not-requested', action: 'none' });
    expect(host.execute).not.toHaveBeenCalled(); expect(host.updates).not.toHaveBeenCalled();
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

  async function collectionEntryFor(entity: Awaited<ReturnType<typeof loadedEntity>>) {
    const upper = upperBoard().treeDataProvider;
    host.input.mockResolvedValueOnce('Work'); await host.commands.get('jsonlView.sessionNavigator.collections.create')!();
    host.picker.mockImplementationOnce(async (items: Array<unknown>) => items[0]);
    await host.commands.get('jsonlView.sessionNavigator.collections.fileInto')!(entity);
    const [collection] = await upper.getChildren();
    const [entry] = await upper.getChildren(collection);
    if (entry?.kind !== 'entry') throw new Error('Expected a collection entry');
    return entry;
  }

  function sessionReferenceTransfer(source: readonly (SessionNavigatorTreeNode | CollectionsTreeNode)[]) {
    const transfer = new Map<string, { value: unknown; asString(): Promise<string> }>();
    const dataTransfer = {
      set: (mime: string, item: { value: unknown; asString(): Promise<string> }) => transfer.set(mime, item),
      get: (mime: string) => transfer.get(mime),
      forEach: () => {},
    };
    const token = { isCancellationRequested: false } as vscode.CancellationToken;
    if (source.every((node): node is CollectionsTreeNode => 'kind' in node)) {
      upperBoard().dragAndDropController.handleDrag?.(source, dataTransfer as unknown as vscode.DataTransfer, token);
    } else {
      sessionBoard().dragAndDropController.handleDrag?.(source as readonly SessionNavigatorTreeNode[], dataTransfer as unknown as vscode.DataTransfer, token);
    }
    return { dataTransfer, transfer };
  }

  it.each(['root', 'source', 'entity'] as const)('opens a collection session reference dropped on the Agent Sessions %s target', async (targetKind) => {
    await mkdir(join(root, 'provider', 'sessions'), { recursive: true });
    await writeFile(join(root, 'provider', 'sessions', 'thread.jsonl'), '{}\n');
    const entity = await loadedEntity();
    const entry = await collectionEntryFor(entity);
    const { dataTransfer, transfer } = sessionReferenceTransfer([entry]);
    expect(transfer.get('application/vnd.jsonlview.session-ref')).toBeDefined();

    const target = targetKind === 'root' ? undefined : targetKind === 'source' ? (await tree.getChildren())[0] : entity;
    await sessionBoard().dragAndDropController.handleDrop!(target, dataTransfer as unknown as vscode.DataTransfer, { isCancellationRequested: false } as vscode.CancellationToken);

    expect(host.execute).toHaveBeenCalledWith('vscode.openWith', expect.objectContaining({ fsPath: join(root, 'provider', 'sessions', 'thread.jsonl') }), 'jsonlView.editor');
    expect(host.previewUri).not.toHaveBeenCalled();
    expect((await upperBoard().treeDataProvider.getChildren()).at(0)).toMatchObject({ kind: 'collection', collection: { entryCount: 1 } });
  });

  it('refuses a collection session drop when its catalog generation changed after dragging', async () => {
    await mkdir(join(root, 'provider', 'sessions'), { recursive: true });
    await writeFile(join(root, 'provider', 'sessions', 'thread.jsonl'), '{}\n');
    const entity = await loadedEntity();
    const entry = await collectionEntryFor(entity);
    const { dataTransfer } = sessionReferenceTransfer([entry]);
    host.scan.mockResolvedValueOnce({ ...snapshot, fingerprint: 'replacement', snapshot: { ...snapshot.snapshot, snapshotId: 'replacement', sourceGeneration: 'scan-2' } });
    host.probe.mockResolvedValueOnce('replacement');
    await tree.refresh();
    const [source] = await tree.getChildren();

    await sessionBoard().dragAndDropController.handleDrop!(source, dataTransfer as unknown as vscode.DataTransfer, { isCancellationRequested: false } as vscode.CancellationToken);

    expect(host.execute).not.toHaveBeenCalled();
    expect(host.warning).toHaveBeenCalledWith(expect.stringContaining('stale or no longer authorized'));
  });

  it('refuses a collection session drop after its source authorization is revoked', async () => {
    await mkdir(join(root, 'provider', 'sessions'), { recursive: true });
    await writeFile(join(root, 'provider', 'sessions', 'thread.jsonl'), '{}\n');
    const entity = await loadedEntity();
    const entry = await collectionEntryFor(entity);
    const { dataTransfer } = sessionReferenceTransfer([entry]);
    host.config.set('sessionNavigator.sources', []);

    await sessionBoard().dragAndDropController.handleDrop!(undefined, dataTransfer as unknown as vscode.DataTransfer, { isCancellationRequested: false } as vscode.CancellationToken);

    expect(host.execute).not.toHaveBeenCalled();
    expect(host.warning).toHaveBeenCalledWith(expect.stringContaining('stale or no longer authorized'));
  });

  it('does not drag a collection session whose source authorization was revoked', async () => {
    const entity = await loadedEntity();
    const entry = await collectionEntryFor(entity);
    host.config.set('sessionNavigator.sources', []);

    const { transfer } = sessionReferenceTransfer([entry]);

    expect(transfer.size).toBe(0);
    expect(host.execute).not.toHaveBeenCalled();
  });

  it('rejects an over-limit collection session transfer on Agent Sessions', async () => {
    const transfer = { get: () => ({ asString: async () => ' '.repeat(64 * 1024 + 1) }), forEach: () => {} };

    await sessionBoard().dragAndDropController.handleDrop!(undefined, transfer as unknown as vscode.DataTransfer, { isCancellationRequested: false } as vscode.CancellationToken);

    expect(host.execute).not.toHaveBeenCalled();
    expect(host.previewUri).not.toHaveBeenCalled();
    expect(host.warning).toHaveBeenCalledWith(expect.stringContaining('invalid or exceeds its limit'));
  });

  it('ignores collection session drops on unsupported Agent Sessions rows', async () => {
    const entity = await loadedEntity();
    const entry = await collectionEntryFor(entity);
    const { dataTransfer } = sessionReferenceTransfer([entry]);
    const target = { nodeKind: 'preview-group' } as unknown as SessionNavigatorTreeNode;

    await sessionBoard().dragAndDropController.handleDrop!(target, dataTransfer as unknown as vscode.DataTransfer, { isCancellationRequested: false } as vscode.CancellationToken);

    expect(host.execute).not.toHaveBeenCalled();
    expect(host.previewUri).not.toHaveBeenCalled();
  });

  it('stops a collection session drop cancelled while reading the transfer', async () => {
    await mkdir(join(root, 'provider', 'sessions'), { recursive: true });
    await writeFile(join(root, 'provider', 'sessions', 'thread.jsonl'), '{}\n');
    const entity = await loadedEntity();
    const entry = await collectionEntryFor(entity);
    const { transfer } = sessionReferenceTransfer([entry]);
    const cancellation = { isCancellationRequested: false };
    const original = transfer.get('application/vnd.jsonlview.session-ref');
    const dataTransfer = {
      get: (mime: string) => mime === 'application/vnd.jsonlview.session-ref' ? {
        asString: async () => { cancellation.isCancellationRequested = true; return await original!.asString(); },
      } : undefined,
      forEach: () => {},
    };

    await sessionBoard().dragAndDropController.handleDrop!(undefined, dataTransfer as unknown as vscode.DataTransfer, cancellation as vscode.CancellationToken);

    expect(host.execute).not.toHaveBeenCalled();
    expect(host.previewUri).not.toHaveBeenCalled();
  });

  it('contains a failed session reference transfer read without source intake', async () => {
    const transfer = { get: () => ({ asString: async () => { throw new Error('Transfer unavailable'); } }), forEach: () => {} };

    await sessionBoard().dragAndDropController.handleDrop!(undefined, transfer as unknown as vscode.DataTransfer, { isCancellationRequested: false } as vscode.CancellationToken);

    expect(host.execute).not.toHaveBeenCalled();
    expect(host.previewUri).not.toHaveBeenCalled();
    expect(host.warning).toHaveBeenCalledWith(expect.stringContaining('could not be read'));
  });

  it('keeps archive intent collection-local by default and hides the linked session only when opted in', async () => {
    const entity = await loadedEntity();
    const store = await CollectionsStore.open(join(root, 'collections', 'metadata.sqlite'));
    const collection = store.createCollection('Work', store.listCollections().metadataRevision);
    const reference = store.addEntry(collection.collectionId, {
      providerId: entity.entity.provider, sourceId: entity.entity.sourceId, nativeId: entity.entity.nativeId, referenceKind: 'session',
    }, store.listCollections().metadataRevision);
    store.applyMutation({
      requestId: '00000000-0000-4000-8000-000000000001',
      expectedRevision: store.listCollections().metadataRevision,
      action: 'setLocalArchive',
      payload: { entryId: reference.entryId, archivedAtMs: 1 },
    });
    store.close();

    await tree.refresh();
    const [source] = await tree.getChildren();
    expect((await tree.getChildren(source!)).filter((node) => node.nodeKind === 'entity')).toHaveLength(1);

    host.config.set('sessionNavigator.hideArchivedCollectionSessions', true);
    host.configuration?.({ affectsConfiguration: (key) => key === 'jsonlView.sessionNavigator' || key === 'jsonlView.sessionNavigator.hideArchivedCollectionSessions' });
    const [refreshedSource] = await tree.getChildren();
    expect(await tree.getChildren(refreshedSource!)).toEqual([]);
  });

  it.each(['absent', 'corrupt'] as const)('keeps sessions visible when archive metadata is %s even if the hide option is enabled', async (state) => {
    const metadataPath = join(root, 'collections', 'metadata.sqlite');
    if (state === 'corrupt') {
      await mkdir(join(root, 'collections'), { recursive: true });
      await writeFile(metadataPath, 'not a database');
    }
    host.config.set('sessionNavigator.hideArchivedCollectionSessions', true);
    await tree.refresh();
    const [source] = await tree.getChildren();
    expect((await tree.getChildren(source!)).filter((node) => node.nodeKind === 'entity')).toHaveLength(1);
    if (state === 'absent') await expect(stat(metadataPath)).rejects.toMatchObject({ code: 'ENOENT' });
    else expect(await readFile(metadataPath, 'utf8')).toBe('not a database');
  });

  it('restores a hidden session immediately when its collection archive marker is cleared', async () => {
    const entity = await loadedEntity();
    const store = await CollectionsStore.open(join(root, 'collections', 'metadata.sqlite'));
    const collection = store.createCollection('Work', store.listCollections().metadataRevision);
    const reference = store.addEntry(collection.collectionId, {
      providerId: entity.entity.provider, sourceId: entity.entity.sourceId, nativeId: entity.entity.nativeId, referenceKind: 'session',
    }, store.listCollections().metadataRevision);
    store.applyMutation({ requestId: '00000000-0000-4000-8000-000000000002', expectedRevision: store.listCollections().metadataRevision,
      action: 'setLocalArchive', payload: { entryId: reference.entryId, archivedAtMs: 1 } });
    store.close();
    host.config.set('sessionNavigator.hideArchivedCollectionSessions', true);
    await tree.refresh();
    const [source] = await tree.getChildren();
    expect(await tree.getChildren(source!)).toEqual([]);

    const [collectionNode] = await upperBoard().treeDataProvider.getChildren();
    const [entryNode] = await upperBoard().treeDataProvider.getChildren(collectionNode!);
    await host.commands.get('jsonlView.sessionNavigator.collections.restore')!(entryNode);

    const [refreshedSource] = await tree.getChildren();
    expect((await tree.getChildren(refreshedSource!)).filter((node) => node.nodeKind === 'entity')).toHaveLength(1);
  });

  it('shows an archived session again when its final Collection membership is removed', async () => {
    const entity = await loadedEntity();
    const store = await CollectionsStore.open(join(root, 'collections', 'metadata.sqlite'));
    const collection = store.createCollection('Work', store.listCollections().metadataRevision);
    const reference = store.addEntry(collection.collectionId, {
      providerId: entity.entity.provider, sourceId: entity.entity.sourceId, nativeId: entity.entity.nativeId, referenceKind: 'session',
    }, store.listCollections().metadataRevision);
    store.applyMutation({ requestId: '00000000-0000-4000-8000-000000000004', expectedRevision: store.listCollections().metadataRevision,
      action: 'setLocalArchive', payload: { entryId: reference.entryId, archivedAtMs: 1 } });
    store.close();
    host.config.set('sessionNavigator.hideArchivedCollectionSessions', true);
    await tree.refresh();
    const [source] = await tree.getChildren();
    expect(await tree.getChildren(source!)).toEqual([]);

    const [collectionNode] = await upperBoard().treeDataProvider.getChildren();
    const [entryNode] = await upperBoard().treeDataProvider.getChildren(collectionNode!);
    await host.commands.get('jsonlView.sessionNavigator.collections.unfile')!(entryNode);

    const [refreshedSource] = await tree.getChildren();
    expect((await tree.getChildren(refreshedSource!)).filter((node) => node.nodeKind === 'entity')).toHaveLength(1);
  });

  it('keeps a catalog continuation when every entity on the current page is hidden', async () => {
    const entity = await loadedEntity();
    const store = await CollectionsStore.open(join(root, 'collections', 'metadata.sqlite'));
    const collection = store.createCollection('Work', store.listCollections().metadataRevision);
    const reference = store.addEntry(collection.collectionId, {
      providerId: entity.entity.provider, sourceId: entity.entity.sourceId, nativeId: entity.entity.nativeId, referenceKind: 'session',
    }, store.listCollections().metadataRevision);
    store.applyMutation({ requestId: '00000000-0000-4000-8000-000000000003', expectedRevision: store.listCollections().metadataRevision,
      action: 'setLocalArchive', payload: { entryId: reference.entryId, archivedAtMs: 1 } });
    store.close();
    host.config.set('sessionNavigator.hideArchivedCollectionSessions', true);
    const [source] = await tree.getChildren();
    vi.spyOn(CatalogStore.prototype, 'getChildrenPage').mockReturnValue({
      entities: [entity.entity], generation: entity.entity.generation, nextCursor: 'next-page',
    });

    expect(await tree.getChildren(source!)).toMatchObject([{ nodeKind: 'catalog-page', cursor: 'next-page' }]);
  });

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

  it.each(['resolve', 'reject'] as const)('isolates a superseded opener that later %ss', async (settlement) => {
    tree.dispose();
    const registry = new RevealIntentRegistry();
    tree = createTree(registry);
    await mkdir(join(root, 'provider', 'sessions'), { recursive: true });
    await writeFile(join(root, 'provider', 'sessions', 'thread.jsonl'), '{}\n');
    const entity = await loadedEntity();
    let release!: () => void;
    let oldOpenStarted = false;
    host.execute.mockImplementationOnce(() => new Promise<void>((resolve, reject) => {
      oldOpenStarted = true;
      release = () => settlement === 'resolve' ? resolve() : reject(new Error('late open failure'));
    }));
    const first = tree.reveal(entity);
    await vi.waitFor(() => expect(oldOpenStarted).toBe(true));
    let current: ReturnType<RevealIntentRegistry['take']>;
    host.execute.mockImplementationOnce(async (_command, uri: { toString(): string }) => {
      current = registry.take(uri.toString());
    });
    const second = tree.reveal(entity);
    await vi.waitFor(() => expect(current).toBeDefined());
    release();
    await expect(first).resolves.toMatchObject({ outcome: 'superseded' });
    current!.complete({ outcome: 'shown', anchorOrdinal: '0', requestId: 'reveal-2', documentId: 'doc', generation: 'g' });
    await expect(second).resolves.toMatchObject({ outcome: 'shown' });
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
  it('does not reopen an older click whose provider probe finished last', async () => {
    await mkdir(join(root, 'provider', 'sessions'), { recursive: true });
    await writeFile(join(root, 'provider', 'sessions', 'thread.jsonl'), '{}\n');
    const entity = await loadedEntity();
    let finish!: (fingerprint: string) => void;
    host.probe.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
    const older = tree.reveal(entity);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await tree.reveal(entity);
    finish('stable'); await older;
    expect(host.execute).toHaveBeenCalledTimes(1);
  });
  it.each(['stale', 'not-found'] as const)('shows an actionable warning when the current target is %s', async (outcome) => {
    tree.dispose();
    const registry = new RevealIntentRegistry();
    tree = createTree(registry);
    await mkdir(join(root, 'provider', 'sessions'), { recursive: true });
    await writeFile(join(root, 'provider', 'sessions', 'thread.jsonl'), '{}\n');
    const entity = await loadedEntity();
    host.execute.mockImplementationOnce(async (_command, uri: { toString(): string }) => {
      registry.take(uri.toString())!.complete({ outcome, anchorOrdinal: '0', requestId: 'reveal-1', documentId: 'doc', generation: 'g' });
    });
    await expect(tree.reveal(entity)).resolves.toMatchObject({ outcome });
    expect(host.warning).toHaveBeenCalledWith(expect.stringContaining('retry'));
  });

  it('keeps an expired reveal failed when the Webview later acknowledges the exact target', async () => {
    tree.dispose();
    const registry = new RevealIntentRegistry();
    tree = createTree(registry);
    await mkdir(join(root, 'provider', 'sessions'), { recursive: true });
    await writeFile(join(root, 'provider', 'sessions', 'thread.jsonl'), '{}\n');
    const entity = await loadedEntity();
    const protocol = createRevealProtocolFixture();
    host.execute.mockImplementationOnce(async (_command, uri: { toString(): string }) => {
      const intent = registry.take(uri.toString())!;
      void protocol.deliver(intent);
    });
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const result = tree.reveal(entity);
      await vi.waitFor(() => expect(protocol.reveals).toHaveLength(1));
      expect(protocol.acknowledgements).toEqual([]);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(result).resolves.toMatchObject({ outcome: 'timeout', anchorOrdinal: '0' });
      expect(host.warning).toHaveBeenCalledWith(expect.stringContaining('retry'));
      await protocol.render();
      expect(protocol.acknowledgements).toHaveLength(1);
      expect(protocol.acknowledgements[0]).toMatchObject({
        requestId: protocol.reveals[0]!.requestId,
        documentId: 'synthetic-document', generation: 'synthetic-generation', epoch: 1,
        payload: { outcome: 'shown', anchorOrdinal: '0', renderedOrdinal: '0' },
      });
      expect(protocol.receipts).toMatchObject([{ outcome: 'timeout' }]);
      await expect(result).resolves.toMatchObject({ outcome: 'timeout' });
      expect(host.warning).toHaveBeenCalledTimes(1);
    } finally { protocol.dispose(); vi.useRealTimers(); }
  });

  it('rejects a real Webview visibility ACK after source authorization is revoked', async () => {
    tree.dispose();
    const registry = new RevealIntentRegistry();
    tree = createTree(registry);
    await mkdir(join(root, 'provider', 'sessions'), { recursive: true });
    await writeFile(join(root, 'provider', 'sessions', 'thread.jsonl'), '{}\n');
    const entity = await loadedEntity();
    const protocol = createRevealProtocolFixture();
    host.execute.mockImplementationOnce(async (_command, uri: { toString(): string }) => {
      void protocol.deliver(registry.take(uri.toString())!);
    });
    try {
      const result = tree.reveal(entity);
      await vi.waitFor(() => expect(protocol.reveals).toHaveLength(1));
      expect(protocol.acknowledgements).toEqual([]);
      host.config.set('sessionNavigator.sources', []);
      await protocol.render();
      await expect(result).resolves.toMatchObject({ outcome: 'unauthorized', anchorOrdinal: '0' });
      expect(protocol.receipts).toMatchObject([{ outcome: 'unauthorized' }]);
      expect(protocol.acknowledgements[0]).toMatchObject({
        type: 'REVEAL_ACK', requestId: protocol.reveals[0]!.requestId,
        documentId: 'synthetic-document', generation: 'synthetic-generation', epoch: 1,
        payload: { outcome: 'shown', anchorOrdinal: '0', renderedOrdinal: '0' },
      });
      expect(host.warning).toHaveBeenCalledWith(expect.stringContaining('no longer authorized'));
      await protocol.render();
      expect(protocol.acknowledgements).toHaveLength(1);
    } finally { protocol.dispose(); }
  });

  it('settles the same protocol handoff shown only after the Webview acknowledges visibility', async () => {
    tree.dispose();
    const registry = new RevealIntentRegistry();
    tree = createTree(registry);
    await mkdir(join(root, 'provider', 'sessions'), { recursive: true });
    await writeFile(join(root, 'provider', 'sessions', 'thread.jsonl'), '{}\n');
    const entity = await loadedEntity();
    const protocol = createRevealProtocolFixture();
    host.execute.mockImplementationOnce(async (_command, uri: { toString(): string }) => {
      void protocol.deliver(registry.take(uri.toString())!);
    });
    try {
      const result = tree.reveal(entity);
      await vi.waitFor(() => expect(protocol.reveals).toHaveLength(1));
      expect(protocol.acknowledgements).toEqual([]);
      expect(protocol.receipts).toEqual([]);
      await protocol.render();
      await expect(result).resolves.toMatchObject({ outcome: 'shown', anchorOrdinal: '0' });
      expect(protocol.receipts).toMatchObject([{ outcome: 'shown' }]);
      expect(protocol.acknowledgements).toHaveLength(1);
      expect(host.warning).not.toHaveBeenCalled();
    } finally { protocol.dispose(); }
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

  it('stops polling and aborts a probe when Sessions loses attention, then realigns on return', async () => {
    vi.useFakeTimers();
    try {
      host.visibility!({ visible: true });
      await tree.refresh();
      expect(host.view.description).toBeUndefined();

      let probeSignal!: AbortSignal;
      let resolveLateProbe!: (fingerprint: string) => void;
      host.probe.mockReset().mockImplementation((signal: AbortSignal) => {
        probeSignal = signal;
        return new Promise<string>((resolve) => { resolveLateProbe = resolve; });
      });
      host.scan.mockClear();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(host.probe).toHaveBeenCalledTimes(1);
      const lateProbe = probeVisibleSources();

      host.visibility!({ visible: false });
      expect(host.view.description).toBeUndefined();
      expect(probeSignal.aborted).toBe(true);
      resolveLateProbe('late-change');
      await lateProbe;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(host.scan).not.toHaveBeenCalled();
      expect(host.probe).toHaveBeenCalledTimes(1);

      host.probe.mockReset().mockResolvedValue('changed');
      host.scan.mockReset().mockResolvedValueOnce({
        ...snapshot, fingerprint: 'changed',
        snapshot: { ...snapshot.snapshot, entities: [{ ...snapshot.snapshot.entities[0]!, label: 'Updated after attention returns' }] },
      });
      host.visibility!({ visible: true });
      expect(host.view.description).toBeUndefined();
      await probeVisibleSources();
      expect(host.scan).toHaveBeenCalledTimes(1);
      const [source] = await tree.getChildren();
      expect(await tree.getChildren(source!)).toMatchObject([
        { nodeKind: 'entity', entity: { label: 'Updated after attention returns' } },
      ]);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(host.probe).toHaveBeenCalledTimes(2);
      expect(host.scan).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps one probe in flight and prevents a retired probe from clearing its replacement', async () => {
    vi.useFakeTimers();
    try {
      host.visibility!({ visible: true });
      await tree.refresh();
      const probes: Array<{ signal: AbortSignal; resolve: (value: string) => void }> = [];
      host.probe.mockReset().mockImplementation((signal: AbortSignal) => new Promise<string>((resolve) => { probes.push({ signal, resolve }); }));
      const first = probeVisibleSources();
      expect(probeVisibleSources()).toBe(first);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(probes).toHaveLength(1);

      host.visibility!({ visible: false });
      expect(probes[0]!.signal.aborted).toBe(true);
      host.visibility!({ visible: true });
      const second = probeVisibleSources();
      expect(second).not.toBe(first);
      await vi.advanceTimersByTimeAsync(0);
      expect(probes).toHaveLength(2);

      probes[0]!.resolve('late-change');
      await first;
      expect(probeVisibleSources()).toBe(second);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(probes).toHaveLength(2);
      expect(probes[1]!.signal.aborted).toBe(false);
      probes[1]!.resolve('stable');
      await second;
    } finally {
      vi.useRealTimers();
    }
  });

  it('binds polling to window focus while keeping Collections visibility independent', async () => {
    vi.useFakeTimers();
    try {
      for (const listener of host.sourceDropVisibilityListeners) listener(true);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(host.view.description).toBeUndefined();
      expect(host.probe).not.toHaveBeenCalled();
      expect(host.scan).not.toHaveBeenCalled();

      host.focus!({ focused: false });
      host.visibility!({ visible: true });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(host.view.description).toBeUndefined();
      expect(host.scan).not.toHaveBeenCalled();
      host.focus!({ focused: true });
      await tree.refresh();
      expect(host.view.description).toBeUndefined();

      let probeSignal!: AbortSignal;
      let settle!: (value: string) => void;
      host.probe.mockReset().mockImplementation((signal: AbortSignal) => {
        probeSignal = signal;
        return new Promise<string>((resolve) => { settle = resolve; });
      });
      const pending = probeVisibleSources();
      await vi.advanceTimersByTimeAsync(0);
      host.focus!({ focused: false });
      expect(probeSignal.aborted).toBe(true);
      expect(host.view.description).toBeUndefined();
      settle('late-change');
      await pending;
      host.probe.mockClear();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(host.probe).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['disable', 'dispose'] as const)('aborts the active polling probe without exposing automatic dormancy on %s', async (action) => {
    vi.useFakeTimers();
    try {
      host.visibility!({ visible: true });
      await tree.refresh();
      let probeSignal!: AbortSignal;
      let settle!: (value: string) => void;
      host.probe.mockReset().mockImplementation((signal: AbortSignal) => {
        probeSignal = signal;
        return new Promise<string>((resolve) => { settle = resolve; });
      });
      host.scan.mockClear();
      const pending = probeVisibleSources();
      await vi.advanceTimersByTimeAsync(0);
      if (action === 'dispose') tree.dispose();
      else await host.commands.get('jsonlView.sessionNavigator.disable')!();
      expect(probeSignal.aborted).toBe(true);
      expect(host.view.description).toBeUndefined();
      settle('late-change');
      await pending;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(host.probe).toHaveBeenCalledTimes(1);
      expect(host.scan).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops polling when the last authorized source is removed', async () => {
    vi.useFakeTimers();
    try {
      host.visibility!({ visible: true });
      await tree.refresh();
      const [source] = await tree.getChildren();
      host.probe.mockClear();
      await host.commands.get('jsonlView.sessionNavigator.removeSource')!(source);
      expect(host.view.description).toBeUndefined();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(host.probe).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
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
    expect((await tree.getChildren()).filter((node) => node.nodeKind === 'source')).toHaveLength(2);

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
    const [detected] = await tree.getChildren();
    expect(detected?.nodeKind).toBe('detected-group');
    const [empty] = await tree.getChildren(detected);
    expect(tree.getTreeItem(empty!)).toMatchObject({ label: 'No additional local agent sources detected' });
  });

  it('authorizes a detected provider without a folder picker and keeps removal across refresh', async () => {
    host.picker.mockResolvedValue({ value: 'codex' });
    await host.commands.get('jsonlView.sessionNavigator.authorizeAgent')!();
    expect(host.dialog).not.toHaveBeenCalled();
    const sources = await tree.getChildren();
    const authorizedSources = sources.filter((node) => node.nodeKind === 'source');
    expect(authorizedSources).toHaveLength(1);
    expect(await tree.getChildren(authorizedSources[0]!)).toHaveLength(1);
    await host.commands.get('jsonlView.sessionNavigator.removeSource')!(authorizedSources[0]);
    await tree.refresh();
    const [detected] = await tree.getChildren();
    expect(detected?.nodeKind).toBe('detected-group');
    const [empty] = await tree.getChildren(detected);
    expect(tree.getTreeItem(empty!)).toMatchObject({ label: 'No additional local agent sources detected' });
    expect(host.config.get('sessionNavigator.sources')).toEqual([]);
    await host.commands.get('jsonlView.sessionNavigator.authorizeAgent')!();
    expect((await tree.getChildren()).filter((node) => node.nodeKind === 'source')).toHaveLength(1);
  });

  it('launches native Import/Paste choices and cancellation has no intake or metadata effects', async () => {
    await host.commands.get('jsonlView.sessionNavigator.addSource')!();
    expect(host.nativePicker).toHaveBeenCalledOnce();
    expect(host.execute).not.toHaveBeenCalled();
    expect(host.intake).not.toHaveBeenCalled();
    expect(host.picker).not.toHaveBeenCalled();
    expect(host.dialog).not.toHaveBeenCalled();
    expect(host.updates).not.toHaveBeenCalled();
    expect(await upperBoard().treeDataProvider.getChildren()).toMatchObject([{ kind: 'notice' }]);
  });

  it('routes native Import to Files/Folder and Paste without filing references', async () => {
    mockNativeIntakePicker('import', 'files'); host.dialog.mockResolvedValue(undefined);
    await host.commands.get('jsonlView.sessionNavigator.addSource')!();
    expect(host.nativePicker).toHaveBeenCalledTimes(2);
    expect(host.dialog).toHaveBeenCalledWith(expect.objectContaining({ canSelectFiles: true, canSelectFolders: false }));
    mockNativeIntakePicker('paste');
    await host.commands.get('jsonlView.sessionNavigator.addSource')!();
    expect(host.intake).toHaveBeenCalledOnce();
    expect(host.updates).not.toHaveBeenCalled(); expect(host.scan).not.toHaveBeenCalled();
    expect(await upperBoard().treeDataProvider.getChildren()).toMatchObject([{ kind: 'notice' }]);
  });

  it('keeps Collections CRUD/membership/refresh separate from lower rows, sorting, authorization and scans', async () => {
    const entity = await loadedEntity();
    const lowerBefore = await tree.getChildren();
    const source = lowerBefore.find((node) => node.nodeKind === 'source')!;
    const childrenBefore = await tree.getChildren(source);
    const settingsBefore = JSON.stringify([...host.config]);
    host.scan.mockClear(); host.probe.mockClear(); host.updates.mockClear(); host.execute.mockClear();
    const upper = upperBoard().treeDataProvider;
    host.input.mockResolvedValueOnce('Work');
    await host.commands.get('jsonlView.sessionNavigator.collections.create')!();
    let [collection] = await upper.getChildren();
    expect(collection?.kind).toBe('collection');
    host.picker.mockImplementationOnce(async (items: Array<unknown>) => items[0]);
    await host.commands.get('jsonlView.sessionNavigator.collections.fileInto')!(entity);
    [collection] = await upper.getChildren();
    let [entry] = await upper.getChildren(collection);
    expect(upper.getTreeItem(entry!).command).toMatchObject({ command: 'jsonlView.sessionNavigator.collections.open' });
    host.input.mockResolvedValueOnce('Renamed');
    await host.commands.get('jsonlView.sessionNavigator.collections.rename')!(collection);
    [collection] = await upper.getChildren(); [entry] = await upper.getChildren(collection);
    await host.commands.get('jsonlView.sessionNavigator.collections.unfile')!(entry);
    await host.commands.get('jsonlView.sessionNavigator.collections.refresh')!();
    [collection] = await upper.getChildren();
    host.warning.mockResolvedValueOnce('Delete Collection');
    await host.commands.get('jsonlView.sessionNavigator.collections.delete')!(collection);
    expect(await tree.getChildren()).toEqual(lowerBefore);
    expect(await tree.getChildren(source)).toEqual(childrenBefore);
    expect(JSON.stringify([...host.config])).toBe(settingsBefore);
    expect(host.scan).not.toHaveBeenCalled(); expect(host.probe).not.toHaveBeenCalled(); expect(host.updates).not.toHaveBeenCalled();
    expect(host.execute).not.toHaveBeenCalled(); expect(host.previewUri).not.toHaveBeenCalled();
  });

  it('links an existing collection member into another collection and keeps duplicate/unavailable cases metadata-only', async () => {
    const entity = await loadedEntity(); const upper = upperBoard().treeDataProvider;
    host.scan.mockClear(); host.probe.mockClear(); host.updates.mockClear();
    host.input.mockResolvedValueOnce('Work'); await host.commands.get('jsonlView.sessionNavigator.collections.create')!();
    host.picker.mockImplementationOnce(async (items: Array<unknown>) => items[0]);
    await host.commands.get('jsonlView.sessionNavigator.collections.fileInto')!(entity);
    host.input.mockResolvedValueOnce('Review'); await host.commands.get('jsonlView.sessionNavigator.collections.create')!();
    host.input.mockResolvedValueOnce('Offline'); await host.commands.get('jsonlView.sessionNavigator.collections.create')!();

    let collections = (await upper.getChildren()).filter((node): node is CollectionsTreeNode & { kind: 'collection' } => node.kind === 'collection');
    const work = collections.find((node) => node.collection.displayName === 'Work');
    if (work === undefined) throw new Error('Expected Work collection');
    let [entry] = await upper.getChildren(work);
    if (entry?.kind !== 'entry') throw new Error('Expected Work collection entry');

    host.info.mockClear();
    host.picker.mockImplementationOnce(async (items: Array<{ label?: string }>) => items.find((item) => item.label === 'Work'));
    await host.commands.get('jsonlView.sessionNavigator.collections.fileInto')!(entry);
    expect(host.info).toHaveBeenCalledWith('This reference is already in that Collection.');

    host.picker.mockImplementationOnce(async (items: Array<{ label?: string }>) => items.find((item) => item.label === 'Review'));
    await host.commands.get('jsonlView.sessionNavigator.collections.fileInto')!(entry);
    collections = (await upper.getChildren()).filter((node): node is CollectionsTreeNode & { kind: 'collection' } => node.kind === 'collection');
    const review = collections.find((node) => node.collection.displayName === 'Review');
    if (review === undefined) throw new Error('Expected Review collection');
    expect(await upper.getChildren(review)).toMatchObject([{ kind: 'entry', entry: { nativeId: 'thread-1' } }]);

    host.config.set('sessionNavigator.sources', []);
    collections = (await upper.getChildren()).filter((node): node is CollectionsTreeNode & { kind: 'collection' } => node.kind === 'collection');
    const currentWork = collections.find((node) => node.collection.displayName === 'Work');
    if (currentWork === undefined) throw new Error('Expected current Work collection');
    [entry] = await upper.getChildren(currentWork);
    expect(upper.getTreeItem(entry!).label).toBe('Source unavailable');
    host.picker.mockImplementationOnce(async (items: Array<{ label?: string }>) => items.find((item) => item.label === 'Offline'));
    await host.commands.get('jsonlView.sessionNavigator.collections.fileInto')!(entry);
    collections = (await upper.getChildren()).filter((node): node is CollectionsTreeNode & { kind: 'collection' } => node.kind === 'collection');
    const offline = collections.find((node) => node.collection.displayName === 'Offline');
    if (offline === undefined) throw new Error('Expected Offline collection');
    expect(await upper.getChildren(offline)).toMatchObject([{ kind: 'entry', entry: { nativeId: 'thread-1' } }]);
    expect(host.scan).not.toHaveBeenCalled(); expect(host.probe).not.toHaveBeenCalled(); expect(host.updates).not.toHaveBeenCalled();
  });

  it('rebinds an upper reference through current native source/session selection without changing lower Sessions', async () => {
    host.scan.mockResolvedValue({ ...snapshot, snapshot: { ...snapshot.snapshot, entities: [...snapshot.snapshot.entities,
      { ...snapshot.snapshot.entities[0]!, nativeId: 'thread-2', label: 'Replacement session' }] } });
    const entity = await loadedEntity(); const lower = await tree.getChildren(); const upper = upperBoard().treeDataProvider;
    host.input.mockResolvedValueOnce('Work'); await host.commands.get('jsonlView.sessionNavigator.collections.create')!();
    host.picker.mockImplementationOnce(async (items: unknown[]) => items[0]);
    await host.commands.get('jsonlView.sessionNavigator.collections.fileInto')!(entity);
    let [collection] = await upper.getChildren(); let [entry] = await upper.getChildren(collection);
    host.picker.mockImplementationOnce(async (items: unknown[]) => items[0]);
    host.picker.mockImplementationOnce(async (items: Array<{ entity?: { nativeId: string } }>) => items.find((item) => item.entity?.nativeId === 'thread-2'));
    host.warning.mockResolvedValueOnce('Rebind Reference'); host.scan.mockClear(); host.probe.mockClear(); host.updates.mockClear();
    await host.commands.get('jsonlView.sessionNavigator.collections.rebind')!(entry);
    [collection] = await upper.getChildren(); [entry] = await upper.getChildren(collection);
    expect(entry).toMatchObject({ kind: 'entry', entry: { nativeId: 'thread-2' } });
    expect(await tree.getChildren()).toEqual(lower);
    expect(host.scan).not.toHaveBeenCalled(); expect(host.probe).not.toHaveBeenCalled(); expect(host.updates).not.toHaveBeenCalled();
    host.picker.mockImplementationOnce(async (items: unknown[]) => { host.config.set('sessionNavigator.sources', []); host.roots = []; return items[0]; });
    await host.commands.get('jsonlView.sessionNavigator.collections.rebind')!(entry);
    expect([...host.state.keys()].some((key) => key.startsWith(COLLECTIONS_PENDING_PREFIX))).toBe(false);
    expect(upper.getTreeItem(entry!).label).toBe('Source unavailable');
  });

  it('files only an explicitly registered exact-file identity and refuses opening it if the path becomes a directory', async () => {
    const registered = join(root, 'registered.jsonl'); await writeFile(registered, '{}\n');
    host.roots = [{ provider: 'generic', rootUri: pathToFileURL(registered).toString() }]; host.config.set('sessionNavigator.sources', host.roots);
    await tree.refresh(); const [source] = await tree.getChildren(); const upper = upperBoard().treeDataProvider;
    host.input.mockResolvedValueOnce('Files'); await host.commands.get('jsonlView.sessionNavigator.collections.create')!();
    host.picker.mockImplementationOnce(async (items: unknown[]) => items[0]);
    await host.commands.get('jsonlView.sessionNavigator.collections.fileInto')!(source);
    const [collection] = await upper.getChildren(); const [entry] = await upper.getChildren(collection);
    expect(entry).toMatchObject({ kind: 'entry', entry: { referenceKind: 'file', nativeId: '@file' } });
    host.execute.mockClear(); await host.commands.get('jsonlView.sessionNavigator.collections.open')!(entry);
    expect(host.execute).toHaveBeenCalledWith('vscode.openWith', expect.objectContaining({ fsPath: registered }), 'jsonlView.editor');
    await rm(registered); await mkdir(registered); host.execute.mockClear();
    await host.commands.get('jsonlView.sessionNavigator.collections.open')!(entry); expect(host.execute).not.toHaveBeenCalled();
  });

  it('refreshes only changed reference rows and keeps the collection context action valid', async () => {
    const collectionValue = { collectionId: '00000000-0000-0000-0000-000000000001', displayName: 'Work', entryCount: 0 };
    const entryValue = { entryId: '00000000-0000-0000-0000-000000000002', collectionId: collectionValue.collectionId, providerId: 'codex' as const, sourceId: 'fixture', nativeId: 'thread-1', referenceKind: 'session' as const };
    const mutation = vi.fn();
    let referenceLabel: string | undefined = 'Session';
    const store: CollectionsPort = {
      listCollections: () => ({ items: [collectionValue], metadataRevision: '7' }),
      listEntries: () => ({ items: [entryValue], metadataRevision: '7' }),
      listArchivedSessionReferences: () => [],
      createCollection: (...args) => { mutation('create', ...args); return collectionValue; }, renameCollection: () => collectionValue,
      deleteCollection: (...args) => { mutation(...args); return true; }, addEntry: () => ({} as never),
      removeEntry: () => true, validateMutation() {}, applyMutation: (command) => { mutation(command); return {} as never; }, close() {},
      listPendingMutations: () => [], acceptPendingMutation() {}, completePendingMutation() {}, importLegacyMutations() {},
    };
    const upper = new CollectionsTreeProvider(root, { referenceForNode: () => undefined, labelForReference: () => referenceLabel, openReference: async () => {} }, collectionsState(), async () => store);
    const registrations = upper.register();
    try {
      host.input.mockResolvedValueOnce('Work');
      await host.commands.get('jsonlView.sessionNavigator.collections.create')!();
      const [collection] = await upper.getChildren();
      expect(collection?.kind).toBe('collection');
      const [entry] = await upper.getChildren(collection);
      expect(entry?.kind).toBe('entry');
      upper.getTreeItem(entry!);
      const changed: unknown[] = [];
      const listener = upper.onDidChangeTreeData((value) => changed.push(value));
      referenceLabel = 'Renamed session';
      upper.refreshReferenceLabels();
      expect(changed).toEqual([[entry]]);
      expect(upper.getTreeItem(entry!).label).toBe('Renamed session');
      referenceLabel = 'Renamed session';
      upper.refreshReferenceLabels();
      expect(changed).toHaveLength(1);
      mutation.mockClear();
      host.warning.mockResolvedValueOnce('Delete Collection');

      await host.commands.get('jsonlView.sessionNavigator.collections.delete')!(collection);

      expect(host.warning).toHaveBeenCalledOnce();
      expect(mutation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        expectedRevision: '7', action: 'deleteCollection', payload: { collectionId: collectionValue.collectionId },
      }));
      expect(changed[changed.length - 1]).toBeUndefined();
      changed.length = 0;
      upper.getTreeItem(entry!);
      referenceLabel = 'After root refresh';
      upper.refreshReferenceLabels();
      expect(changed).toEqual([]);
      listener.dispose();
    } finally {
      for (const registration of registrations) registration.dispose();
      upper.dispose();
    }
  });

  it('keeps the upper board usable while Sessions is disabled and cancelled creation leaves no database', async () => {
    host.config.set('sessionNavigator.enabled', false);
    const catalogOpen = vi.spyOn(CatalogStore, 'open');
    const upper = upperBoard().treeDataProvider;
    await upper.getChildren(); host.input.mockResolvedValueOnce(undefined);
    await host.commands.get('jsonlView.sessionNavigator.collections.create')!();
    await expect(stat(join(root, 'collections', 'metadata.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' });
    host.input.mockResolvedValueOnce('Offline collection');
    await host.commands.get('jsonlView.sessionNavigator.collections.create')!();
    expect((await upper.getChildren())[0]).toMatchObject({ kind: 'collection', collection: { displayName: 'Offline collection' } });
    expect(catalogOpen).not.toHaveBeenCalled(); expect(host.scan).not.toHaveBeenCalled();
    expect(host.probe).not.toHaveBeenCalled(); expect(host.updates).not.toHaveBeenCalled();
    expect(host.config.get('sessionNavigator.enabled')).toBe(false);
  });

  it('recovers a committed UI command before accepting new intent after host recreation', async () => {
    const apply = CollectionsStore.prototype.applyMutation;
    const response = vi.spyOn(CollectionsStore.prototype, 'applyMutation').mockImplementationOnce(function (this: CollectionsStore, command) {
      apply.call(this, command); throw new Error('simulated lost result');
    });
    host.input.mockResolvedValueOnce('Once');
    await host.commands.get('jsonlView.sessionNavigator.collections.create')!();
    expect(pendingCollectionCommands()).toBe(1);
    response.mockRestore(); tree.dispose(); tree = createTree(); tree.register();
    const upper = upperBoard().treeDataProvider;
    expect(await upper.getChildren()).toMatchObject([{ kind: 'collection', collection: { displayName: 'Once' } }]);
    expect(pendingCollectionCommands()).toBe(0); expect(host.persist).not.toHaveBeenCalled();
    host.input.mockResolvedValueOnce('Once');
    await host.commands.get('jsonlView.sessionNavigator.collections.create')!();
    const collections = await upper.getChildren();
    expect(collections).toHaveLength(2);
    expect(host.scan).not.toHaveBeenCalled(); expect(host.probe).not.toHaveBeenCalled(); expect(host.updates).not.toHaveBeenCalled();
  });

  it('does not mutate collection metadata if the accepted command cannot be persisted', async () => {
    const apply = vi.spyOn(CollectionsStore.prototype, 'applyMutation');
    vi.spyOn(CollectionsStore.prototype, 'acceptPendingMutation').mockImplementationOnce(() => { throw new Error('persistence unavailable'); });
    host.input.mockResolvedValueOnce('Unsaved');
    await host.commands.get('jsonlView.sessionNavigator.collections.create')!();
    expect(apply).not.toHaveBeenCalled();
    expect(await upperBoard().treeDataProvider.getChildren()).toMatchObject([{ kind: 'notice', message: 'No collections. Use New Collection.' }]);
  });

  it.each(['before', 'after'] as const)('does not report a successful collection command as retryable when cleanup fails %s COMMIT', async (stage) => {
    const complete = CollectionsStore.prototype.completePendingMutation;
    const cleanup = vi.spyOn(CollectionsStore.prototype, 'completePendingMutation').mockImplementationOnce(function (this: CollectionsStore, command) {
      if (stage === 'before') throw new Error('cleanup unavailable');
      const original = DatabaseSync.prototype.exec;
      const exec = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
        original.call(this, sql);
        if (sql === 'COMMIT') throw new Error('lost cleanup COMMIT response');
      });
      try { complete.call(this, command); } finally { exec.mockRestore(); }
    });
    host.input.mockResolvedValueOnce('Once');
    await host.commands.get('jsonlView.sessionNavigator.collections.create')!();
    expect(host.warning).not.toHaveBeenCalled();
    expect(pendingCollectionCommands()).toBe(stage === 'before' ? 1 : 0);
    const upper = upperBoard().treeDataProvider; const nodes = await upper.getChildren();
    expect(nodes.filter((node) => node.kind === 'collection')).toMatchObject([{ collection: { displayName: 'Once' } }]);
    expect(nodes.filter((node) => node.kind === 'notice')).toHaveLength(stage === 'before' ? 1 : 0);
    if (stage === 'before') expect(nodes[0]).toMatchObject({ message: expect.stringContaining('METADATA_UNAVAILABLE') });
    cleanup.mockRestore();
    await host.commands.get('jsonlView.sessionNavigator.collections.refresh')!();
    expect(await upper.getChildren()).toMatchObject([{ kind: 'collection', collection: { displayName: 'Once' } }]);
    expect(pendingCollectionCommands()).toBe(0); expect(host.warning).not.toHaveBeenCalled();
  });

  it('retains pending commands and refuses to recreate a missing metadata database', async () => {
    host.state.set(COLLECTIONS_PENDING_PREFIX + 'retained', { version: 1, command: {} });
    expect(await upperBoard().treeDataProvider.getChildren()).toMatchObject([{ kind: 'notice', message: 'Collections unavailable. Refresh to retry; metadata is retained.' }]);
    host.input.mockResolvedValueOnce('Must not recreate');
    await host.commands.get('jsonlView.sessionNavigator.collections.create')!();
    expect(host.input).not.toHaveBeenCalled();
    await expect(stat(join(root, 'collections', 'metadata.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(host.state.has(COLLECTIONS_PENDING_PREFIX + 'retained')).toBe(true);
  });

  it('keeps metadata readable when a pending command conflicts after restart and pauses new changes', async () => {
    host.input.mockResolvedValueOnce('Retained');
    await host.commands.get('jsonlView.sessionNavigator.collections.create')!();
    const interrupted = vi.spyOn(CollectionsStore.prototype, 'applyMutation').mockImplementationOnce(() => { throw new CollectionsError('STORE_BUSY'); });
    host.input.mockResolvedValueOnce('Pending');
    await host.commands.get('jsonlView.sessionNavigator.collections.create')!();
    interrupted.mockRestore(); tree.dispose();
    const independent = await CollectionsStore.open(join(root, 'collections', 'metadata.sqlite'));
    try { independent.createCollection('Independent', '1'); } finally { independent.close(); }
    tree = createTree(); tree.register();
    const upper = upperBoard().treeDataProvider; const nodes = await upper.getChildren();
    expect(nodes[0]).toMatchObject({ kind: 'notice', message: expect.stringContaining('REVISION_CONFLICT') });
    expect(nodes.filter((node) => node.kind === 'collection')).toHaveLength(2);
    expect(pendingCollectionCommands()).toBe(1);
    host.input.mockClear(); host.input.mockResolvedValueOnce('Must wait');
    await host.commands.get('jsonlView.sessionNavigator.collections.create')!();
    expect(host.input).not.toHaveBeenCalled();
    await host.commands.get('jsonlView.sessionNavigator.collections.refresh')!();
    expect((await upper.getChildren()).filter((node) => node.kind === 'collection')).toHaveLength(2);
    expect(pendingCollectionCommands()).toBe(1); expect(host.persist).not.toHaveBeenCalled();
  });

  it('does not write after disposal during pending persistence and replays the accepted intent on recreation', async () => {
    let release!: () => void;
    const accept = CollectionsStore.prototype.acceptPendingMutation;
    vi.spyOn(CollectionsStore.prototype, 'acceptPendingMutation').mockImplementationOnce(async function (this: CollectionsStore, command) {
      accept.call(this, command); await new Promise<void>((resolve) => { release = resolve; });
    });
    host.input.mockResolvedValueOnce('Accepted before disposal');
    const command = host.commands.get('jsonlView.sessionNavigator.collections.create')!();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    tree.dispose(); release(); await command;
    const disk = new DatabaseSync(join(root, 'collections', 'metadata.sqlite'), { readOnly: true });
    try { expect(disk.prepare('SELECT count(*) AS n FROM user_collection').get()?.n).toBe(0); } finally { disk.close(); }
    expect(pendingCollectionCommands()).toBe(1);
    tree = createTree(); tree.register();
    expect(await upperBoard().treeDataProvider.getChildren()).toMatchObject([{ kind: 'collection', collection: { displayName: 'Accepted before disposal' } }]);
    expect(pendingCollectionCommands()).toBe(0); expect(host.persist).not.toHaveBeenCalled();
  });

  it.each(['create', 'rename', 'delete', 'unfile'] as const)('discards %s when refresh invalidates its last store await', async (action) => {
    const collectionValue = { collectionId: '00000000-0000-0000-0000-000000000001', displayName: 'Work', entryCount: 1 };
    const entryValue = { entryId: '00000000-0000-0000-0000-000000000002', collectionId: collectionValue.collectionId, providerId: 'codex' as const, sourceId: 'fixture', nativeId: 'thread-1', referenceKind: 'session' as const };
    const mutation = vi.fn();
    const store: CollectionsPort = {
      listCollections: () => ({ items: [collectionValue], metadataRevision: '1' }),
      listEntries: () => ({ items: [entryValue], metadataRevision: '1' }),
      listArchivedSessionReferences: () => [],
      createCollection: () => { mutation(); return collectionValue; }, renameCollection: () => { mutation(); return collectionValue; },
      deleteCollection: () => { mutation(); return true; }, addEntry: () => { mutation(); return entryValue; },
      removeEntry: () => { mutation(); return true; }, validateMutation() {}, applyMutation: (command) => { mutation(command); return {} as never; }, close() {},
      listPendingMutations: () => [], acceptPendingMutation() {}, completePendingMutation() {}, importLegacyMutations() {},
    };
    const upper = new CollectionsTreeProvider(root, { referenceForNode: () => undefined, labelForReference: () => 'Session', openReference: async () => {} }, collectionsState(), async () => store);
    const registrations = upper.register();
    host.input.mockResolvedValueOnce('Work'); await host.commands.get('jsonlView.sessionNavigator.collections.create')!();
    const [collection] = await upper.getChildren(); const [entry] = await upper.getChildren(collection);
    mutation.mockClear();
    const invalidateAfterPrompt = (answer: string) => {
      queueMicrotask(() => queueMicrotask(() => upper.refresh()));
      return Promise.resolve(answer);
    };
    if (action === 'create' || action === 'rename') host.input.mockImplementationOnce(() => invalidateAfterPrompt('Changed'));
    if (action === 'delete') host.warning.mockImplementationOnce(() => invalidateAfterPrompt('Delete Collection'));
    const pending = host.commands.get('jsonlView.sessionNavigator.collections.' + action)!(action === 'unfile' ? entry : collection);
    if (action === 'unfile') upper.refresh();
    try { await pending; expect(mutation).not.toHaveBeenCalled(); }
    finally { for (const registration of registrations) registration.dispose(); upper.dispose(); }
  });

  it('discards a late collection prompt after disposal without creating metadata or authorizing sources', async () => {
    let answer!: (name: string) => void;
    host.input.mockImplementationOnce(() => new Promise<string>((resolve) => { answer = resolve; }));
    const pending = host.commands.get('jsonlView.sessionNavigator.collections.create')!();
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
    tree.dispose(); answer('Too late'); await pending;
    await expect(stat(join(root, 'collections', 'metadata.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(host.scan).not.toHaveBeenCalled(); expect(host.updates).not.toHaveBeenCalled();
  });

  it('opens a collection session directly in JsonlView and rejects revocation during its probe', async () => {
    await mkdir(join(root, 'provider', 'sessions'), { recursive: true });
    await writeFile(join(root, 'provider', 'sessions', 'thread.jsonl'), '{}\n');
    const entity = await loadedEntity(); const upper = upperBoard().treeDataProvider;
    host.input.mockResolvedValueOnce('Work'); await host.commands.get('jsonlView.sessionNavigator.collections.create')!();
    host.picker.mockImplementationOnce(async (items: Array<unknown>) => items[0]);
    await host.commands.get('jsonlView.sessionNavigator.collections.fileInto')!(entity);
    const [collection] = await upper.getChildren(); const [entry] = await upper.getChildren(collection);
    await host.commands.get('jsonlView.sessionNavigator.collections.open')!(entry);
    expect(host.execute).toHaveBeenCalledExactlyOnceWith('vscode.openWith', expect.objectContaining({ fsPath: join(root, 'provider', 'sessions', 'thread.jsonl') }), 'jsonlView.editor');
    let complete!: (value: string) => void;
    host.probe.mockImplementationOnce(() => new Promise<string>((resolve) => { complete = resolve; }));
    host.execute.mockClear();
    const pending = host.commands.get('jsonlView.sessionNavigator.collections.open')!(entry);
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
    host.config.set('sessionNavigator.sources', []); complete('stable'); await pending;
    expect(host.execute).not.toHaveBeenCalled();
  });

  it('offers saved previews as exact-file references only after explicit confirmation and without scanning a disabled Navigator', async () => {
    host.config.set('sessionNavigator.enabled', false);
    const upper = upperBoard().treeDataProvider;
    host.input.mockResolvedValueOnce('Saved work');
    await host.commands.get('jsonlView.sessionNavigator.collections.create')!();
    const savedPath = join(root, 'saved-preview.jsonl');
    const savedUri = {
      scheme: 'file', authority: '', query: '', fragment: '', fsPath: savedPath,
      toString: () => pathToFileURL(savedPath).toString(),
    } as vscode.Uri;
    host.dialog.mockResolvedValueOnce(savedUri);
    host.info.mockResolvedValueOnce('Add to Collection');
    host.picker.mockImplementationOnce(async (items: Array<{ label?: string }>) => items.find((item) => item.label === 'Saved work'));
    host.warning.mockResolvedValueOnce('Register and Add');
    const preview = await tree.previews.create('{"saved":true}\n', 1, new AbortController().signal);
    await tree.previews.saveAs(preview!.sourceUri);
    await vi.waitFor(() => expect(host.info).toHaveBeenCalledWith(expect.stringContaining('Add it as a source or file it into a Collection?'), 'Add as source', 'Add to Collection', 'Dismiss'));
    await vi.waitFor(() => expect(host.warning).toHaveBeenCalledWith(
      expect.stringContaining('Register "saved-preview.jsonl" as a read-only source'),
      { modal: true }, 'Register and Add',
    ));
    await vi.waitFor(() => expect(host.info).toHaveBeenCalledWith('Saved file added to Collection.'));
    await vi.waitFor(async () => {
      const [collection] = await upper.getChildren();
      expect(await upper.getChildren(collection)).toMatchObject([{ kind: 'entry', entry: { nativeId: '@file', referenceKind: 'file', providerId: 'generic' } }]);
    });

    expect(host.warning).toHaveBeenCalledWith(
      expect.stringContaining('Register "saved-preview.jsonl" as a read-only source'),
      { modal: true }, 'Register and Add',
    );
    expect(host.config.get('sessionNavigator.enabled')).toBe(false);
    expect(host.config.get('sessionNavigator.sources')).toContainEqual(expect.objectContaining({ provider: 'generic', rootUri: pathToFileURL(savedPath).toString() }));
    expect(host.scan).not.toHaveBeenCalled(); expect(host.probe).not.toHaveBeenCalled();
    expect(await readFile(savedPath, 'utf8')).toBe('{"saved":true}\n');
    expect(pendingCollectionCommands()).toBe(0);
  });

  it('registers a saved preview into Collections without scanning when Navigator is enabled', async () => {
    host.roots = []; host.config.set('sessionNavigator.sources', []);
    host.visibility?.({ visible: true });
    host.input.mockResolvedValueOnce('Saved work'); await host.commands.get('jsonlView.sessionNavigator.collections.create')!();
    const savedPath = join(root, 'enabled-saved-preview.jsonl');
    const savedUri = {
      scheme: 'file', authority: '', query: '', fragment: '', fsPath: savedPath,
      toString: () => pathToFileURL(savedPath).toString(),
    } as vscode.Uri;
    host.dialog.mockResolvedValueOnce(savedUri);
    host.info.mockResolvedValueOnce('Add to Collection');
    host.picker.mockImplementationOnce(async (items: Array<{ label?: string }>) => items.find((item) => item.label === 'Saved work'));
    host.warning.mockResolvedValueOnce('Register and Add');
    host.scan.mockClear(); host.probe.mockClear();
    const preview = await tree.previews.create('{"enabled":true}\n', 1, new AbortController().signal);
    await tree.previews.saveAs(preview!.sourceUri);
    await vi.waitFor(() => expect(host.info).toHaveBeenCalledWith('Saved file added to Collection.'));
    await tree.getChildren();
    // The VS Code settings event may also arrive after update() resolves.
    host.configuration?.({ affectsConfiguration: (key) => key === 'jsonlView.sessionNavigator' || key === 'jsonlView.sessionNavigator.sources' });
    await tree.getChildren();
    host.focus?.({ focused: false }); host.focus?.({ focused: true });
    await probeVisibleSources();
    expect(host.config.get('sessionNavigator.enabled')).toBe(true);
    expect(host.scan).not.toHaveBeenCalled(); expect(host.probe).not.toHaveBeenCalled();
    expect(host.config.get('sessionNavigator.sources')).toContainEqual(expect.objectContaining({ provider: 'generic', rootUri: pathToFileURL(savedPath).toString() }));
    expect(await readFile(savedPath, 'utf8')).toBe('{"enabled":true}\n');
    await tree.refresh();
    expect(host.scan).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal), expect.anything(), 'generic');
  });

  it.each(['complete', 'hide', 'blur', 'disable', 'dispose'] as const)('settles Refresh requested during a scan after saved-file onboarding (%s)', async (settlement) => {
    host.input.mockResolvedValueOnce('Saved work'); await host.commands.get('jsonlView.sessionNavigator.collections.create')!();
    host.view.visible = true;
    let finishInitialScan!: (result: SessionNavigatorScanResult) => void;
    let initialSignal!: AbortSignal;
    host.scan.mockImplementationOnce((signal: AbortSignal) => {
      initialSignal = signal;
      return new Promise<SessionNavigatorScanResult>((resolve) => { finishInitialScan = resolve; });
    });
    const firstRefresh = tree.refresh();
    await vi.waitFor(() => expect(finishInitialScan).toBeTypeOf('function'));
    const savedPath = join(root, 'queued-refresh-preview.jsonl');
    host.dialog.mockResolvedValueOnce({ scheme: 'file', authority: '', query: '', fragment: '', fsPath: savedPath, toString: () => pathToFileURL(savedPath).toString() } as vscode.Uri);
    host.info.mockResolvedValueOnce('Add to Collection');
    host.picker.mockImplementationOnce(async (items: Array<{ label?: string }>) => items.find((item) => item.label === 'Saved work'));
    host.warning.mockResolvedValueOnce('Register and Add');
    const preview = await tree.previews.create('{"queued":true}\n', 1, new AbortController().signal);
    await tree.previews.saveAs(preview!.sourceUri);
    await vi.waitFor(() => expect(host.info).toHaveBeenCalledWith('Saved file added to Collection.'));
    expect(host.scan.mock.calls.map((call) => call[2])).toEqual(['codex']);
    let explicitSettled = false;
    const explicitRefresh = tree.refresh().then(() => { explicitSettled = true; });
    const repeatedRefresh = tree.refresh();
    await Promise.resolve(); expect(explicitSettled).toBe(false);

    if (settlement === 'hide') host.visibility?.({ visible: false });
    if (settlement === 'blur') host.focus?.({ focused: false });
    if (settlement === 'disable') await host.commands.get('jsonlView.sessionNavigator.disable')!();
    if (settlement === 'dispose') tree.dispose();
    expect(initialSignal.aborted).toBe(settlement !== 'complete');
    finishInitialScan(snapshot);
    await Promise.all([firstRefresh, explicitRefresh, repeatedRefresh]);

    expect(host.scan.mock.calls.map((call) => call[2])).toEqual(settlement === 'complete' ? ['codex', 'generic'] : ['codex']);
    expect(await readFile(savedPath, 'utf8')).toBe('{"queued":true}\n');
  });

  it('creates a Collection for a saved preview when the user chooses the new-collection action', async () => {
    host.config.set('sessionNavigator.enabled', false);
    const upper = upperBoard().treeDataProvider;
    const savedPath = join(root, 'new-collection-preview.jsonl');
    const savedUri = {
      scheme: 'file', authority: '', query: '', fragment: '', fsPath: savedPath,
      toString: () => pathToFileURL(savedPath).toString(),
    } as vscode.Uri;
    host.dialog.mockResolvedValueOnce(savedUri);
    host.info.mockResolvedValueOnce('Add to Collection');
    host.picker.mockImplementationOnce(async (items: Array<{ create?: boolean }>) => items.find((item) => item.create === true));
    host.input.mockResolvedValueOnce('Saved preview');
    host.warning.mockResolvedValueOnce('Register and Add');
    const preview = await tree.previews.create('{"newCollection":true}\n', 1, new AbortController().signal);

    await tree.previews.saveAs(preview!.sourceUri);

    await vi.waitFor(() => expect(host.info).toHaveBeenCalledWith('Saved file added to Collection.'));
    const [collection] = await upper.getChildren();
    expect(collection).toMatchObject({ kind: 'collection', collection: { displayName: 'Saved preview', entryCount: 1 } });
    expect(await upper.getChildren(collection!)).toMatchObject([{ kind: 'entry', entry: { nativeId: '@file', referenceKind: 'file', providerId: 'generic' } }]);
    expect(await readFile(savedPath, 'utf8')).toBe('{"newCollection":true}\n');
    expect(host.scan).not.toHaveBeenCalled();
  });

  it.each([false, true])('reuses existing saved-file permission and rejects revocation before filing (%s)', async (revoke) => {
    host.config.set('sessionNavigator.enabled', false);
    const upper = upperBoard().treeDataProvider;
    host.input.mockResolvedValueOnce('Saved work'); await host.commands.get('jsonlView.sessionNavigator.collections.create')!();
    const savedPath = join(root, 'already-authorized.jsonl');
    const setting = { provider: 'generic', rootUri: pathToFileURL(savedPath).toString() };
    host.config.set('sessionNavigator.sources', [...host.roots, setting]);
    if (revoke) {
      const add = upper.addSavedFileReference.bind(upper);
      vi.spyOn(upper, 'addSavedFileReference').mockImplementationOnce(async (...args) => {
        host.config.set('sessionNavigator.sources', host.roots);
        await add(...args);
      });
    }
    host.dialog.mockResolvedValueOnce({ scheme: 'file', authority: '', query: '', fragment: '', fsPath: savedPath, toString: () => pathToFileURL(savedPath).toString() } as vscode.Uri);
    host.info.mockResolvedValueOnce('Add to Collection');
    host.picker.mockImplementationOnce(async (items: Array<{ label?: string }>) => items.find((item) => item.label === 'Saved work'));
    host.warning.mockResolvedValueOnce('Register and Add');
    const preview = await tree.previews.create('{}\n', 1, new AbortController().signal);
    await tree.previews.saveAs(preview!.sourceUri);
    await vi.waitFor(() => expect(revoke ? host.warning : host.info).toHaveBeenCalledWith(revoke
      ? expect.stringContaining('source settings and Collection entries before retrying')
      : 'Saved file added to Collection.'));
    const [collection] = await upper.getChildren();
    expect(collection).toMatchObject({ collection: { entryCount: revoke ? 0 : 1 } });
    expect(host.updates).not.toHaveBeenCalled();
    expect(host.scan).not.toHaveBeenCalled(); expect(host.probe).not.toHaveBeenCalled();
    expect(await readFile(savedPath, 'utf8')).toBe('{}\n');
  });

  it('logs a failed saved-preview filing through the injected host logger without changing the saved copy', async () => {
    host.config.set('sessionNavigator.enabled', false);
    const upper = upperBoard().treeDataProvider;
    host.input.mockResolvedValueOnce('Saved work');
    await host.commands.get('jsonlView.sessionNavigator.collections.create')!();
    const failure = Object.assign(new Error('private file path C:/private/preview.jsonl'), { code: 'EACCES' });
    vi.spyOn(upper, 'addSavedFileReference').mockRejectedValueOnce(failure);
    const savedPath = join(root, 'failed-filing-preview.jsonl');
    const savedUri = {
      scheme: 'file', authority: '', query: '', fragment: '', fsPath: savedPath,
      toString: () => pathToFileURL(savedPath).toString(),
    } as vscode.Uri;
    host.dialog.mockResolvedValueOnce(savedUri);
    host.info.mockResolvedValueOnce('Add to Collection');
    host.picker.mockImplementationOnce(async (items: Array<{ label?: string }>) => items.find((item) => item.label === 'Saved work'));
    host.warning.mockResolvedValueOnce('Register and Add');
    const preview = await tree.previews.create('{"remainsSaved":true}\n', 1, new AbortController().signal);

    await tree.previews.saveAs(preview!.sourceUri);

    await vi.waitFor(() => expect(host.previewCollectionFailure).toHaveBeenCalledWith(failure));
    await vi.waitFor(() => expect(host.warning).toHaveBeenCalledWith('The saved copy remains available and its source permission remains registered. A Collection change may be pending. Check the current entries before retrying; this action did not start a source scan.'));
    expect(host.config.get('sessionNavigator.sources')).toContainEqual({ provider: 'generic', rootUri: pathToFileURL(savedPath).toString() });
    expect(await readFile(savedPath, 'utf8')).toBe('{"remainsSaved":true}\n');
    expect(host.scan).not.toHaveBeenCalled();
  });

  it('retains the saved copy without filing a reference when source settings cannot be written', async () => {
    host.config.set('sessionNavigator.enabled', false);
    const upper = upperBoard().treeDataProvider;
    host.input.mockResolvedValueOnce('Saved work'); await host.commands.get('jsonlView.sessionNavigator.collections.create')!();
    const savedPath = join(root, 'source-write-failed.jsonl');
    const savedUri = { scheme: 'file', authority: '', query: '', fragment: '', fsPath: savedPath, toString: () => pathToFileURL(savedPath).toString() } as vscode.Uri;
    host.dialog.mockResolvedValueOnce(savedUri); host.info.mockResolvedValueOnce('Add to Collection');
    host.picker.mockImplementationOnce(async (items: Array<{ label?: string }>) => items.find((item) => item.label === 'Saved work'));
    host.warning.mockResolvedValueOnce('Register and Add');
    host.updates.mockImplementationOnce(() => { throw new Error('synthetic configuration write failure'); });
    const preview = await tree.previews.create('{"retained":true}\n', 1, new AbortController().signal);
    expect(await tree.previews.saveAs(preview!.sourceUri)).toBe('saved');
    await vi.waitFor(() => expect(host.warning).toHaveBeenCalledWith('The saved copy remains available. Source registration was not confirmed; check source settings and Collection entries before retrying. This action did not start a source scan.'));
    expect(host.config.get('sessionNavigator.sources')).toEqual(host.roots);
    const [collection] = await upper.getChildren();
    expect(collection).toMatchObject({ collection: { entryCount: 0 } });
    expect(pendingCollectionCommands()).toBe(0);
    expect(await readFile(savedPath, 'utf8')).toBe('{"retained":true}\n');
    expect(host.scan).not.toHaveBeenCalled(); expect(host.probe).not.toHaveBeenCalled();
  });

  it('offers one post-save action prompt after a failed open, including the tree Save As command', async () => {
    const savedPath = join(root, 'open-failed-preview.jsonl');
    host.dialog.mockResolvedValueOnce({ scheme: 'file', authority: '', query: '', fragment: '', fsPath: savedPath, toString: () => pathToFileURL(savedPath).toString() } as vscode.Uri);
    host.execute.mockRejectedValueOnce(new Error('synthetic open failure'));
    const preview = await tree.previews.create('{}\n', 1, new AbortController().signal);
    expect(await host.commands.get('jsonlView.previews.saveAs')!({ previewId: preview!.id })).toBe('saved-open-failed');
    expect(host.info).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('VS Code could not open the copy. Add it as a source or file it into a Collection?'), 'Add as source', 'Add to Collection', 'Dismiss');
    expect(await readFile(savedPath, 'utf8')).toBe('{}\n');
    expect(host.warning).not.toHaveBeenCalled(); expect(host.updates).not.toHaveBeenCalled();
  });

  it('keeps a saved copy and creates no source permission or Collection when the post-save prompt is dismissed', async () => {
    host.config.set('sessionNavigator.enabled', false);
    const savedPath = join(root, 'dismissed-preview.ndjson');
    const savedUri = {
      scheme: 'file', authority: '', query: '', fragment: '', fsPath: savedPath,
      toString: () => pathToFileURL(savedPath).toString(),
    } as vscode.Uri;
    host.dialog.mockResolvedValueOnce(savedUri);
    host.info.mockResolvedValueOnce(undefined);
    const preview = await tree.previews.create('{"kept":true}\n', 1, new AbortController().signal);
    await tree.previews.saveAs(preview!.sourceUri);
    await vi.waitFor(() => expect(host.info).toHaveBeenCalledWith(expect.stringContaining('Add it as a source or file it into a Collection?'), 'Add as source', 'Add to Collection', 'Dismiss'));

    expect(await readFile(savedPath, 'utf8')).toBe('{"kept":true}\n');
    expect(host.config.get('sessionNavigator.sources')).toEqual(host.roots);
    expect(host.warning).not.toHaveBeenCalled(); expect(host.picker).not.toHaveBeenCalled();
    expect(host.scan).not.toHaveBeenCalled();
    await expect(stat(join(root, 'collections', 'metadata.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('redacts revoked reference labels, rejects late filing and preserves removable metadata', async () => {
    const entity = await loadedEntity(); const upper = upperBoard().treeDataProvider;
    host.input.mockResolvedValueOnce('Work'); await host.commands.get('jsonlView.sessionNavigator.collections.create')!();
    host.picker.mockImplementationOnce(async (items: Array<unknown>) => items[0]);
    await host.commands.get('jsonlView.sessionNavigator.collections.fileInto')!(entity);
    const [collection] = await upper.getChildren(); const [entry] = await upper.getChildren(collection);
    let select!: (value: unknown) => void;
    host.picker.mockImplementationOnce(() => new Promise((resolve) => { select = resolve; }));
    const pending = host.commands.get('jsonlView.sessionNavigator.collections.fileInto')!(entity);
    await vi.waitFor(() => expect(select).toBeDefined());
    host.config.set('sessionNavigator.sources', []);
    select({ collectionId: collection?.kind === 'collection' ? collection.collection.collectionId : '', label: 'Work' });
    await pending;
    expect(upper.getTreeItem(entry!).label).toBe('Source unavailable');
    expect(upper.getTreeItem(entry!).command).toBeUndefined();
    host.execute.mockClear(); await host.commands.get('jsonlView.sessionNavigator.collections.open')!(entry);
    expect(host.execute).not.toHaveBeenCalled();
    await host.commands.get('jsonlView.sessionNavigator.collections.unfile')!(entry);
    const [current] = await upper.getChildren();
    expect(current?.kind === 'collection' && current.collection.entryCount).toBe(0);
  });

  it('keeps Collections outside the source-intake drop surface', async () => {
    host.input.mockResolvedValueOnce('Work'); await host.commands.get('jsonlView.sessionNavigator.collections.create')!();
    const upper = upperBoard(); const [collection] = await upper.treeDataProvider.getChildren();
    expect(upper.dragAndDropController).toBeDefined();
    expect(upper.dragAndDropController?.dropMimeTypes).toContain('application/vnd.jsonlview.session-ref');
    expect(upper.dragAndDropController?.dropMimeTypes).not.toContain('files');
    expect(upper.dragAndDropController?.dropMimeTypes).not.toContain('text/uri-list');
    expect(collection?.kind === 'collection' && collection.collection.entryCount).toBe(0);
    expect(host.previewUri).not.toHaveBeenCalled();
    expect(host.scan).not.toHaveBeenCalled(); expect(host.updates).not.toHaveBeenCalled();
  });

  it('does not forward file or URI drops over Collections into source intake', async () => {
    host.input.mockResolvedValueOnce('Work'); await host.commands.get('jsonlView.sessionNavigator.collections.create')!();
    const collection = (await upperBoard().treeDataProvider.getChildren())[0];
    const uri = { scheme: 'file', fsPath: 'C:/synthetic.jsonl', path: '/synthetic.jsonl', toString: () => 'file:///C:/synthetic.jsonl' } as vscode.Uri;
    const transfer = { forEach(callback: (item: unknown) => void) { callback({ asFile: () => ({ uri }) }); }, get: () => undefined };
    await upperBoard().dragAndDropController!.handleDrop!(collection, transfer as unknown as vscode.DataTransfer, { isCancellationRequested: false } as vscode.CancellationToken);
    expect(host.previewUri).not.toHaveBeenCalled(); expect(host.intake).not.toHaveBeenCalled();
    expect(host.scan).not.toHaveBeenCalled(); expect(host.updates).not.toHaveBeenCalled();
  });

  it('keeps the cross-tree MIME contract and drags current sessions into a collection with authorization rechecks', async () => {
    const secondEntity = { ...snapshot.snapshot.entities[0]!, nativeId: 'thread-2', label: 'Second session' };
    host.scan.mockResolvedValueOnce({ ...snapshot, snapshot: { ...snapshot.snapshot,
      entities: [...snapshot.snapshot.entities, secondEntity],
      locations: [...snapshot.snapshot.locations, { nativeId: 'thread-2', relativePath: 'sessions/second.jsonl', rowOrdinal: '1' }],
    } });
    await tree.refresh();
    host.input.mockResolvedValueOnce('Work'); await host.commands.get('jsonlView.sessionNavigator.collections.create')!();
    const [collection] = await upperBoard().treeDataProvider.getChildren();
    const [source] = await tree.getChildren();
    const sessions = source?.nodeKind === 'source' ? (await tree.getChildren(source)).filter((node) => node.nodeKind === 'entity') : [];
    expect(sessions).toHaveLength(2);
    const controller = sessionBoard().dragAndDropController;
    expect(sessionBoard().canSelectMany).toBe(true);
    expect(upperBoard().dragAndDropController).not.toBe(controller);
    expect(upperBoard().dragAndDropController.dragMimeTypes).toContain('application/vnd.jsonlview.session-ref');
    expect(controller.dragMimeTypes).toContain('application/vnd.jsonlview.session-ref');
    expect(upperBoard().dragAndDropController.dropMimeTypes).toContain('application/vnd.jsonlview.session-ref');
    expect(upperBoard().dragAndDropController.dropMimeTypes).toContain('application/vnd.code.tree.jsonlview.sessionnavigator');
    const transfer = new Map<string, { value: unknown }>();
    const dataTransfer = {
      set: (mime: string, item: { value: unknown }) => transfer.set(mime, item),
      get: (mime: string) => transfer.get(mime),
      forEach: () => {},
    };
    controller.handleDrag?.(sessions, dataTransfer as unknown as vscode.DataTransfer, { isCancellationRequested: false } as vscode.CancellationToken);
    const payload = JSON.parse(String(transfer.get('application/vnd.jsonlview.session-ref')?.value)) as { version: number; references: Array<{ providerId: string; sourceId: string; nativeId: string; generation: string }> };
    expect(payload).toMatchObject({ version: 1, references: [
      { providerId: 'codex', nativeId: 'thread-1' }, { providerId: 'codex', nativeId: 'thread-2' },
    ] });
    await upperBoard().dragAndDropController.handleDrop!(collection, dataTransfer as unknown as vscode.DataTransfer, { isCancellationRequested: false } as vscode.CancellationToken);
    expect(host.warning.mock.calls).toEqual([]);
    const [currentCollection] = await upperBoard().treeDataProvider.getChildren();
    expect((await upperBoard().treeDataProvider.getChildren(currentCollection)).filter((node) => node.kind === 'entry')).toHaveLength(2);
    expect(host.scan).toHaveBeenCalledTimes(1);
    expect(host.updates).not.toHaveBeenCalled();
  });

  it('rejects untrusted extra fields and never treats a session MIME drop as file intake', async () => {
    host.input.mockResolvedValueOnce('Work'); await host.commands.get('jsonlView.sessionNavigator.collections.create')!();
    const upper = upperBoard(); const [collection] = await upper.treeDataProvider.getChildren();
    const transfer = { get: () => ({ asString: async () => JSON.stringify({ version: 1, references: [{
      providerId: 'codex', sourceId: 'codex', nativeId: 'thread-1', generation: '1', sourcePath: 'C:/private.jsonl',
    }] }) }), forEach: () => {} };
    await upper.dragAndDropController.handleDrop!(collection, transfer as unknown as vscode.DataTransfer, { isCancellationRequested: false } as vscode.CancellationToken);
    expect(host.previewUri).not.toHaveBeenCalled();
    expect(await upper.treeDataProvider.getChildren(collection)).toMatchObject([{ kind: 'add-reference' }]);
    expect(host.warning).toHaveBeenCalledWith(expect.stringContaining('invalid'));
  });

  it('skips a dragged session after its source authorization is revoked', async () => {
    const session = await loadedEntity();
    host.input.mockResolvedValueOnce('Work'); await host.commands.get('jsonlView.sessionNavigator.collections.create')!();
    const upper = upperBoard(); const [collection] = await upper.treeDataProvider.getChildren();
    const transfer = new Map<string, { value: unknown; asString(): Promise<string> }>();
    const dataTransfer = {
      set: (mime: string, item: { value: unknown; asString(): Promise<string> }) => transfer.set(mime, item),
      get: (mime: string) => transfer.get(mime),
      forEach: () => {},
    };
    sessionBoard().dragAndDropController.handleDrag?.([session], dataTransfer as unknown as vscode.DataTransfer, { isCancellationRequested: false } as vscode.CancellationToken);
    host.config.set('sessionNavigator.sources', []);
    await upper.dragAndDropController.handleDrop!(collection, dataTransfer as unknown as vscode.DataTransfer, { isCancellationRequested: false } as vscode.CancellationToken);
    const [currentCollection] = await upper.treeDataProvider.getChildren();
    expect(await upper.treeDataProvider.getChildren(currentCollection)).toMatchObject([{ kind: 'add-reference' }]);
    expect(host.warning).toHaveBeenCalledWith(expect.stringContaining('no longer authorized'));
  });

  it('skips a dragged session when its Catalog generation changes before the drop', async () => {
    const session = await loadedEntity();
    host.input.mockResolvedValueOnce('Work'); await host.commands.get('jsonlView.sessionNavigator.collections.create')!();
    const upper = upperBoard(); const [collection] = await upper.treeDataProvider.getChildren();
    const transfer = new Map<string, { value: unknown; asString(): Promise<string> }>();
    const dataTransfer = {
      set: (mime: string, item: { value: unknown; asString(): Promise<string> }) => transfer.set(mime, item),
      get: (mime: string) => transfer.get(mime), forEach: () => {},
    };
    sessionBoard().dragAndDropController.handleDrag?.([session], dataTransfer as unknown as vscode.DataTransfer, { isCancellationRequested: false } as vscode.CancellationToken);
    host.scan.mockResolvedValueOnce({ ...snapshot, fingerprint: 'replacement', snapshot: { ...snapshot.snapshot, snapshotId: 'replacement', sourceGeneration: 'scan-2' } });
    host.probe.mockResolvedValueOnce('replacement');
    await tree.refresh();
    await upper.dragAndDropController.handleDrop!(collection, dataTransfer as unknown as vscode.DataTransfer, { isCancellationRequested: false } as vscode.CancellationToken);
    const [currentCollection] = await upper.treeDataProvider.getChildren();
    expect(await upper.treeDataProvider.getChildren(currentCollection)).toMatchObject([{ kind: 'add-reference' }]);
    expect(host.warning).toHaveBeenCalledWith(expect.stringContaining('no longer authorized'));
  });

  it('does not add session references dropped onto the Collections root instead of a collection', async () => {
    const session = await loadedEntity();
    host.input.mockResolvedValueOnce('Work'); await host.commands.get('jsonlView.sessionNavigator.collections.create')!();
    const transfer = new Map<string, { value: unknown; asString(): Promise<string> }>();
    const dataTransfer = {
      set: (mime: string, item: { value: unknown; asString(): Promise<string> }) => transfer.set(mime, item),
      get: (mime: string) => transfer.get(mime), forEach: () => {},
    };
    sessionBoard().dragAndDropController.handleDrag?.([session], dataTransfer as unknown as vscode.DataTransfer, { isCancellationRequested: false } as vscode.CancellationToken);
    await upperBoard().dragAndDropController.handleDrop!(undefined, dataTransfer as unknown as vscode.DataTransfer, { isCancellationRequested: false } as vscode.CancellationToken);
    const [collection] = await upperBoard().treeDataProvider.getChildren();
    expect(await upperBoard().treeDataProvider.getChildren(collection)).toMatchObject([{ kind: 'add-reference' }]);
  });

  it('does not route native file drops from the Sessions tree to Add Source', async () => {
    const session = await loadedEntity();
    const uri = { scheme: 'file', fsPath: 'C:/synthetic.jsonl', path: '/synthetic.jsonl', toString: () => 'file:///C:/synthetic.jsonl' } as vscode.Uri;
    await sessionBoard().dragAndDropController.handleDrop!(session, {
      forEach(callback: (item: unknown) => void) { callback({ asFile: () => ({ uri }) }); }, get: () => undefined,
    } as unknown as vscode.DataTransfer, { isCancellationRequested: false } as vscode.CancellationToken);
    expect(host.previewUri).not.toHaveBeenCalled();
  });

  it('does not mutate a collection when a session-reference drop is cancelled while reading the transfer', async () => {
    host.input.mockResolvedValueOnce('Work'); await host.commands.get('jsonlView.sessionNavigator.collections.create')!();
    const upper = upperBoard(); const [collection] = await upper.treeDataProvider.getChildren();
    const cancellation = { isCancellationRequested: false };
    const transfer = { get: () => ({ asString: async () => {
      cancellation.isCancellationRequested = true;
      return JSON.stringify({ version: 1, references: [{ providerId: 'codex', sourceId: 'codex', nativeId: 'thread-1', generation: '1' }] });
    } }), forEach: () => {} };
    await upper.dragAndDropController.handleDrop!(collection, transfer as unknown as vscode.DataTransfer, cancellation as vscode.CancellationToken);
    expect(await upper.treeDataProvider.getChildren(collection)).toMatchObject([{ kind: 'add-reference' }]);
  });

  it.each(['session', 'file'] as const)('adds an existing %s from the empty Collection without source intake or lower-tree changes', async (kind) => {
    if (kind === 'file') {
      const registered = join(root, 'registered.jsonl'); await writeFile(registered, '{}\n');
      host.roots = [{ provider: 'generic', rootUri: pathToFileURL(registered).toString() }]; host.config.set('sessionNavigator.sources', host.roots);
      await tree.refresh();
    } else await loadedEntity();
    const lower = await tree.getChildren();
    host.input.mockResolvedValueOnce('Work'); await host.commands.get('jsonlView.sessionNavigator.collections.create')!();
    const upper = upperBoard().treeDataProvider; const [collection] = await upper.getChildren();
    const [empty] = await upper.getChildren(collection); const action = upper.getTreeItem(empty!).command;
    expect(action).toMatchObject({ command: 'jsonlView.sessionNavigator.collections.addReference', arguments: [empty] });
    host.picker.mockImplementationOnce(async (items: unknown[]) => items[0]);
    host.picker.mockImplementationOnce(async (items: Array<{ value: string; entity?: { nativeId: string } }>) => kind === 'file'
      ? items.find((item) => item.value === 'source' && item.entity === undefined)
      : items.find((item) => item.entity?.nativeId === 'thread-1'));
    host.scan.mockClear(); host.probe.mockClear(); host.updates.mockClear(); host.discover.mockClear();
    await host.commands.get(action!.command)!(...action!.arguments!);
    const [current] = await upper.getChildren(); const [entry] = await upper.getChildren(current);
    expect(entry).toMatchObject({ kind: 'entry', entry: { referenceKind: kind, nativeId: kind === 'file' ? '@file' : 'thread-1' } });
    expect(pendingCollectionCommands()).toBe(0); expect(await tree.getChildren()).toEqual(lower);
    expect(host.scan).not.toHaveBeenCalled(); expect(host.probe).not.toHaveBeenCalled(); expect(host.updates).not.toHaveBeenCalled();
    expect(host.dialog).not.toHaveBeenCalled(); expect(host.previewUri).not.toHaveBeenCalled(); expect(host.intake).not.toHaveBeenCalled();
  });

  it('explains the independent Add Source route when no authorized references exist without enabling or scanning', async () => {
    host.config.set('sessionNavigator.enabled', false); host.config.set('sessionNavigator.sources', []); host.roots = [];
    host.input.mockResolvedValueOnce('Work'); await host.commands.get('jsonlView.sessionNavigator.collections.create')!();
    const upper = upperBoard().treeDataProvider; const [collection] = await upper.getChildren();
    const [empty] = await upper.getChildren(collection); const action = upper.getTreeItem(empty!).command;
    expect(action?.command).toBe('jsonlView.sessionNavigator.collections.addReference');
    await host.commands.get(action!.command)!(...action!.arguments!);
    expect(host.info).toHaveBeenCalledWith(expect.stringContaining('Add Source'));
    expect(host.config.get('sessionNavigator.enabled')).toBe(false); expect(pendingCollectionCommands()).toBe(0);
    expect(host.picker).not.toHaveBeenCalled(); expect(host.dialog).not.toHaveBeenCalled(); expect(host.updates).not.toHaveBeenCalled();
    expect(host.scan).not.toHaveBeenCalled(); expect(host.probe).not.toHaveBeenCalled(); expect(host.discover).not.toHaveBeenCalled();
  });

  it('reads persisted authorized references before Sessions is expanded without synchronizing sources', async () => {
    await loadedEntity(); tree.dispose(); tree = createTree(); tree.register();
    const sync = vi.spyOn(CatalogStore.prototype, 'syncSources');
    host.input.mockResolvedValueOnce('Work'); await host.commands.get('jsonlView.sessionNavigator.collections.create')!();
    const upper = upperBoard().treeDataProvider; const [collection] = await upper.getChildren(); const [empty] = await upper.getChildren(collection);
    host.picker.mockImplementationOnce(async (items: unknown[]) => items[0]);
    host.picker.mockImplementationOnce(async (items: Array<{ entity?: { nativeId: string } }>) => items.find((item) => item.entity?.nativeId === 'thread-1'));
    host.scan.mockClear(); host.probe.mockClear(); host.discover.mockClear(); host.updates.mockClear();
    await host.commands.get('jsonlView.sessionNavigator.collections.addReference')!(empty);
    const [current] = await upper.getChildren();
    expect(await upper.getChildren(current)).toMatchObject([{ kind: 'entry', entry: { referenceKind: 'session', nativeId: 'thread-1' } }]);
    expect(sync).not.toHaveBeenCalled(); expect(host.view.visible).toBe(false);
    expect(host.scan).not.toHaveBeenCalled(); expect(host.probe).not.toHaveBeenCalled(); expect(host.discover).not.toHaveBeenCalled(); expect(host.updates).not.toHaveBeenCalled();
  });

  it('routes the existing clipboard command to the paste-only intake panel', async () => {
    await host.commands.get('jsonlView.sessionNavigator.addSourceFromClipboard')!();
    expect(host.intake).toHaveBeenCalledOnce();
    expect(host.execute).not.toHaveBeenCalled();
    expect(host.dialog).not.toHaveBeenCalled();
  });

  it('rejects a Files selection over 32 before validating or authorizing any source', async () => {
    host.dialog.mockResolvedValue(Array.from({ length: 33 }, (_, index) => ({
      toString: () => `file:///C:/source-${String(index)}.jsonl`,
    })) as vscode.Uri[]);

    await host.commands.get('jsonlView.sessionNavigator.source.files')!();

    expect(host.validateSource).not.toHaveBeenCalled();
    expect(host.warning).toHaveBeenCalledWith('Choose up to 32 sources at a time.');
    expect(host.picker).not.toHaveBeenCalled();
    expect(host.updates).not.toHaveBeenCalled();
  });

  it('validates the whole deduplicated Files selection before any authorization prompt', async () => {
    const first = 'file:///C:/first.jsonl';
    const second = 'file:///C:/second.jsonl';
    host.dialog.mockResolvedValue([first, first, second].map((value) => ({ toString: () => value })) as vscode.Uri[]);
    host.validateSource.mockImplementation(async (value: string) => {
      expect(host.warning).not.toHaveBeenCalled();
      return { fsPath: value, toString: (_skipEncoding?: boolean) => value };
    });

    await host.commands.get('jsonlView.sessionNavigator.source.files')!();

    expect(host.validateSource.mock.calls.map(([value]) => value)).toEqual([first, second]);
    expect(host.warning).toHaveBeenCalledTimes(2);
    expect(host.warning.mock.calls.every(([message, options]) => message.startsWith('Add ') && (options as { modal?: boolean } | undefined)?.modal === true)).toBe(true);
  });

  it('authorizes none of a Files selection when any selected source fails validation', async () => {
    const first = 'file:///C:/first.jsonl';
    const invalid = 'file:///C:/invalid.jsonl';
    host.dialog.mockResolvedValue([first, invalid].map((value) => ({ toString: () => value })) as vscode.Uri[]);
    host.validateSource
      .mockResolvedValueOnce({ fsPath: first, toString: (_skipEncoding?: boolean) => first })
      .mockRejectedValueOnce(new Error('Choose a local file or folder.'));

    await host.commands.get('jsonlView.sessionNavigator.source.files')!();

    expect(host.validateSource.mock.calls.map(([value]) => value)).toEqual([first, invalid]);
    expect(host.warning).toHaveBeenCalledOnce();
    expect(host.warning).toHaveBeenCalledWith('Choose a local file or folder.');
    expect(host.warning.mock.calls[0]?.length).toBe(1);
    expect(host.picker).not.toHaveBeenCalled();
    expect(host.updates).not.toHaveBeenCalled();
  });

  it('drops obsolete source errors when the configured source is removed', async () => {
    host.scan.mockRejectedValueOnce(new Error('no access'));
    await tree.refresh();
    expect(host.view.message).toContain('could not load');
    host.roots = [];
    host.config.set('sessionNavigator.sources', []);
    await tree.refresh();
    const [detected] = await tree.getChildren();
    expect(detected?.nodeKind).toBe('detected-group');
    const [empty] = await tree.getChildren(detected);
    expect(tree.getTreeItem(empty!)).toMatchObject({ label: 'No additional local agent sources detected' });
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
    const [detected] = await tree.getChildren();
    expect(detected?.nodeKind).toBe('detected-group');
    const [empty] = await tree.getChildren(detected);
    expect(tree.getTreeItem(empty!)).toMatchObject({ label: 'No additional local agent sources detected' });
  });
});
