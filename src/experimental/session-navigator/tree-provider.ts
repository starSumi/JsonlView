import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import * as vscode from 'vscode';
import { CatalogStore } from './catalog-store';
import { createSessionNavigatorProvider } from './file-provider';
import { discoverDefaultSources, mergeSourceSettings, parseAuthorizedSources, sourceIdFor, sourceLabelFor } from './source-config';
import { RevealIntentRegistry } from './reveal-intents';
import { SourceIntakePanel, validateLocalSourceUri } from './source-intake';
import { DEFAULT_SESSION_NAVIGATOR_BUDGET, type AuthorizedSourceSetting, type NavigatorEntity, type NavigatorSourceSummary, type RevealIntent, type SessionNavigatorProvider, type SessionNavigatorSortKey } from './types';

const SOURCES_SETTING = 'sessionNavigator.sources';
const ENABLED_SETTING = 'sessionNavigator.enabled';
const SORT_SETTING = 'sessionNavigator.sort';
const PROBE_INTERVAL_MS = 30_000;
const MAX_TRANSIENT_EMPTY_SCANS = 2;
const MAX_INITIAL_CLAUDE_PAGES = 2;
const EXCLUDED_SOURCES_KEY = 'sessionNavigator.excludedDefaultSources';

interface SourceTreeNode {
  readonly nodeKind: 'source';
  readonly source: NavigatorSourceSummary;
}

interface EntityTreeNode {
  readonly nodeKind: 'entity';
  readonly entity: NavigatorEntity;
}

interface SourceStatus { phase: 'loading' | 'error'; detail?: string }

export type SessionNavigatorTreeNode = SourceTreeNode | EntityTreeNode;

export class SessionNavigatorTreeProvider implements vscode.TreeDataProvider<SessionNavigatorTreeNode>, vscode.Disposable {
  readonly #context: vscode.ExtensionContext;
  readonly #revealRegistry: RevealIntentRegistry;
  readonly #changed = new vscode.EventEmitter<SessionNavigatorTreeNode | undefined | null | void>();
  readonly #providers = new Map<string, SessionNavigatorProvider>();
  readonly #sourceStatus = new Map<string, SourceStatus>();
  readonly #intake: SourceIntakePanel;
  #store: CatalogStore | undefined;
  #openingStore: Promise<CatalogStore> | undefined;
  #refreshing: Promise<void> | undefined;
  #scanController: AbortController | undefined;
  #refreshAgain = false;
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

  public readonly onDidChangeTreeData = this.#changed.event;

  public constructor(context: vscode.ExtensionContext, revealRegistry: RevealIntentRegistry) {
    this.#context = context;
    this.#revealRegistry = revealRegistry;
    this.#intake = new SourceIntakePanel(
      (uri, signal) => this.confirmCustomSource(uri, () => signal.aborted),
      (provider, signal) => this.authorizeDetectedAgent(provider, signal),
    );
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
      vscode.commands.registerCommand('jsonlView.sessionNavigator.enable', () => this.setEnabled(true)),
      vscode.commands.registerCommand('jsonlView.sessionNavigator.disable', () => this.setEnabled(false)),
      vscode.commands.registerCommand('jsonlView.sessionNavigator.open', () => this.open()),
      vscode.commands.registerCommand('jsonlView.sessionNavigator.sortActivity', () => this.setSort('activity')),
      vscode.commands.registerCommand('jsonlView.sessionNavigator.sortCreated', () => this.setSort('created')),
      vscode.commands.registerCommand('jsonlView.sessionNavigator.sortTitle', () => this.setSort('title')),
      vscode.commands.registerCommand('jsonlView.sessionNavigator.sort', () => this.chooseSort()),
      vscode.commands.registerCommand('jsonlView.sessionNavigator.addSourceFromClipboard', () => this.addSource()),
      vscode.commands.registerCommand('jsonlView.revealSessionNode', (node: EntityTreeNode) => this.reveal(node)),
      this.#treeView.onDidChangeVisibility((event) => this.handleVisibility(event.visible)),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('jsonlView.sessionNavigator')) {
          if (event.affectsConfiguration('jsonlView.' + SOURCES_SETTING) || event.affectsConfiguration('jsonlView.' + ENABLED_SETTING)) {
            this.#scanController?.abort();
            this.#refreshAgain = true;
            this.#initialized = false;
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
    item.contextValue = `jsonlView.sessionNavigator.${node.entity.kind}`;
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
    if (this.#disposed || !this.isEnabled()) return [];
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
      return store.listSources().map((source) => ({ nodeKind: 'source', source } satisfies SourceTreeNode));
    }
    if (node.nodeKind === 'source') {
      return store.getChildren(node.source.sourceId, undefined, this.sortKey()).map((entity) => ({ nodeKind: 'entity', entity } satisfies EntityTreeNode));
    }
    return store.getChildren(node.entity.sourceId, node.entity.nativeId, this.sortKey()).map((entity) => ({ nodeKind: 'entity', entity } satisfies EntityTreeNode));
  }

