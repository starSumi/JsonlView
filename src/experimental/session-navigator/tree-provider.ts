import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import * as vscode from 'vscode';
import { CatalogStore, DEFAULT_CATALOG_PAGE_LIMIT, type CatalogAppendGuard } from './catalog-store';
import { createSessionNavigatorProvider } from './provider-factory';
import { discoverDefaultSources, mergeSourceSettings, parseAuthorizedSources, sourceIdFor, sourceLabelFor } from './source-config';
import type { RevealIntentRegistry } from './reveal-intents';
import { SourceIntakePanel, validateLocalSourceUri } from './source-intake';
import { type SessionPreview, SessionPreviews } from './session-previews';
import { DEFAULT_SESSION_NAVIGATOR_BUDGET, sessionNavigatorProviderLabel, type AuthorizedSourceSetting, type DetectedAgentProviderId, type NavigatorEntity, type NavigatorSourceSummary, type RevealIntent, type SessionNavigatorProvider, type SessionNavigatorProviderId, type SessionNavigatorSortKey } from './types';
import type { NavigatorBridgeResultV1 } from '../../shared/protocol/navigator-bridge';

const SOURCES_SETTING = 'sessionNavigator.sources';
const ENABLED_SETTING = 'sessionNavigator.enabled';
const SORT_SETTING = 'sessionNavigator.sort';
const PROBE_INTERVAL_MS = 30_000;
const MAX_TRANSIENT_EMPTY_SCANS = 2;
const MAX_INITIAL_CLAUDE_PAGES = 2;
const EXCLUDED_SOURCES_KEY = 'sessionNavigator.excludedDefaultSources';

const SOURCE_PROVIDER_CHOICES: readonly { readonly label: string; readonly value: SessionNavigatorProviderId }[] = [
  { label: 'Codex', value: 'codex' },
  { label: 'Claude', value: 'claude' },
  { label: 'pi', value: 'pi' },
  { label: 'Kimi Code', value: 'kimi' },
  { label: 'Gemini', value: 'gemini' },
  { label: 'OpenCode', value: 'opencode' },
  { label: 'AgentsView', value: 'agentsview' },
  { label: 'Generic JSONL', value: 'generic' },
];

/**
 * Host-side result for the editor's Open Navigator bridge.  The Webview must
 * render this result instead of inferring authorization from the fact that a
 * focus command was accepted.  Source contents and provider details stay out
 * of this contract; the shared transport adapter maps these facets to its
 * versioned protocol payload.
 */
export type NavigatorBridgeResult = NavigatorBridgeResultV1;

export interface NavigatorBridgeTarget {
  readonly documentId: string;
  readonly sourceUri: string;
}

interface SourceTreeNode {
  readonly nodeKind: 'source';
  readonly source: NavigatorSourceSummary;
}

interface EntityTreeNode {
  readonly nodeKind: 'entity';
  readonly entity: NavigatorEntity;
}

interface CatalogPageTreeNode {
  readonly nodeKind: 'catalog-page';
  readonly sourceId: string;
  readonly generation: string;
  readonly parentNativeId: string | undefined;
  readonly sortKey: SessionNavigatorSortKey;
  readonly cursor: string;
  readonly epoch: number;
}

interface CatalogErrorTreeNode {
  readonly nodeKind: 'catalog-error';
  readonly sourceId: string;
  readonly pageId: string;
  readonly detail: string;
}

interface PreviewGroupTreeNode {
  readonly nodeKind: 'preview-group';
}

interface PreviewTreeNode {
  readonly nodeKind: 'preview';
  readonly previewId: string;
}

interface SourceStatus { phase: 'loading' | 'error'; detail?: string }

export type SessionNavigatorTreeNode = SourceTreeNode | EntityTreeNode | CatalogPageTreeNode | CatalogErrorTreeNode | PreviewGroupTreeNode | PreviewTreeNode;

export class SessionNavigatorTreeProvider implements vscode.TreeDataProvider<SessionNavigatorTreeNode>, vscode.Disposable {
  readonly #context: vscode.ExtensionContext;
  readonly #revealRegistry: RevealIntentRegistry;
  readonly #changed = new vscode.EventEmitter<SessionNavigatorTreeNode | undefined | null | void>();
  readonly #providers = new Map<string, SessionNavigatorProvider>();
  readonly #sourceStatus = new Map<string, SourceStatus>();
  readonly #intake: SourceIntakePanel;
  readonly #previewRegistration: vscode.Disposable;
  #store: CatalogStore | undefined;
  #openingStore: Promise<CatalogStore> | undefined;
  #refreshing: Promise<void> | undefined;
  #scanController: AbortController | undefined;
  #refreshAgain = false;
  readonly #pageFlights = new Map<string, Promise<void>>();
  readonly #pageControllers = new Map<string, AbortController>();
  readonly #childrenFlights = new Map<string, Promise<SessionNavigatorTreeNode[]>>();
  readonly #sourceEpochs = new Map<string, number>();
  /**
   * A Claude directory can be visible before its first metadata records are
   * readable (for example while a transcript is still being appended). Keep
   * that bounded empty page provisional instead of replacing a usable catalog
   * with a misleading zero-session partial index.
   */
  readonly #transientEmptyScans = new Map<string, number>();
  #initialized = false;
  #treeView: vscode.TreeView<SessionNavigatorTreeNode> | undefined;
  #probeTimer: NodeJS.Timeout | undefined;
  #disposed = false;
  #opening: Promise<NavigatorBridgeResult> | undefined;

  public readonly onDidChangeTreeData = this.#changed.event;

  public constructor(context: vscode.ExtensionContext, revealRegistry: RevealIntentRegistry, public readonly previews = new SessionPreviews()) {
    this.#context = context;
    this.#revealRegistry = revealRegistry;
    this.#intake = new SourceIntakePanel(
      (uri, signal) => this.confirmCustomSource(uri, () => signal.aborted),
      (provider, signal) => this.authorizeDetectedAgent(provider, signal),
      previews,
      (signal) => this.authorizeAgent(() => this.#disposed || signal.aborted),
    );
    this.#previewRegistration = previews.onDidChange(() => this.#changed.fire(undefined));
  }

