import { basename, dirname, relative, resolve, sep } from 'node:path';
import { lstat } from 'node:fs/promises';
import * as vscode from 'vscode';
import { CatalogStore } from './catalog-store';
import { createSessionNavigatorProvider } from './file-provider';
import { parseAuthorizedSources, sourceIdFor, sourceLabelFor } from './source-config';
import { RevealIntentRegistry } from './reveal-intents';
import { DEFAULT_SESSION_NAVIGATOR_BUDGET, type AuthorizedSourceSetting, type NavigatorEntity, type NavigatorSourceSummary, type RevealIntent, type SessionNavigatorProvider, type SessionNavigatorSortKey } from './types';

const SOURCES_SETTING = 'sessionNavigator.sources';
const ENABLED_SETTING = 'sessionNavigator.enabled';
const SORT_SETTING = 'sessionNavigator.sort';
const PROBE_INTERVAL_MS = 30_000;

interface SourceTreeNode {
  readonly nodeKind: 'source';
  readonly source: NavigatorSourceSummary;
}

interface EntityTreeNode {
  readonly nodeKind: 'entity';
  readonly entity: NavigatorEntity;
}

export type SessionNavigatorTreeNode = SourceTreeNode | EntityTreeNode;

export class SessionNavigatorTreeProvider implements vscode.TreeDataProvider<SessionNavigatorTreeNode>, vscode.Disposable {
  readonly #context: vscode.ExtensionContext;
  readonly #revealRegistry: RevealIntentRegistry;
  readonly #changed = new vscode.EventEmitter<SessionNavigatorTreeNode | undefined | null | void>();
  readonly #providers = new Map<string, SessionNavigatorProvider>();
  #store: CatalogStore | undefined;
  #treeView: vscode.TreeView<SessionNavigatorTreeNode> | undefined;
  #probeTimer: NodeJS.Timeout | undefined;
  #disposed = false;

  public readonly onDidChangeTreeData = this.#changed.event;

