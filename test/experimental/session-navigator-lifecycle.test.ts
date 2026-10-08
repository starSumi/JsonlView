import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { AuthorizedSourceSetting, SessionNavigatorScanResult } from '../../src/experimental/session-navigator/types';

const host = vi.hoisted(() => ({
  config: new Map<string, unknown>(), state: new Map<string, unknown>(),
  commands: new Map<string, (...args: any[]) => unknown>(),
  roots: [] as AuthorizedSourceSetting[], scan: vi.fn(), picker: vi.fn(), dialog: vi.fn(),
  configuration: undefined as undefined | ((event: { affectsConfiguration: (key: string) => boolean }) => void),
  visibility: undefined as undefined | ((event: { visible: boolean }) => void),
  view: { visible: false, dispose() {}, onDidChangeVisibility: vi.fn() },
}));
vi.mock('vscode', () => ({
  EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
  Uri: {
    joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: join(base.fsPath, ...parts) }),
  },
  ConfigurationTarget: { Global: 1 },
  window: { createTreeView: () => host.view, showQuickPick: host.picker, showOpenDialog: host.dialog, showWarningMessage: vi.fn(), showErrorMessage: vi.fn() },
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
  commands: { registerCommand: (id: string, handler: (...args: any[]) => unknown) => { host.commands.set(id, handler); return { dispose() {} }; } },
}));
vi.mock('../../src/experimental/session-navigator/source-config', async (original) => {
  const actual = await original<typeof import('../../src/experimental/session-navigator/source-config')>();
  return { ...actual, discoverDefaultSources: () => host.roots, mergeSourceSettings: (configured: AuthorizedSourceSetting[]) => actual.mergeSourceSettings(configured, host.roots) };
});
vi.mock('../../src/experimental/session-navigator/file-provider', () => ({ createSessionNavigatorProvider: () => ({ scan: host.scan, probe: async () => 'stable' }) }));
import { SessionNavigatorTreeProvider } from '../../src/experimental/session-navigator/tree-provider';
import { RevealIntentRegistry } from '../../src/experimental/session-navigator/reveal-intents';

let root: string;
let tree: SessionNavigatorTreeProvider;
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
  host.scan.mockReset().mockResolvedValue(snapshot); host.dialog.mockReset(); host.picker.mockReset();
  host.view.visible = false;
  host.view.onDidChangeVisibility.mockImplementation((listener: typeof host.visibility) => { host.visibility = listener; return { dispose() {} }; });
  tree = new SessionNavigatorTreeProvider({
    globalStorageUri: { fsPath: root },
    globalState: { get: (key: string, fallback: unknown) => host.state.get(key) ?? fallback, update: async (key: string, value: unknown) => { host.state.set(key, value); } },
  } as unknown as vscode.ExtensionContext, new RevealIntentRegistry());
  tree.register();
});
afterEach(async () => { tree.dispose(); await rm(root, { recursive: true, force: true }); });

describe('Session Navigator host lifecycle', () => {
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
    await host.commands.get('jsonlView.sessionNavigator.addSource')!();
    expect(host.dialog).not.toHaveBeenCalled();
    const sources = await tree.getChildren();
    expect(sources).toHaveLength(1);
    expect(await tree.getChildren(sources[0])).toHaveLength(1);
    await host.commands.get('jsonlView.sessionNavigator.removeSource')!(sources[0]);
    await tree.refresh();
    expect(await tree.getChildren()).toEqual([]);
    expect(host.config.get('sessionNavigator.sources')).toEqual([]);
    await host.commands.get('jsonlView.sessionNavigator.addSource')!();
    expect(await tree.getChildren()).toHaveLength(1);
  });

  it('coalesces refreshes and discards a late scan after disabling without deleting the catalog', async () => {
    await tree.refresh();
    let complete!: (value: SessionNavigatorScanResult) => void;
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