  public register(): vscode.Disposable[] {
    this.#treeView = vscode.window.createTreeView('jsonlView.sessionNavigator', {
      treeDataProvider: this,
      dragAndDropController: {
        dropMimeTypes: ['files', 'text/uri-list'],
        dragMimeTypes: [],
        handleDrop: (target, dataTransfer, token) => this.handleDrop(target, dataTransfer, token),
      },
    });
    const subscriptions: vscode.Disposable[] = [
      this.#treeView,
      vscode.window.registerWebviewViewProvider('jsonlView.sourceDrop', this.#intake),
      vscode.commands.registerCommand('jsonlView.sessionNavigator.refresh', () => this.refresh()),
      vscode.commands.registerCommand('jsonlView.sessionNavigator.addSource', () => this.addSource()),
      vscode.commands.registerCommand('jsonlView.sessionNavigator.authorizeAgent', () => this.authorizeAgent()),
      vscode.commands.registerCommand('jsonlView.sessionNavigator.removeSource', (node?: SessionNavigatorTreeNode) => this.removeSource(node)),
      vscode.commands.registerCommand('jsonlView.sessionNavigator.loadMore', (node?: SessionNavigatorTreeNode) => this.loadMore(node)),
      vscode.commands.registerCommand('jsonlView.sessionNavigator.enable', () => this.open()),
      vscode.commands.registerCommand('jsonlView.sessionNavigator.settings', () => this.openSettings()),
      vscode.commands.registerCommand('jsonlView.sessionNavigator.disable', () => this.setEnabled(false)),
      vscode.commands.registerCommand('jsonlView.sessionNavigator.open', () => this.open()),
      vscode.commands.registerCommand('jsonlView.sessionNavigator.sortActivity', () => this.setSort('activity')),
      vscode.commands.registerCommand('jsonlView.sessionNavigator.sortCreated', () => this.setSort('created')),
      vscode.commands.registerCommand('jsonlView.sessionNavigator.sortTitle', () => this.setSort('title')),
      vscode.commands.registerCommand('jsonlView.sessionNavigator.sort', () => this.chooseSort()),
      vscode.commands.registerCommand('jsonlView.sessionNavigator.addSourceFromClipboard', () => this.addSource()),
      vscode.commands.registerCommand('jsonlView.previews.open', (node: unknown) => this.openPreview(node)),
      vscode.commands.registerCommand('jsonlView.previews.saveAs', (node: unknown) => this.savePreviewAs(node)),
      vscode.commands.registerCommand('jsonlView.previews.openSavedCopy', (node: unknown) => this.openSavedPreviewCopy(node)),
      vscode.commands.registerCommand('jsonlView.revealSessionNode', (node: EntityTreeNode) => this.reveal(node)),
      vscode.commands.registerCommand('jsonlView.sessionNavigator.openEntity', (node: SessionNavigatorTreeNode) => this.openEntity(node)),
      vscode.commands.registerCommand('jsonlView.sessionNavigator.openEntityWith', (node: SessionNavigatorTreeNode) => this.openEntityWith(node)),
      vscode.commands.registerCommand('jsonlView.sessionNavigator.revealInFileExplorer', (node: SessionNavigatorTreeNode) => this.revealInFileExplorer(node)),
      vscode.commands.registerCommand('jsonlView.sessionNavigator.openInIntegratedTerminal', (node: SessionNavigatorTreeNode) => this.openInIntegratedTerminal(node)),
      vscode.commands.registerCommand('jsonlView.sessionNavigator.copyPath', (node: SessionNavigatorTreeNode) => this.copyPath(node)),
      vscode.commands.registerCommand('jsonlView.sessionNavigator.copyRelativePath', (node: SessionNavigatorTreeNode) => this.copyRelativePath(node)),
      vscode.commands.registerCommand('jsonlView.sessionNavigator.openTimeline', (node: SessionNavigatorTreeNode) => this.openTimeline(node)),
      vscode.commands.registerCommand('jsonlView.sessionNavigator.copySessionId', (node: SessionNavigatorTreeNode) => this.copySessionId(node)),
      this.#treeView.onDidChangeVisibility((event) => this.handleVisibility(event.visible)),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('jsonlView.sessionNavigator')) {
          this.invalidateAllSources();
          if (event.affectsConfiguration('jsonlView.' + SOURCES_SETTING) || event.affectsConfiguration('jsonlView.' + ENABLED_SETTING)) {
            this.#scanController?.abort();
            this.#refreshAgain = true;
            this.#initialized = false;
            if (!this.isEnabled() && this.#treeView !== undefined) this.#treeView.message = '';
            this.handleVisibility(this.#treeView?.visible ?? false);
          }
          this.#changed.fire(undefined);
        }
      }),
    ];
    this.handleVisibility(this.#treeView.visible);
    return subscriptions;
  }

  public getTreeItem(node: SessionNavigatorTreeNode): vscode.TreeItem {
    if (node.nodeKind === 'preview-group') {
      const item = new vscode.TreeItem('Recent Previews', vscode.TreeItemCollapsibleState.Collapsed);
      item.id = 'recent-previews';
      item.contextValue = 'jsonlView.sessionNavigator.previewGroup';
      item.description = String(this.previews.list().length);
      item.iconPath = new vscode.ThemeIcon('history');
      item.tooltip = 'Temporary previews from this VS Code session. Save As keeps a permanent copy.';
      return item;
    }
    if (node.nodeKind === 'preview') {
      const preview = this.previewForId(node.previewId);
      const item = new vscode.TreeItem(
        preview === undefined ? 'Preview unavailable' : 'Preview · ' + new Date(preview.createdAt).toLocaleTimeString(),
        vscode.TreeItemCollapsibleState.None,
      );
      item.id = 'preview:' + node.previewId;
      item.contextValue = preview?.savedUri === undefined ? 'jsonlView.preview.temporary' : 'jsonlView.preview.savedCopy';
      item.description = preview === undefined ? 'Refresh to remove' : String(preview.recordCount) + ' records · ' + (preview.status === 'saving' ? 'Saving…' : preview.savedUri === undefined ? 'Temporary' : 'Saved copy');
      item.tooltip = preview === undefined
        ? 'This temporary preview is no longer available.'
        : new Date(preview.createdAt).toLocaleString() + '\n' + String(preview.sizeBytes) + ' UTF-8 bytes. Temporary source is recoverable during this VS Code session only. Save As keeps a permanent copy.';
      item.iconPath = new vscode.ThemeIcon(preview?.status === 'saving' ? 'loading~spin' : 'file');
      item.command = { command: 'jsonlView.previews.open', title: 'Open temporary preview', arguments: [node] };
      return item;
    }
    if (node.nodeKind === 'catalog-page') {
      const item = new vscode.TreeItem('More indexed sessions…', vscode.TreeItemCollapsibleState.Collapsed);
      item.id = 'catalog-page:' + childrenFlightKey(node);
      item.contextValue = 'jsonlView.sessionNavigator.catalogPage';
      item.description = 'Next ' + String(DEFAULT_CATALOG_PAGE_LIMIT);
      item.iconPath = new vscode.ThemeIcon('ellipsis');
      item.tooltip = 'Expand to read the next bounded page of indexed sessions. Use the source Load More action to scan additional provider metadata.';
      return item;
    }
    if (node.nodeKind === 'catalog-error') {
      const item = new vscode.TreeItem('Session page unavailable · Refresh', vscode.TreeItemCollapsibleState.None);
      item.id = 'catalog-error:' + node.pageId;
      item.contextValue = 'jsonlView.sessionNavigator.catalogError';
      item.iconPath = new vscode.ThemeIcon('warning');
      item.tooltip = node.detail;
      item.command = { command: 'jsonlView.sessionNavigator.refresh', title: 'Reload session pages' };
      return item;
    }
    if (node.nodeKind === 'source') {
      const status = this.#sourceStatus.get(node.source.sourceId);
      const item = new vscode.TreeItem(node.source.label, node.source.entityCount > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None);
      item.id = `source:${node.source.sourceId}`;
      item.contextValue = 'jsonlView.sessionNavigator.source';
      item.description = status?.phase === 'loading' ? (node.source.capturedAt === undefined ? 'Loading…' : 'Refreshing…')
        : status?.phase === 'error' ? (node.source.capturedAt === undefined ? 'Could not load · Retry' : String(node.source.entityCount) + ' cached session' + (node.source.entityCount === 1 ? '' : 's') + ' · Retry')
        : node.source.capturedAt === undefined ? 'Waiting to load…'
        : node.source.entityCount === 0 && !node.source.truncated ? 'No sessions found'
        : String(node.source.entityCount) + ' session' + (node.source.entityCount === 1 ? '' : 's') + (node.source.truncated ? ' · partial index' : '') + (node.source.updateAvailable ? ' · updates available' : '');
      item.iconPath = new vscode.ThemeIcon(status?.phase === 'loading' ? 'loading~spin' : status?.phase === 'error' ? 'warning' : 'folder');
      item.tooltip = [node.source.label, this.#store?.getSourceRoot(node.source.sourceId), status?.detail,
        node.source.truncated ? 'Partial index: the metadata scan reached a budget limit.' : undefined,
        node.source.lastActivityAt === undefined ? undefined : 'Last activity: ' + node.source.lastActivityAt].filter(Boolean).join('\n');
      if (status?.phase === 'error') item.command = { command: 'jsonlView.sessionNavigator.refresh', title: 'Retry loading sessions' };
      if (node.source.nextCursor !== undefined) item.contextValue += '.partial';
      return item;
    }
    const hasChildren = this.#store?.hasChildren(node.entity.sourceId, node.entity.nativeId) ?? false;
    const label = node.entity.label.startsWith('Untitled session') ? '#' + node.entity.nativeId.slice(0, 10) : node.entity.label;
    const item = new vscode.TreeItem(label, hasChildren
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None);
    item.id = `entity:${node.entity.sourceId}:${node.entity.nativeId}`;
    // Context menus use a stable key. The raw tree node is supplied to each
    // command, so kind-specific keys would only multiply manifest cases.
    item.contextValue = 'jsonlView.sessionNavigator.entity';
    item.description = [node.entity.relationship === 'root' ? undefined : node.entity.relationship, node.entity.activityAt === undefined ? undefined : relativeTime(node.entity.activityAt)].filter((value): value is string => value !== undefined).join(' · ');
    item.iconPath = new vscode.ThemeIcon(node.entity.kind === 'subagent' ? 'hubot' : 'comment-discussion');
    const location = this.#store?.getLocation({ sourceId: node.entity.sourceId, generation: node.entity.generation, nativeId: node.entity.nativeId });
    item.tooltip = [label, node.entity.vendorTitle === undefined ? undefined : 'Provider title: ' + node.entity.vendorTitle,
      node.entity.firstMessagePreview === undefined ? undefined : 'Preview: ' + node.entity.firstMessagePreview,
      'ID: ' + node.entity.nativeId, node.entity.activityAt === undefined ? undefined : 'Last activity: ' + node.entity.activityAt,
      node.entity.status === undefined ? undefined : 'Status: ' + node.entity.status,
      location === undefined ? undefined : 'Source: ' + location.relativePath].filter((value): value is string => value !== undefined).join('\n');
    item.command = {
      command: 'jsonlView.revealSessionNode',
      title: 'Reveal in JsonlView',
      arguments: [node],
    };
    return item;
  }

  public async getChildren(node?: SessionNavigatorTreeNode): Promise<SessionNavigatorTreeNode[]> {
    if (this.#disposed) return [];
    // Temporary previews belong to this VS Code session, not to Agent source
    // authorization. Keep their metadata-only recovery branch visible even
    // while Navigator is opt-in disabled, without opening the catalog or
    // probing any configured source.
    if (!this.isEnabled()) {
      if (node?.nodeKind === 'preview-group') return this.previews.list().slice().reverse().map((preview) => ({ nodeKind: 'preview', previewId: preview.id } satisfies PreviewTreeNode));
      if (node === undefined && this.previews.list().length > 0) return [{ nodeKind: 'preview-group' }];
      return [];
    }
    const store = await this.ensureStore();
    if (this.#disposed || !this.isEnabled()) return [];
    if (node === undefined) {
      store.syncSources(this.settings());
      if (!this.#initialized && this.#treeView?.visible && this.#refreshing === undefined) {
        for (const setting of this.settings()) this.#sourceStatus.set(sourceIdFor(setting), { phase: 'loading' });
        this.#changed.fire(undefined);
        this.#initialized = true;
        void this.refresh();
      }
      const children: SessionNavigatorTreeNode[] = store.listSources().map((source) => ({ nodeKind: 'source', source } satisfies SourceTreeNode));
      if (this.previews.list().length > 0) children.push({ nodeKind: 'preview-group' });
      return children;
    }
    if (node.nodeKind === 'preview-group') return this.previews.list().slice().reverse().map((preview) => ({ nodeKind: 'preview', previewId: preview.id } satisfies PreviewTreeNode));
    if (node.nodeKind === 'preview') return [];
    if (node.nodeKind === 'source') {
      if (store.getSourcePageState(node.source.sourceId)?.generation !== node.source.generation) {
        return this.catalogPageError(node.source.sourceId, 'Catalog source generation is stale. Refresh to reload session pages.');
      }
      return this.catalogChildren(store, node.source.sourceId);
    }
    if (node.nodeKind === 'catalog-page') return this.catalogChildren(store, node.sourceId, node.parentNativeId, node);
    if (node.nodeKind === 'catalog-error') return [];
    if (store.getSourcePageState(node.entity.sourceId)?.generation !== node.entity.generation) return this.catalogPageError(node.entity.sourceId, 'Catalog children generation is stale. Refresh to reload session pages.', 'entity:' + node.entity.sourceId + ':' + node.entity.nativeId);
    return this.catalogChildren(store, node.entity.sourceId, node.entity.nativeId);
  }

  private catalogPageError(sourceId: string, detail: string, pageId = sourceId): SessionNavigatorTreeNode[] {
    return [{ nodeKind: 'catalog-error', sourceId, pageId, detail }];
  }

  private catalogChildren(store: CatalogStore, sourceId: string, parentNativeId?: string, continuation?: CatalogPageTreeNode): Promise<SessionNavigatorTreeNode[]> {
    const generation = store.getSourcePageState(sourceId)?.generation;
    if (generation === undefined) return Promise.resolve([]);
    const epoch = this.sourceEpoch(sourceId);
    this.#sourceEpochs.set(sourceId, epoch);
    const sortKey = this.sortKey();
    if (continuation !== undefined && (continuation.generation !== generation || continuation.epoch !== epoch || continuation.sortKey !== sortKey)) {
      return Promise.resolve(this.catalogPageError(sourceId, 'Catalog children cursor is stale. Refresh to reload session pages.', childrenFlightKey(continuation)));
    }
    const identity = { sourceId, generation, parentNativeId, sortKey, cursor: continuation?.cursor ?? '', epoch };
    const key = childrenFlightKey(identity);
    const existing = this.#childrenFlights.get(key);
    if (existing !== undefined) return existing;
    const controller = new AbortController();
    this.#pageControllers.set(key, controller);
    const current = () => !controller.signal.aborted && !this.#disposed && this.isEnabled() && this.sourceEpoch(sourceId) === epoch
      && this.sortKey() === sortKey && this.settings().some((setting) => sourceIdFor(setting) === sourceId);
    // Keep only active reads. Expanded branches belong to VS Code; the provider
    // never retains or concatenates earlier entity pages.
    const flight = Promise.resolve().then(async (): Promise<SessionNavigatorTreeNode[]> => {
      if (!current()) return [];
      const pageOptions = continuation === undefined ? { signal: controller.signal } : { cursor: continuation.cursor, signal: controller.signal };
      const page = await store.getChildrenPage(sourceId, parentNativeId, sortKey, pageOptions);
      if (!current()) return [];
      if (store.getSourcePageState(sourceId)?.generation !== generation || page.generation !== generation) {
        return this.catalogPageError(sourceId, 'Catalog children generation is stale. Refresh to reload session pages.', key);
      }
      const nodes: SessionNavigatorTreeNode[] = page.entities.map((entity) => ({ nodeKind: 'entity', entity }));
      if (page.nextCursor !== undefined) nodes.push({ nodeKind: 'catalog-page', ...identity, cursor: page.nextCursor });
      return nodes;
    }).catch((error: unknown) => current() ? this.catalogPageError(sourceId, error instanceof Error ? error.message : 'Catalog children page could not load.', key) : [])
      .finally(() => {
        if (this.#pageControllers.get(key) === controller) this.#pageControllers.delete(key);
        if (this.#childrenFlights.get(key) === flight) this.#childrenFlights.delete(key);
      });
    this.#childrenFlights.set(key, flight);
    return flight;
  }

  public async refresh(): Promise<void> {
    if (this.#disposed || !this.isEnabled()) return;
    if (this.#refreshing !== undefined) return this.#refreshing;
    this.invalidateAllSources();
    if (this.#treeView) this.#treeView.message = 'Loading sessions…';
    this.#changed.fire(undefined);
    this.#refreshing = Promise.resolve(vscode.window.withProgress({ location: { viewId: 'jsonlView.sessionNavigator' } }, () => this.runRefreshes()));
    try { await this.#refreshing; }
    finally {
      this.#refreshing = undefined;
      if (!this.#disposed && this.#treeView) {
        this.#treeView.message = this.isEnabled() && [...this.#sourceStatus.values()].some((status) => status.phase === 'error')
          ? 'Some sources could not load. Select a warning to retry.'
          : '';
      }
      this.#changed.fire(undefined);
    }
  }

  public async loadMore(node?: SessionNavigatorTreeNode): Promise<void> {
    if (this.#disposed || !this.isEnabled() || node?.nodeKind !== 'source' || this.#refreshing !== undefined) return;
    const store = await this.ensureStore();
    const cursor = node.source.nextCursor;
    if (cursor === undefined) return;
    const sourceId = node.source.sourceId;
    const state = store.getSourcePageState(sourceId);
    if (state?.generation !== node.source.generation || state.nextCursor !== cursor || state.fingerprint === undefined) return;
    const setting = this.settings().find((candidate) => sourceIdFor(candidate) === sourceId);
    if (setting === undefined) return;
    const key = pageFlightKey(sourceId, state.generation, cursor);
    const existing = this.#pageFlights.get(key);
    if (existing !== undefined) return existing;
    const epoch = this.sourceEpoch(sourceId);
    const controller = new AbortController();
    this.#pageControllers.set(key, controller);
    const flight = this.runLoadMorePage(store, setting, sourceId, state.generation, state.fingerprint, cursor, epoch, controller, key);
    this.#pageFlights.set(key, flight);
    return flight;
  }

  private async runLoadMorePage(store: CatalogStore, setting: AuthorizedSourceSetting, sourceId: string, generation: string, fingerprint: string, cursor: string, epoch: number, controller: AbortController, key: string): Promise<void> {
    this.#sourceStatus.set(sourceId, { phase: 'loading' });
    this.#changed.fire(undefined);
    try {
      const provider = this.providerFor(setting);
      const page = provider.scanPage === undefined ? await provider.scan(controller.signal, DEFAULT_SESSION_NAVIGATOR_BUDGET) : await provider.scanPage(controller.signal, DEFAULT_SESSION_NAVIGATOR_BUDGET, cursor);
      if (!this.canCommitPage(store, sourceId, generation, fingerprint, cursor, epoch, controller.signal)) return;
      const returnedCursor = page.nextCursor ?? page.snapshot.nextCursor;
      const nextCursor = returnedCursor === cursor ? undefined : returnedCursor;
      const snapshot = {
        ...page.snapshot,
        truncated: nextCursor !== undefined,
        ...(nextCursor === undefined ? {} : { nextCursor }),
      };
      const guard: CatalogAppendGuard = {
        expectedGeneration: generation,
        expectedCursor: cursor,
        expectedFingerprint: fingerprint,
        signal: controller.signal,
      };
      store.appendSnapshot(sourceId, snapshot, page.fingerprint, guard);
    } catch (error) {
      if (!this.#disposed && !controller.signal.aborted && this.sourceEpoch(sourceId) === epoch) {
        this.#sourceStatus.set(sourceId, { phase: 'error', detail: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      if (this.#pageControllers.get(key) === controller) this.#pageControllers.delete(key);
      if (this.#pageFlights.get(key) !== undefined) this.#pageFlights.delete(key);
      this.#sourceStatus.delete(sourceId);
      this.#changed.fire(undefined);
    }
  }

  private sourceEpoch(sourceId: string): number {
    return this.#sourceEpochs.get(sourceId) ?? 0;
  }

  private canCommitPage(store: CatalogStore, sourceId: string, generation: string, fingerprint: string, cursor: string, epoch: number, signal: AbortSignal): boolean {
    if (signal.aborted || this.#disposed || !this.isEnabled() || this.sourceEpoch(sourceId) !== epoch) return false;
    if (!this.settings().some((setting) => sourceIdFor(setting) === sourceId)) return false;
    const state = store.getSourcePageState(sourceId);
    return state?.generation === generation && state.nextCursor === cursor && state.fingerprint === fingerprint;
  }

  private invalidateSource(sourceId: string): void {
    this.#sourceEpochs.set(sourceId, this.sourceEpoch(sourceId) + 1);
    const prefix = sourceId + '\u0000';
    for (const [key, controller] of this.#pageControllers) if (key.startsWith(prefix)) controller.abort();
  }

  private invalidateAllSources(): void {
    const sourceIds = new Set<string>([
      ...this.#sourceEpochs.keys(),
      ...[...this.#pageControllers.keys()].map((key) => key.split('\u0000', 1)[0] ?? ''),
    ]);
    for (const sourceId of sourceIds) if (sourceId.length > 0) this.invalidateSource(sourceId);
  }

  private async runRefreshes(): Promise<void> {
    do {
      this.#refreshAgain = false;
      const controller = new AbortController();
      this.#scanController = controller;
      try { await this.refreshSources(controller.signal); }
      finally { if (this.#scanController === controller) this.#scanController = undefined; }
    } while (this.#refreshAgain && !this.#disposed && this.isEnabled() && this.#treeView?.visible);
  }

  private async refreshSources(signal: AbortSignal): Promise<void> {
    try {
      const store = await this.ensureStore();
      if (signal.aborted || this.#disposed || !this.isEnabled()) return;
      const settings = this.settings();
      store.syncSources(settings);
      const activeSourceIds = new Set(settings.map(sourceIdFor));
      for (const id of this.#sourceStatus.keys()) if (!activeSourceIds.has(id)) this.#sourceStatus.delete(id);
      for (const id of this.#providers.keys()) if (!activeSourceIds.has(id)) this.#providers.delete(id);
      for (const id of this.#transientEmptyScans.keys()) if (!activeSourceIds.has(id)) this.#transientEmptyScans.delete(id);
      for (const setting of settings) this.#sourceStatus.set(sourceIdFor(setting), { phase: 'loading' });
      this.#changed.fire(undefined);
      const failures: string[] = [];
      for (const setting of settings) {
        if (signal.aborted || this.#disposed || !this.isEnabled()) return;
        const sourceId = sourceIdFor(setting);
        try {
          const provider = this.providerFor(setting);
          // The catalog is durable and already contains the last coherent
          // projection. Probe it before scanning so reopening the view is a
          // read-only fingerprint check when the provider has not changed.
          // A changed source keeps its cached rows visible until replacement
          // succeeds; the loading status communicates that refresh is pending.
          const cachedFingerprint = store.getFingerprint(sourceId);
          if (cachedFingerprint !== undefined) {
            const currentFingerprint = await provider.probe(signal);
            if (signal.aborted || this.#disposed || !this.isEnabled()) return;
            if (currentFingerprint === cachedFingerprint) {
              store.markUpdateAvailable(sourceId, false);
              this.#sourceStatus.delete(sourceId);
              this.#transientEmptyScans.delete(sourceId);
              this.#changed.fire(undefined);
              continue;
            }
            store.markUpdateAvailable(sourceId, true);
            this.#changed.fire(undefined);
          }
          const scan = await provider.scan(signal, DEFAULT_SESSION_NAVIGATOR_BUDGET);
          if (signal.aborted || this.#disposed || !this.isEnabled()) return;
          if (!this.settings().some((current) => sourceIdFor(current) === sourceId)) continue;
          if (setting.provider === 'claude' && scan.snapshot.entities.length === 0 && scan.snapshot.truncated) {
            const attempts = this.#transientEmptyScans.get(sourceId) ?? 0;
            if (attempts < MAX_TRANSIENT_EMPTY_SCANS) {
              this.#transientEmptyScans.set(sourceId, attempts + 1);
              this.#sourceStatus.set(sourceId, { phase: 'loading', detail: 'Waiting for Claude metadata…' });
              this.#refreshAgain = true;
              this.#changed.fire(undefined);
              continue;
            }
          }
          this.#transientEmptyScans.delete(sourceId);
          const snapshot = {
            ...scan.snapshot,
            entities: scan.snapshot.entities.map((entity) => ({ ...entity, sourceId })),
            relations: scan.snapshot.relations.map((relation) => ({ ...relation, sourceId })),
          };
          store.replaceSnapshot(sourceId, { ...snapshot, ...(scan.nextCursor === undefined ? {} : { nextCursor: scan.nextCursor }) }, scan.fingerprint);
          // Claude stores child transcripts under parent-specific directories.
          // The activity order can place a child on page one and its parent on
          // page two; eagerly consume one continuation so the normal catalog
          // reconciliation can attach that child before the first render.
          if (setting.provider === 'claude' && provider.scanPage !== undefined) {
            let continuation = scan.nextCursor;
            let pages = 1;
            while (continuation !== undefined && pages < MAX_INITIAL_CLAUDE_PAGES) {
              const page = await provider.scanPage(signal, DEFAULT_SESSION_NAVIGATOR_BUDGET, continuation);
              if (signal.aborted || this.#disposed || !this.isEnabled()) return;
              if (!this.settings().some((current) => sourceIdFor(current) === sourceId)) break;
              const pageSnapshot = {
                ...page.snapshot,
                entities: page.snapshot.entities.map((entity) => ({ ...entity, sourceId })),
                relations: page.snapshot.relations.map((relation) => ({ ...relation, sourceId })),
              };
              store.appendSnapshot(sourceId, { ...pageSnapshot, ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) }, page.fingerprint);
              continuation = page.nextCursor;
              pages += 1;
            }
          }
          this.#sourceStatus.delete(sourceId);
          this.#changed.fire(undefined);
        } catch (error) {
          if (signal.aborted || this.#disposed) return;
          const detail = error instanceof Error ? error.message : String(error);
          this.#sourceStatus.set(sourceId, { phase: 'error', detail });
          this.#changed.fire(undefined);
          failures.push(sourceLabelFor(setting) + ': ' + detail);
        }
      }
      if (failures.length > 0) {
        void vscode.window.showWarningMessage('Session Navigator refresh incomplete. ' + failures.join(' | '));
      }
      this.#changed.fire(undefined);
    } catch (error) {
      if (signal.aborted || this.#disposed) return;
      void vscode.window.showErrorMessage('Session Navigator could not refresh: ' + (error instanceof Error ? error.message : String(error)));
    } finally {
      for (const [id, status] of this.#sourceStatus) if (status.phase === 'loading') this.#sourceStatus.delete(id);
    }
  }

  public async reveal(node: EntityTreeNode): Promise<void> {
    if (this.#disposed || !this.isEnabled()) return;
    const store = await this.ensureStore();
    const location = store.getLocation({
      sourceId: node.entity.sourceId,
      generation: node.entity.generation,
      nativeId: node.entity.nativeId,
    });
    const rootUriString = store.getSourceRoot(node.entity.sourceId);
    if (location === undefined || rootUriString === undefined) {
      void vscode.window.showWarningMessage('This navigation entry is stale. Refresh the Session Navigator.');
      return;
    }
    // Persisted locations from older candidates may contain an absolute alias
    // path. Never join those to a source root; a refresh rebuilds the projection.
    if (location.relativePath.length === 0 || isAbsolute(location.relativePath)
      || /^[A-Za-z]:/u.test(location.relativePath) || /^[\\/]/u.test(location.relativePath)
      || location.relativePath.split(/[\\/]+/u).includes('..')) {
      void vscode.window.showWarningMessage('This session location needs to be rebuilt. Refresh the Session Navigator.');
      return;
    }
    const setting = this.settings().find((candidate) => sourceIdFor(candidate) === node.entity.sourceId);
    if (setting === undefined) {
      void vscode.window.showWarningMessage('This navigation source is no longer authorized. Refresh the Session Navigator.');
      return;
    }
    try {
      const currentFingerprint = await this.providerFor(setting).probe(new AbortController().signal);
      if (this.#disposed || !this.isEnabled()) return;
      if (currentFingerprint !== store.getFingerprint(node.entity.sourceId)) {
        const sessionStart = (setting.provider === 'codex' || setting.provider === 'claude' || setting.provider === 'pi' || setting.provider === 'kimi') && location.rowOrdinal === '0';
        if (!sessionStart) {
          void vscode.window.showWarningMessage('This navigation entry is stale. Refresh the Session Navigator.');
          return;
        }
        store.markUpdateAvailable(node.entity.sourceId, true);
        this.#changed.fire(undefined);
      }
    } catch {
      void vscode.window.showWarningMessage('The authorized source file is no longer available.');
      return;
    }
    const configuredRoot = vscode.Uri.parse(rootUriString);
    const root = setting.provider === 'codex' && /state(?:_\d+)?\.sqlite$/iu.test(basename(configuredRoot.fsPath))
      ? vscode.Uri.file(dirname(configuredRoot.fsPath))
      : configuredRoot;
    const rootIsFile = await isRegularFile(root.fsPath);
    if (rootIsFile && basename(root.fsPath) !== location.relativePath) {
      void vscode.window.showWarningMessage('This navigation entry is stale. Refresh the Session Navigator.');
      return;
    }
    const target = rootIsFile ? root : vscode.Uri.joinPath(root, ...location.relativePath.split(/[\\/]+/u));
    const [canonicalRoot, canonicalTarget] = await Promise.all([realpath(root.fsPath).catch(() => undefined), realpath(target.fsPath).catch(() => undefined)]);
    if (canonicalRoot === undefined || canonicalTarget === undefined || !isContainedFile(canonicalRoot, canonicalTarget) || !(await isRegularFile(canonicalTarget))) {
      void vscode.window.showWarningMessage('The authorized source file is no longer available.');
      return;
    }
    if (this.#disposed || !this.isEnabled()
      || !this.settings().some((current) => sourceIdFor(current) === node.entity.sourceId)
      || store.getLocation({ sourceId: node.entity.sourceId, generation: node.entity.generation, nativeId: node.entity.nativeId }) === undefined) return;
    const canonicalUri = vscode.Uri.file(canonicalTarget);
    const intent: RevealIntent = {
      sourceId: node.entity.sourceId,
      catalogGeneration: node.entity.generation,
      nativeId: node.entity.nativeId,
      anchorOrdinal: location.rowOrdinal,
    };
    this.#revealRegistry.set(canonicalUri.toString(), intent);
    try {
      await vscode.commands.executeCommand('vscode.openWith', canonicalUri, 'jsonlView.editor');
    } catch (error) {
      this.#revealRegistry.clear(canonicalUri.toString());
      void vscode.window.showErrorMessage(`JsonlView could not open the selected source: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Resolve a safe local filesystem URI for either a source or an entity. */
  private async nodeUri(node: SessionNavigatorTreeNode): Promise<vscode.Uri | undefined> {
    if (this.#disposed || !this.isEnabled()) return undefined;
    if (node.nodeKind !== 'source' && node.nodeKind !== 'entity') return undefined;
    const store = await this.ensureStore();
    if (node.nodeKind === 'source') {
      const rootUriString = store.getSourceRoot(node.source.sourceId);
      if (rootUriString === undefined) return undefined;
      const root = vscode.Uri.parse(rootUriString);
      return root.scheme === 'file' ? root : undefined;
    }
    const location = store.getLocation({ sourceId: node.entity.sourceId, generation: node.entity.generation, nativeId: node.entity.nativeId });
    const rootUriString = store.getSourceRoot(node.entity.sourceId);
    if (location === undefined || rootUriString === undefined) return undefined;
    if (location.relativePath.length === 0 || isAbsolute(location.relativePath)
      || /^[A-Za-z]:/u.test(location.relativePath) || location.relativePath.startsWith('/') || location.relativePath.startsWith('\\')
      || location.relativePath.split(/[\\/]+/u).includes('..')) return undefined;
    const configuredRoot = vscode.Uri.parse(rootUriString);
    const root = node.entity.provider === 'codex' && /state(?:_\d+)?\.sqlite$/iu.test(basename(configuredRoot.fsPath))
      ? vscode.Uri.file(dirname(configuredRoot.fsPath))
      : configuredRoot;
    if (await isRegularFile(root.fsPath)) return basename(root.fsPath) === location.relativePath ? root : undefined;
    const target = vscode.Uri.joinPath(root, ...location.relativePath.split(/[\\/]+/u));
    const [canonicalRoot, canonicalTarget] = await Promise.all([realpath(root.fsPath).catch(() => undefined), realpath(target.fsPath).catch(() => undefined)]);
    if (canonicalRoot === undefined || canonicalTarget === undefined || !isContainedFile(canonicalRoot, canonicalTarget) || !(await isRegularFile(canonicalTarget))) return undefined;
    return vscode.Uri.file(canonicalTarget);
  }

  private async entityUri(node: SessionNavigatorTreeNode): Promise<vscode.Uri | undefined> {
    return node.nodeKind === 'entity' ? this.nodeUri(node) : undefined;
  }

  private async openEntity(node: SessionNavigatorTreeNode): Promise<void> {
    if (node.nodeKind === 'entity') await this.reveal(node);
  }

  private async openEntityWith(node: SessionNavigatorTreeNode): Promise<void> {
    const uri = await this.entityUri(node);
    if (uri !== undefined) await vscode.commands.executeCommand('vscode.openWith', uri, 'jsonlView.editor');
  }

  private async revealInFileExplorer(node: SessionNavigatorTreeNode): Promise<void> {
    const uri = await this.nodeUri(node);
    if (uri !== undefined) await vscode.commands.executeCommand('revealFileInOS', uri);
  }

  private async openInIntegratedTerminal(node: SessionNavigatorTreeNode): Promise<void> {
    const uri = await this.nodeUri(node);
    if (uri !== undefined) await vscode.commands.executeCommand('openInIntegratedTerminal', uri);
  }

  private async copyPath(node: SessionNavigatorTreeNode): Promise<void> {
    const uri = await this.nodeUri(node);
    if (uri !== undefined) await vscode.env.clipboard.writeText(uri.fsPath);
  }

  private async copyRelativePath(node: SessionNavigatorTreeNode): Promise<void> {
    const uri = await this.nodeUri(node);
    if (uri !== undefined) await vscode.env.clipboard.writeText(vscode.workspace.asRelativePath(uri, false));
  }

  private async openTimeline(node: SessionNavigatorTreeNode): Promise<void> {
    const uri = await this.entityUri(node);
    if (uri !== undefined) {
      await vscode.commands.executeCommand('vscode.open', uri);
      await vscode.commands.executeCommand('timeline.focus');
    }
  }

  private async copySessionId(node: SessionNavigatorTreeNode): Promise<void> {
    if (node.nodeKind === 'entity') await vscode.env.clipboard.writeText(node.entity.nativeId);
  }

  private previewForId(id: string): SessionPreview | undefined {
    return this.previews.list().find((preview) => preview.id === id);
  }

  private previewFromCommand(node: unknown): SessionPreview | undefined {
    if (node === null || typeof node !== 'object') return undefined;
    const candidate = node as { previewId?: unknown; id?: unknown };
    const id = typeof candidate.previewId === 'string' ? candidate.previewId : typeof candidate.id === 'string' ? candidate.id : undefined;
    return id === undefined ? undefined : this.previewForId(id);
  }

  private openPreview(node: unknown): Promise<void> | undefined {
    const preview = this.previewFromCommand(node);
    return preview === undefined ? undefined : this.previews.reopen(preview.id);
  }

  private savePreviewAs(node: unknown): Promise<'cancelled' | 'failed' | 'saved' | 'saved-open-failed'> | undefined {
    const preview = this.previewFromCommand(node);
    return preview === undefined ? undefined : this.previews.saveAs(preview.sourceUri);
  }

  private async openSavedPreviewCopy(node: unknown): Promise<void> {
    const preview = this.previewFromCommand(node);
    if (preview?.savedUri === undefined) return;
    try { await vscode.commands.executeCommand('vscode.openWith', preview.savedUri, 'jsonlView.editor'); }
    catch { void vscode.window.showErrorMessage('The saved preview copy could not be opened.'); }
  }

  public dispose(): void {
    this.#disposed = true;
    this.#scanController?.abort();
    this.invalidateAllSources();
    if (this.#probeTimer !== undefined) clearInterval(this.#probeTimer);
    this.#probeTimer = undefined;
    this.#store?.close();
    this.#store = undefined;
    this.#providers.clear();
    void this.#intake.dispose().catch(() => { /* Preserve any preview whose cleanup could not be verified. */ });
    this.#previewRegistration.dispose();
    void this.previews.dispose().catch(() => {});
    this.#changed.dispose();
  }

  private async ensureStore(): Promise<CatalogStore> {
    if (this.#store !== undefined) return this.#store;
    if (this.#openingStore !== undefined) return this.#openingStore;
    this.#openingStore = this.openStore();
    try { return await this.#openingStore; }
    finally { this.#openingStore = undefined; }
  }

  private async openStore(): Promise<CatalogStore> {
    const directory = vscode.Uri.joinPath(this.#context.globalStorageUri, 'session-navigator');
    await vscode.workspace.fs.createDirectory(directory);
    const store = await CatalogStore.open(vscode.Uri.joinPath(directory, 'catalog.sqlite').fsPath);
    if (this.#disposed) { store.close(); throw new Error('Session Navigator is disposed.'); }
    this.#store = store;
    if (this.isEnabled()) this.#store.syncSources(this.settings());
    return this.#store;
  }

  private configuredSources(): readonly AuthorizedSourceSetting[] {
    return parseAuthorizedSources(vscode.workspace.getConfiguration('jsonlView').get<unknown>(SOURCES_SETTING, []));
  }

  private settings(): readonly AuthorizedSourceSetting[] {
    if (!this.isEnabled()) return [];
    const configured = this.configuredSources();
    const excluded = new Set(this.#context.globalState.get<string[]>(EXCLUDED_SOURCES_KEY, []));
    return mergeSourceSettings(configured, []).filter((setting) => !excluded.has(sourceIdFor(setting)));
  }

  private isEnabled(): boolean {
    return vscode.workspace.getConfiguration('jsonlView').get<boolean>(ENABLED_SETTING, false);
  }

  private async setEnabled(enabled: boolean): Promise<boolean> {
    await vscode.workspace.getConfiguration('jsonlView').update(ENABLED_SETTING, enabled, vscode.ConfigurationTarget.Global);
    this.#changed.fire(undefined);
    return this.isEnabled() === enabled;
  }

  private providerFor(setting: AuthorizedSourceSetting): SessionNavigatorProvider {
    const id = sourceIdFor(setting);
    const existing = this.#providers.get(id);
    if (existing !== undefined) return existing;
    const provider = createSessionNavigatorProvider(setting);
    this.#providers.set(id, provider);
    return provider;
  }

  private addSource(): void {
    if (!this.#disposed) this.#intake.show();
  }

  private async authorizeAgent(cancelled = () => this.#disposed): Promise<void> {
    if (this.#disposed || cancelled()) return;
    const provider = await vscode.window.showQuickPick(
      SOURCE_PROVIDER_CHOICES,
      { placeHolder: 'Choose the source format to authorize' },
    );
    if (provider === undefined || this.#disposed || cancelled()) return;

    const detected = discoverDefaultSources().find((setting) => setting.provider === provider.value);
    if (detected !== undefined) {
      try { await this.authorizeSourceSetting(detected); }
      catch (error) { if (!this.#disposed && !cancelled()) void vscode.window.showWarningMessage(error instanceof Error ? error.message : 'Source authorization was not confirmed.'); }
      return;
    }

    const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: true, canSelectMany: false, openLabel: 'Authorize source' });
    const uri = picked?.[0];
    if (uri === undefined || this.#disposed || cancelled()) return;
    try {
      const canonical = await validateLocalSourceUri(uri.toString());
      if (!this.#disposed && !cancelled()) {
        try { await this.authorizeSourceUri(provider.value, canonical, cancelled); }
        catch (error) { if (!this.#disposed && !cancelled()) void vscode.window.showWarningMessage(error instanceof Error ? error.message : 'Source authorization was not confirmed.'); }
      }
    } catch (error) {
      if (!this.#disposed) void vscode.window.showWarningMessage(error instanceof Error ? error.message : String(error));
    }
  }

  private async authorizeDetectedAgent(provider: DetectedAgentProviderId, signal: AbortSignal): Promise<void> {
    if (this.#disposed || signal.aborted) return;
    const detected = discoverDefaultSources().find((setting) => setting.provider === provider);
    if (detected === undefined) {
      throw new Error('No ' + sessionNavigatorProviderLabel(provider) + ' home was detected. Use Files or Folder to choose a local source.');
    }
    await this.authorizeSourceSetting(detected, () => this.#disposed || signal.aborted);
  }

  private async authorizeSourceUri(provider: AuthorizedSourceSetting['provider'], uri: vscode.Uri, cancelled = () => false): Promise<void> {
    await this.authorizeSourceSetting({ provider, rootUri: uri.toString(true) }, cancelled);
  }

  private async authorizeSourceSetting(setting: AuthorizedSourceSetting, cancelled = () => false): Promise<void> {
    if (this.#disposed || cancelled()) return;
    const sourceId = sourceIdFor(setting);
    const excluded = this.#context.globalState.get<string[]>(EXCLUDED_SOURCES_KEY, []);
    const nextExcluded = excluded.filter((id) => id !== sourceId);
    await this.#context.globalState.update(EXCLUDED_SOURCES_KEY, nextExcluded);
    if (this.#disposed || cancelled()) return;
    const current = this.configuredSources();
    const alreadyAuthorized = current.some((candidate) => sourceIdFor(candidate) === sourceId);
    const next = parseAuthorizedSources([...current, setting]);
    try {
      await vscode.workspace.getConfiguration('jsonlView').update(SOURCES_SETTING, next, vscode.ConfigurationTarget.Global);
    } catch (error) {
      // A failed config write must not leave the exclusion registry claiming
      // that authorization committed. Restore its prior value best-effort.
      await this.#context.globalState.update(EXCLUDED_SOURCES_KEY, excluded);
      throw error;
    }
    const effective = this.configuredSources();
    if (this.#disposed || cancelled()) {
      // A cancellation after the VS Code write still has to obey the no-change
      // contract. Roll back only when the effective list is exactly the list we
      // wrote; an external concurrent edit remains authoritative.
      if (!alreadyAuthorized && sameSourceSettings(effective, next)) {
        await vscode.workspace.getConfiguration('jsonlView').update(SOURCES_SETTING, current, vscode.ConfigurationTarget.Global);
      }
      if (!alreadyAuthorized) await this.#context.globalState.update(EXCLUDED_SOURCES_KEY, excluded);
      return;
    }
    if (!effective.some((candidate) => sourceIdFor(candidate) === sourceId)) {
      await this.#context.globalState.update(EXCLUDED_SOURCES_KEY, excluded);
      throw new Error('Source authorization was not confirmed by the effective VS Code settings.');
    }
    this.#changed.fire(undefined);
    if (this.isEnabled()) await this.refresh();
  }

  private async handleDrop(target: SessionNavigatorTreeNode | undefined, dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): Promise<void> {
    if (token.isCancellationRequested) return;
    const candidates: vscode.Uri[] = [];
    dataTransfer.forEach((item) => { const file = item.asFile(); if (file?.uri?.scheme === 'file') candidates.push(file.uri); });
    const uriList = dataTransfer.get('text/uri-list');
    if (uriList !== undefined) {
      const text = await uriList.asString();
      for (const line of text.split(/\r?\n/u)) {
        const value = line.trim();
        if (value.length === 0 || value.startsWith('#')) continue;
        try {
          const uri = vscode.Uri.parse(value);
          if (uri.scheme === 'file') candidates.push(uri);
        } catch { /* Ignore malformed transfer items. */ }
      }
    }
    const uri = candidates.find((candidate) => candidate.scheme === 'file' && isAbsolute(candidate.fsPath));
    if (uri === undefined) {
      void vscode.window.showWarningMessage('No local file or folder was found in the drop.');
      return;
    }
    await this.confirmCustomSource(uri, () => token.isCancellationRequested);
  }

  private async confirmCustomSource(uri: vscode.Uri, cancelled: () => boolean): Promise<void> {
    if (cancelled() || this.#disposed) return;
    let canonical: vscode.Uri;
    try { canonical = await validateLocalSourceUri(uri.toString()); }
    catch (error) {
      if (!cancelled() && !this.#disposed) void vscode.window.showWarningMessage(error instanceof Error ? error.message : String(error));
      return;
    }
    if (cancelled() || this.#disposed) return;
    const action = await vscode.window.showWarningMessage(
      `Add ${canonical.fsPath} as a read-only source?`,
      { modal: true },
      'Add source',
    );
    if (action !== 'Add source' || cancelled() || this.#disposed) return;
    const provider = await vscode.window.showQuickPick(
      SOURCE_PROVIDER_CHOICES,
      { placeHolder: 'Choose the source format to authorize' },
    );
    if (provider !== undefined && !cancelled() && !this.#disposed) await this.authorizeSourceUri(provider.value, canonical, cancelled);
  }

  private async removeSource(node?: SessionNavigatorTreeNode): Promise<void> {
    const current = parseAuthorizedSources(vscode.workspace.getConfiguration('jsonlView').get<unknown>(SOURCES_SETTING, []));
    const sourceId = node?.nodeKind === 'source' ? node.source.sourceId : node?.nodeKind === 'entity' ? node.entity.sourceId : undefined;
    if (sourceId === undefined) return;
    const removed = this.settings().find((setting) => sourceIdFor(setting) === sourceId);
    const sameDefault = removed === undefined ? undefined : discoverDefaultSources().find((setting) =>
      sourceIdFor({ provider: setting.provider, rootUri: setting.rootUri }) === sourceIdFor({ provider: removed.provider, rootUri: removed.rootUri }),
    );
    this.#scanController?.abort();
    this.invalidateSource(sourceId);
    const excluded = this.#context.globalState.get<string[]>(EXCLUDED_SOURCES_KEY, []);
    await this.#context.globalState.update(EXCLUDED_SOURCES_KEY, [...new Set([...excluded, sourceId, ...(sameDefault === undefined ? [] : [sourceIdFor(sameDefault)])])]);
    const next = current.filter((setting) => sourceIdFor(setting) !== sourceId);
    await vscode.workspace.getConfiguration('jsonlView').update(SOURCES_SETTING, next, vscode.ConfigurationTarget.Global);
    this.#store?.syncSources(this.settings());
    this.#providers.delete(sourceId);
    this.#sourceStatus.delete(sourceId);
    this.#changed.fire(undefined);
  }

  private handleVisibility(visible: boolean): void {
    if (visible && this.isEnabled()) {
      if (this.#probeTimer === undefined) this.#probeTimer = setInterval(() => { void this.probeVisibleSources(); }, PROBE_INTERVAL_MS);
      if (!this.#initialized) {
        this.#initialized = true;
        if (this.#scanController?.signal.aborted) this.#refreshAgain = true;
        void this.refresh();
      }
    } else {
      if (this.#scanController !== undefined || [...this.#sourceStatus.values()].some((status) => status.phase === 'error')) this.#initialized = false;
      this.#scanController?.abort();
      this.invalidateAllSources();
      if (this.#probeTimer !== undefined) clearInterval(this.#probeTimer);
      this.#probeTimer = undefined;
    }
  }

  private sortKey(): SessionNavigatorSortKey {
    const value = vscode.workspace.getConfiguration('jsonlView').get<unknown>(SORT_SETTING, 'activity');
    return value === 'created' || value === 'title' ? value : 'activity';
  }

  private async setSort(value: SessionNavigatorSortKey): Promise<void> {
    await vscode.workspace.getConfiguration('jsonlView').update(SORT_SETTING, value, vscode.ConfigurationTarget.Global);
    this.#changed.fire(undefined);
  }

  private async chooseSort(): Promise<void> {
    const choices: Array<{ label: string; value: SessionNavigatorSortKey; description?: string }> = [
      { label: 'Recent activity', value: 'activity' },
      { label: 'Created time', value: 'created' },
      { label: 'Title', value: 'title' },
    ];
    const selected = await vscode.window.showQuickPick(choices.map((choice) => ({ ...choice, ...(choice.value === this.sortKey() ? { description: 'Current' } : {}) })), { title: 'Sort sessions', placeHolder: 'Choose how sessions are ordered' });
    if (selected !== undefined) await this.setSort(selected.value);
  }

  public open(target?: NavigatorBridgeTarget): Promise<NavigatorBridgeResult> {
    if (this.#opening !== undefined) return this.#opening;
    const operation = this.openNavigator(target).finally(() => { this.#opening = undefined; });
    this.#opening = operation;
    return operation;
  }

  private async openSettings(): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'jsonlView.sessionNavigator.enabled');
  }

  private async focusNavigatorView(viewId: 'jsonlView.sourceDrop' | 'jsonlView.sessionNavigator'): Promise<boolean> {
    try {
      await vscode.commands.executeCommand('workbench.view.extension.jsonlViewSessionNavigator');
    } catch {
      return false;
    }
    // The Add Source view is intentionally focused only for the missing-auth
    // route. An authorized open keeps VS Code's current tree selection intact.
    if (viewId === 'jsonlView.sourceDrop') {
      try { await vscode.commands.executeCommand('workbench.action.focusView', viewId); }
      catch { /* The container remains a useful fallback on older VS Code hosts. */ }
    }
    return true;
  }

  private async openNavigator(target?: NavigatorBridgeTarget): Promise<NavigatorBridgeResult> {
    const disabled = (status: NavigatorBridgeResult['status'], errorCode?: NavigatorBridgeResult['errorCode']): NavigatorBridgeResult => ({
      version: 1, status, enabled: 'disabled', authorization: 'not-requested', authorizationReadback: 'not-requested', action: 'none',
      ...(errorCode === undefined ? {} : { errorCode }), stage: 'enablement', recoverable: status !== 'failed',
    });
    if (this.#disposed) return disabled('cancelled');
    if (!this.isEnabled()) {
      const action = await vscode.window.showInformationMessage(
        'Enable the built-in Session Navigator? This choice is remembered.',
        { modal: true },
        'Enable',
        'Settings',
      );
      if (this.#disposed) return disabled('cancelled');
      if (action === 'Settings') { await this.openSettings(); return disabled('cancelled'); }
      if (action !== 'Enable') return disabled('cancelled');
      if (!await this.setEnabled(true)) {
        return {
          version: 1, status: 'failed', enabled: 'unknown', authorization: 'not-requested', authorizationReadback: 'unknown', action: 'request-enable',
          errorCode: 'ENABLEMENT_NOT_CONFIRMED', stage: 'enablement', recoverable: true,
        };
      }
      if (!this.isEnabled()) {
        void vscode.window.showInformationMessage(
          'Session Navigator is disabled by an effective workspace setting. Enable it in Settings.',
          { modal: true },
          'Settings',
        ).then((choice) => { if (choice === 'Settings') void this.openSettings(); });
        return disabled('failed', 'NAVIGATOR_DISABLED');
      }
    }
    if (this.#disposed) return disabled('cancelled');
    const authorized = this.settings().length > 0;
    const sourceId = target === undefined ? undefined : this.sourceIdForTarget(target.sourceUri);
    if (target !== undefined && sourceId === undefined) {
      const focused = await this.focusNavigatorView('jsonlView.sourceDrop');
      if (focused && this.#treeView !== undefined) this.#treeView.message = 'Authorize the source containing this file in Add Source to link it to Navigator.';
      return {
        version: 1, status: 'authorization-required', enabled: 'enabled', authorization: 'required', authorizationReadback: 'not-requested',
        action: 'focus-add-source', errorCode: 'AUTHORIZATION_REQUIRED', stage: 'authorization', recoverable: true,
      };
    }
    const opened = await this.focusNavigatorView('jsonlView.sessionNavigator');
    if (!opened) {
      return {
        version: 1, status: 'failed', enabled: 'enabled', authorization: 'granted', authorizationReadback: 'confirmed', action: 'focus-sessions',
        errorCode: 'OPEN_FAILED', stage: 'focus', recoverable: true,
      };
    }
    const authorization = authorized ? 'granted' : 'not-requested';
    const authorizationReadback = authorized ? 'confirmed' : 'not-requested';
    return {
      version: 1, status: 'opened', enabled: 'enabled', authorization, authorizationReadback, action: 'focus-sessions',
      ...(target === undefined ? {} : { targetDocumentId: target.documentId }),
      ...(sourceId === undefined ? {} : { sourceId }),
    };
  }

  private sourceIdForTarget(sourceUri: string): string | undefined {
    let sourcePath: string;
    try {
      sourcePath = resolve(vscode.Uri.parse(sourceUri).fsPath);
    } catch {
      return undefined;
    }
    for (const setting of this.settings()) {
      try {
        const rootPath = resolve(vscode.Uri.parse(setting.rootUri).fsPath);
        if (isContainedFile(rootPath, sourcePath)) return sourceIdFor(setting);
      } catch {
        // An invalid source setting is filtered by parseAuthorizedSources; keep
        // this bridge fail-closed if a host override is malformed at runtime.
      }
    }
    return undefined;
  }

  private async probeVisibleSources(): Promise<void> {
    if (this.#disposed || !this.#treeView?.visible || !this.isEnabled()) return;
    try {
      const store = await this.ensureStore();
      for (const setting of this.settings()) {
        const sourceId = sourceIdFor(setting);
        const provider = this.providerFor(setting);
        try {
          const fingerprint = await provider.probe(new AbortController().signal);
          if (this.#disposed || !this.isEnabled() || !this.#treeView?.visible) return;
          const previous = store.getFingerprint(sourceId);
          if (previous !== undefined) store.markUpdateAvailable(sourceId, fingerprint !== previous);
        } catch {
          // Background hints are advisory; explicit refresh remains authoritative.
        }
      }
      this.#changed.fire(undefined);
    } catch {
      // A background hint must never surface an unhandled timer rejection.
    }
  }
}

function sameSourceSettings(left: readonly AuthorizedSourceSetting[], right: readonly AuthorizedSourceSetting[]): boolean {
  const keys = (values: readonly AuthorizedSourceSetting[]) => values.map(sourceIdFor).sort();
  return JSON.stringify(keys(left)) === JSON.stringify(keys(right));
}

function isContainedFile(rootPath: string, targetPath: string): boolean {
  const root = resolve(rootPath);
  const target = resolve(targetPath);
  const suffix = relative(root, target);
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`));
}

async function isRegularFile(path: string): Promise<boolean> {
  try { return (await lstat(path)).isFile(); } catch { return false; }
}
function pageFlightKey(sourceId: string, generation: string, cursor: string): string {
  return sourceId + '\u0000' + generation + '\u0000' + cursor;
}

function childrenFlightKey(value: { readonly sourceId: string; readonly generation: string; readonly parentNativeId: string | undefined; readonly sortKey: SessionNavigatorSortKey; readonly cursor: string; readonly epoch: number }): string {
  return value.sourceId + '\u0000children\u0000' + JSON.stringify([value.generation, value.parentNativeId ?? null, value.sortKey, value.cursor, value.epoch]);
}

function relativeTime(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '';
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return String(minutes) + 'm ago';
  if (minutes < 1_440) return String(Math.floor(minutes / 60)) + 'h ago';
  return String(Math.floor(minutes / 1_440)) + 'd ago';
}