  public constructor(context: vscode.ExtensionContext, revealRegistry: RevealIntentRegistry) {
    this.#context = context;
    this.#revealRegistry = revealRegistry;
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
      vscode.commands.registerCommand('jsonlView.sessionNavigator.refresh', () => this.refresh()),
      vscode.commands.registerCommand('jsonlView.sessionNavigator.addSource', () => this.addSource()),
      vscode.commands.registerCommand('jsonlView.sessionNavigator.removeSource', (node?: SessionNavigatorTreeNode) => this.removeSource(node)),
      vscode.commands.registerCommand('jsonlView.sessionNavigator.enable', () => this.setEnabled(true)),
      vscode.commands.registerCommand('jsonlView.sessionNavigator.disable', () => this.setEnabled(false)),
      vscode.commands.registerCommand('jsonlView.sessionNavigator.open', () => this.open()),
      vscode.commands.registerCommand('jsonlView.sessionNavigator.sortActivity', () => this.setSort('activity')),
      vscode.commands.registerCommand('jsonlView.sessionNavigator.sortCreated', () => this.setSort('created')),
      vscode.commands.registerCommand('jsonlView.sessionNavigator.sortTitle', () => this.setSort('title')),
      vscode.commands.registerCommand('jsonlView.sessionNavigator.addSourceFromClipboard', () => this.addSourceFromClipboard()),
      vscode.commands.registerCommand('jsonlView.revealSessionNode', (node: EntityTreeNode) => this.reveal(node)),
      this.#treeView.onDidChangeVisibility((event) => this.handleVisibility(event.visible)),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('jsonlView.sessionNavigator')) this.#changed.fire(undefined);
      }),
    ];
    this.handleVisibility(this.#treeView.visible);
    return subscriptions;
  }

  public getTreeItem(node: SessionNavigatorTreeNode): vscode.TreeItem {
    if (node.nodeKind === 'source') {
      const item = new vscode.TreeItem(node.source.label, node.source.entityCount > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None);
      item.id = `source:${node.source.sourceId}`;
      item.contextValue = 'jsonlView.sessionNavigator.source';
      item.description = node.source.provider + ' · ' + String(node.source.entityCount) + (node.source.lastActivityAt === undefined ? '' : ' · last ' + compactTime(node.source.lastActivityAt)) + (node.source.updateAvailable ? ' · update available' : '');
      item.tooltip = node.source.updateAvailable ? node.source.label + ' has new metadata. Refresh explicitly.' : node.source.label + ' · read-only metadata projection';
      return item;
    }
    const hasChildren = this.#store?.hasChildren(node.entity.sourceId, node.entity.nativeId) ?? false;
    const item = new vscode.TreeItem(node.entity.label, hasChildren
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None);
    item.id = `entity:${node.entity.sourceId}:${node.entity.nativeId}`;
    item.contextValue = `jsonlView.sessionNavigator.${node.entity.kind}`;
    item.description = [node.entity.status ?? node.entity.kind, node.entity.relationship, shortId(node.entity.nativeId), node.entity.activityAt === undefined ? undefined : compactTime(node.entity.activityAt)].filter((value): value is string => value !== undefined).join(' · ');
    item.tooltip = [node.entity.label, node.entity.vendorTitle === undefined ? undefined : 'provider title: ' + node.entity.vendorTitle, node.entity.firstMessagePreview === undefined ? undefined : 'preview: ' + node.entity.firstMessagePreview, 'id: ' + node.entity.nativeId].filter((value): value is string => value !== undefined).join('\n');
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
    if (node === undefined) {
      return store.listSources().map((source) => ({ nodeKind: 'source', source } satisfies SourceTreeNode));
    }
    if (node.nodeKind === 'source') {
      return store.getChildren(node.source.sourceId, undefined, this.sortKey()).map((entity) => ({ nodeKind: 'entity', entity } satisfies EntityTreeNode));
    }
    return store.getChildren(node.entity.sourceId, node.entity.nativeId, this.sortKey()).map((entity) => ({ nodeKind: 'entity', entity } satisfies EntityTreeNode));
  }

  public async refresh(): Promise<void> {
    if (this.#disposed || !this.isEnabled()) return;
    try {
      const store = await this.ensureStore();
      const settings = this.settings();
      store.syncSources(settings);
      const failures: string[] = [];
      for (const setting of settings) {
        const sourceId = sourceIdFor(setting);
        try {
          const provider = this.providerFor(setting);
          const scan = await provider.scan(new AbortController().signal, DEFAULT_SESSION_NAVIGATOR_BUDGET);
          const snapshot = {
            ...scan.snapshot,
            entities: scan.snapshot.entities.map((entity) => ({ ...entity, sourceId })),
            relations: scan.snapshot.relations.map((relation) => ({ ...relation, sourceId })),
          };
          store.replaceSnapshot(sourceId, snapshot, scan.fingerprint);
        } catch (error) {
          failures.push(sourceLabelFor(setting) + ': ' + (error instanceof Error ? error.message : String(error)));
        }
      }
      if (failures.length > 0) {
        void vscode.window.showWarningMessage('Session Navigator refresh incomplete. ' + failures.join(' | '));
      }
      this.#changed.fire(undefined);
    } catch (error) {
      void vscode.window.showErrorMessage('Session Navigator could not refresh: ' + (error instanceof Error ? error.message : String(error)));
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
    const setting = this.settings().find((candidate) => sourceIdFor(candidate) === node.entity.sourceId);
    if (setting === undefined) {
      void vscode.window.showWarningMessage('This navigation source is no longer authorized. Refresh the Session Navigator.');
      return;
    }
    try {
      const currentFingerprint = await this.providerFor(setting).probe(new AbortController().signal);
      if (currentFingerprint !== store.getFingerprint(node.entity.sourceId)) {
        void vscode.window.showWarningMessage('This navigation entry is stale. Refresh the Session Navigator.');
        return;
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
    if (!isContainedFile(root.fsPath, target.fsPath) || !(await isRegularFile(target.fsPath))) {
      void vscode.window.showWarningMessage('The authorized source file is no longer available.');
      return;
    }
    const intent: RevealIntent = {
      sourceId: node.entity.sourceId,
      catalogGeneration: node.entity.generation,
      nativeId: node.entity.nativeId,
      anchorOrdinal: location.rowOrdinal,
    };
    this.#revealRegistry.set(target.toString(), intent);
    try {
      await vscode.commands.executeCommand('vscode.openWith', target, 'jsonlView.editor');
    } catch (error) {
      this.#revealRegistry.clear(target.toString());
      void vscode.window.showErrorMessage(`JsonlView could not open the selected source: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public dispose(): void {
    this.#disposed = true;
    if (this.#probeTimer !== undefined) clearInterval(this.#probeTimer);
    this.#probeTimer = undefined;
    this.#store?.close();
    this.#store = undefined;
    this.#providers.clear();
    this.#changed.dispose();
  }

  private async ensureStore(): Promise<CatalogStore> {
    if (this.#store !== undefined) return this.#store;
    const directory = vscode.Uri.joinPath(this.#context.globalStorageUri, 'session-navigator');
    await vscode.workspace.fs.createDirectory(directory);
    this.#store = await CatalogStore.open(vscode.Uri.joinPath(directory, 'catalog.sqlite').fsPath);
    this.#store.syncSources(this.settings());
    return this.#store;
  }

  private settings(): readonly AuthorizedSourceSetting[] {
    return parseAuthorizedSources(vscode.workspace.getConfiguration('jsonlView').get<unknown>(SOURCES_SETTING, []));
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

  private async addSource(): Promise<void> {
    const provider = await vscode.window.showQuickPick(
      [{ label: 'Codex', value: 'codex' as const }, { label: 'Claude', value: 'claude' as const }, { label: 'Generic JSONL', value: 'generic' as const }],
      { placeHolder: 'Choose the source format to authorize' },
    );
    if (provider === undefined) return;
    const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: true, canSelectMany: false, openLabel: 'Authorize source' });
    const uri = picked?.[0];
    if (uri === undefined) return;
    await this.authorizeSourceUri(provider.value, uri);
  }

  private async addSourceFromClipboard(): Promise<void> {
    const text = (await vscode.env.clipboard.readText()).trim().split(/\r?\n/u).find((line) => line.trim().length > 0)?.trim();
    if (text === undefined) {
      void vscode.window.showInformationMessage('Paste a local file or folder path to authorize an Agent source.');
      return;
    }
    let uri: vscode.Uri;
    try { uri = text.startsWith('file://') ? vscode.Uri.parse(text) : vscode.Uri.file(text); }
    catch { void vscode.window.showWarningMessage('The clipboard does not contain a valid local path.'); return; }
    if (uri.scheme !== 'file') {
      void vscode.window.showWarningMessage('Session Navigator accepts local file or folder paths only.');
      return;
    }
    const provider = await vscode.window.showQuickPick(
      [{ label: 'Codex', value: 'codex' as const }, { label: 'Claude', value: 'claude' as const }, { label: 'Generic JSONL', value: 'generic' as const }],
      { placeHolder: 'Choose the source format to authorize' },
    );
    if (provider !== undefined) await this.authorizeSourceUri(provider.value, uri);
  }

  private async authorizeSourceUri(provider: AuthorizedSourceSetting['provider'], uri: vscode.Uri): Promise<void> {
    const current = [...this.settings()];
    const next = parseAuthorizedSources([...current, { provider, rootUri: uri.toString(true) }]);
    await vscode.workspace.getConfiguration('jsonlView').update(SOURCES_SETTING, next, vscode.ConfigurationTarget.Global);
    await this.setEnabled(true);
    this.#changed.fire(undefined);
  }

  private async handleDrop(target: SessionNavigatorTreeNode | undefined, dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): Promise<void> {
    if (target !== undefined) {
      void vscode.window.showInformationMessage('Drop a local source on the Navigator root to authorize it.');
      return;
    }
    if (token.isCancellationRequested) return;
    const candidates: vscode.Uri[] = [];
    const files = dataTransfer.get('files')?.asFile();
    if (files?.uri !== undefined) candidates.push(files.uri);
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
    const uri = candidates[0];
    if (uri === undefined) {
      void vscode.window.showWarningMessage('No local file or folder was found in the drop.');
      return;
    }
    const action = await vscode.window.showWarningMessage(`Authorize ${uri.fsPath} as a read-only Session Navigator source?`, 'Authorize source');
    if (action !== 'Authorize source' || token.isCancellationRequested) return;
    const provider = await vscode.window.showQuickPick(
      [{ label: 'Codex', value: 'codex' as const }, { label: 'Claude', value: 'claude' as const }, { label: 'Generic JSONL', value: 'generic' as const }],
      { placeHolder: 'Choose the source format to authorize' },
    );
    if (provider !== undefined) await this.authorizeSourceUri(provider.value, uri);
  }

  private async removeSource(node?: SessionNavigatorTreeNode): Promise<void> {
    const current = [...this.settings()];
    const sourceId = node?.nodeKind === 'source' ? node.source.sourceId : node?.nodeKind === 'entity' ? node.entity.sourceId : undefined;
    if (sourceId === undefined) return;
    const next = current.filter((setting) => sourceIdFor(setting) !== sourceId);
    await vscode.workspace.getConfiguration('jsonlView').update(SOURCES_SETTING, next, vscode.ConfigurationTarget.Global);
    this.#changed.fire(undefined);
  }

  private handleVisibility(visible: boolean): void {
    if (visible && this.isEnabled()) {
      if (this.#probeTimer === undefined) this.#probeTimer = setInterval(() => { void this.probeVisibleSources(); }, PROBE_INTERVAL_MS);
    } else if (this.#probeTimer !== undefined) {
      clearInterval(this.#probeTimer);
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
          if (fingerprint !== store.getFingerprint(sourceId)) store.markUpdateAvailable(sourceId, true);
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
  return suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${sep}`));
}

async function isRegularFile(path: string): Promise<boolean> {
  try { return (await lstat(path)).isFile(); } catch { return false; }
}
function shortId(value: string): string { return value.length > 12 ? value.slice(0, 12) : value; }
function compactTime(value: string): string { const time = Date.parse(value); return Number.isNaN(time) ? value : new Date(time).toISOString().replace('.000Z', 'Z'); }