  public async refresh(): Promise<void> {
    if (this.#disposed || !this.isEnabled()) return;
    if (this.#refreshing !== undefined) return this.#refreshing;
    if (this.#treeView) this.#treeView.message = 'Loading sessions…';
    this.#changed.fire(undefined);
    this.#refreshing = Promise.resolve(vscode.window.withProgress({ location: { viewId: 'jsonlView.sessionNavigator' } }, () => this.runRefreshes()));
    try { await this.#refreshing; }
    finally {
      this.#refreshing = undefined;
      if (!this.#disposed && this.#treeView) {
        this.#treeView.message = [...this.#sourceStatus.values()].some((status) => status.phase === 'error')
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
    const setting = this.settings().find((candidate) => sourceIdFor(candidate) === node.source.sourceId);
    if (setting === undefined) return;
    const controller = new AbortController();
    this.#sourceStatus.set(node.source.sourceId, { phase: 'loading' });
    this.#changed.fire(undefined);
    try {
      const provider = this.providerFor(setting);
      const page = provider.scanPage === undefined ? await provider.scan(controller.signal, DEFAULT_SESSION_NAVIGATOR_BUDGET) : await provider.scanPage(controller.signal, DEFAULT_SESSION_NAVIGATOR_BUDGET, cursor);
      if (this.#disposed || !this.isEnabled()) return;
      store.appendSnapshot(node.source.sourceId, { ...page.snapshot, ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) }, page.fingerprint);
    } catch (error) {
      if (!this.#disposed) this.#sourceStatus.set(node.source.sourceId, { phase: 'error', detail: error instanceof Error ? error.message : String(error) });
    } finally {
      this.#sourceStatus.delete(node.source.sourceId);
      this.#changed.fire(undefined);
    }
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
        const sessionStart = (setting.provider === 'codex' || setting.provider === 'claude') && location.rowOrdinal === '0';
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

  public dispose(): void {
    this.#disposed = true;
    this.#scanController?.abort();
    if (this.#probeTimer !== undefined) clearInterval(this.#probeTimer);
    this.#probeTimer = undefined;
    this.#store?.close();
    this.#store = undefined;
    this.#providers.clear();
    void this.#intake.dispose().catch(() => { /* Preserve any preview whose cleanup could not be verified. */ });
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

  private settings(): readonly AuthorizedSourceSetting[] {
    if (!this.isEnabled()) return [];
    const configured = parseAuthorizedSources(vscode.workspace.getConfiguration('jsonlView').get<unknown>(SOURCES_SETTING, []));
    const excluded = new Set(this.#context.globalState.get<string[]>(EXCLUDED_SOURCES_KEY, []));
    return mergeSourceSettings(configured).filter((setting) => !excluded.has(sourceIdFor(setting)));
  }

  private isEnabled(): boolean {
    return vscode.workspace.getConfiguration('jsonlView').get<boolean>(ENABLED_SETTING, false);
  }

  private async setEnabled(enabled: boolean): Promise<void> {
    await vscode.workspace.getConfiguration('jsonlView').update(ENABLED_SETTING, enabled, vscode.ConfigurationTarget.Global);
    this.#changed.fire(undefined);
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

  private async authorizeAgent(): Promise<void> {
    if (this.#disposed) return;
    const provider = await vscode.window.showQuickPick(
      [{ label: 'Codex', value: 'codex' as const }, { label: 'Claude', value: 'claude' as const }, { label: 'Generic JSONL', value: 'generic' as const }],
      { placeHolder: 'Choose the source format to authorize' },
    );
    if (provider === undefined || this.#disposed) return;

    const detected = discoverDefaultSources().find((setting) => setting.provider === provider.value);
    if (detected !== undefined) {
      await this.authorizeSourceSetting(detected);
      return;
    }

    const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: true, canSelectMany: false, openLabel: 'Authorize source' });
    const uri = picked?.[0];
    if (uri === undefined || this.#disposed) return;
    try {
      const canonical = await validateLocalSourceUri(uri.toString());
      if (!this.#disposed) await this.authorizeSourceUri(provider.value, canonical);
    } catch (error) {
      if (!this.#disposed) void vscode.window.showWarningMessage(error instanceof Error ? error.message : String(error));
    }
  }

  private async authorizeDetectedAgent(provider: 'codex' | 'claude', signal: AbortSignal): Promise<void> {
    if (this.#disposed || signal.aborted) return;
    const detected = discoverDefaultSources().find((setting) => setting.provider === provider);
    if (detected === undefined) throw new Error('No ' + (provider === 'codex' ? 'Codex' : 'Claude') + ' home was detected. Use Files or Folder to choose a local source.');
    await this.authorizeSourceSetting(detected, () => this.#disposed || signal.aborted);
  }

  private async authorizeSourceUri(provider: AuthorizedSourceSetting['provider'], uri: vscode.Uri, cancelled = () => false): Promise<void> {
    await this.authorizeSourceSetting({ provider, rootUri: uri.toString(true) }, cancelled);
  }

  private async authorizeSourceSetting(setting: AuthorizedSourceSetting, cancelled = () => false): Promise<void> {
    if (this.#disposed || cancelled()) return;
    const sourceId = sourceIdFor(setting);
    const excluded = this.#context.globalState.get<string[]>(EXCLUDED_SOURCES_KEY, []);
    await this.#context.globalState.update(EXCLUDED_SOURCES_KEY, excluded.filter((id) => id !== sourceId));
    if (this.#disposed || cancelled()) return;
    const current = parseAuthorizedSources(vscode.workspace.getConfiguration('jsonlView').get<unknown>(SOURCES_SETTING, []));
    const isDefault = discoverDefaultSources().some((candidate) => sourceIdFor(candidate) === sourceId);
    const next = parseAuthorizedSources(isDefault ? current : [...current, setting]);
    await vscode.workspace.getConfiguration('jsonlView').update(SOURCES_SETTING, next, vscode.ConfigurationTarget.Global);
    if (this.#disposed || cancelled()) return;
    await this.setEnabled(true);
    if (this.#disposed || cancelled()) return;
    this.#changed.fire(undefined);
    await this.refresh();
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
    const action = await vscode.window.showWarningMessage(`Add ${canonical.fsPath} as a read-only source?`, 'Add source');
    if (action !== 'Add source' || cancelled() || this.#disposed) return;
    const provider = await vscode.window.showQuickPick(
      [{ label: 'Codex', value: 'codex' as const }, { label: 'Claude', value: 'claude' as const }, { label: 'Generic JSONL', value: 'generic' as const }],
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

  public async open(): Promise<void> {
    if (!this.isEnabled()) await this.setEnabled(true);
    if (this.settings().length === 0) {
      const action = await vscode.window.showInformationMessage('Session Navigator is ready. Authorize a local Agent source to populate it.', 'Authorize source');
      if (action === 'Authorize source') await this.addSource();
    }
    try {
      await vscode.commands.executeCommand('workbench.view.extension.jsonlViewSessionNavigator');
    } catch {
      void vscode.window.showInformationMessage('Session Navigator is enabled. Open the Agent Sessions view from the Activity Bar.');
    }
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

function isContainedFile(rootPath: string, targetPath: string): boolean {
  const root = resolve(rootPath);
  const target = resolve(targetPath);
  const suffix = relative(root, target);
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`));
}

async function isRegularFile(path: string): Promise<boolean> {
  try { return (await lstat(path)).isFile(); } catch { return false; }
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
