import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import * as vscode from 'vscode';
import { CatalogStore, DEFAULT_CATALOG_PAGE_LIMIT, type CatalogAppendGuard } from './catalog-store';
import { catalogSourceKind, type CatalogEntity, type CatalogSourceInput, type CollectionReferenceIdentity, type SessionCatalogPort } from '@application/index';
import { CollectionsTreeProvider, type CollectionsTreeNode } from './collections-tree-provider';
import { createSessionNavigatorProvider } from './provider-factory';
import { discoverDefaultSources, mergeSourceSettings, parseAuthorizedSources, sourceIdFor, sourceLabelFor } from './source-config';
import type { RevealIntentRegistry } from './reveal-intents';
import type { RevealOpenResult } from './reveal-intents';
import { SourceControllerRegistry } from './source-controller-registry';
import { getSessionCatalogStrategy } from './session-catalog-strategy';
import { isSessionSourceChangedError } from './provider-errors';
import { SourceIntakePanel, validateLocalSourceUri } from './source-intake';
import { chooseSourceIntakeAction, type SourceIntakeQuickPickItem } from './source-intake-quickpick';
import { SourceImportCanvas } from './source-drop-view';
import { validateSourceSelection } from './source-selection-policy';
import { hasJsonlExtension } from './source-intake-contract';
import type { SourceTreeAction } from './source-tree-provider';
import { createSessionNavigatorDragAndDropControllers } from './session-navigator-drag-and-drop';
import type { SessionReferenceDragItem } from './session-reference-dnd';
import { type SessionPreview, SessionPreviews } from './session-previews';
import { DEFAULT_SESSION_NAVIGATOR_BUDGET, sessionNavigatorProviderLabel, type AuthorizedSourceSetting, type DetectedAgentProviderId, type NavigatorEntity, type NavigatorSourceSummary, type RevealIntent, type SessionNavigatorProvider, type SessionNavigatorProviderId, type SessionNavigatorSortKey } from './types';
import type { NavigatorBridgeResultV1 } from '@shared/protocol/navigator-bridge';

const SOURCES_SETTING = 'sessionNavigator.sources';
const ENABLED_SETTING = 'sessionNavigator.enabled';
const SORT_SETTING = 'sessionNavigator.sort';
const PROBE_INTERVAL_MS = 30_000;
const SOURCE_SCAN_CONCURRENCY = 3;
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

interface DetectedSourcesTreeNode {
  readonly nodeKind: 'detected-group';
}

interface DetectedSourceTreeNode {
  readonly nodeKind: 'detected-source';
  readonly provider: DetectedAgentProviderId;
}

interface DetectedSourcesEmptyTreeNode {
  readonly nodeKind: 'detected-empty';
}

interface ConnectAgentTreeNode {
  readonly nodeKind: 'connect-agent';
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
interface ObservedFingerprint { readonly baseline: string; readonly fingerprint: string }
type SessionCatalogOpener = (path: string) => Promise<SessionCatalogPort>;
const defaultCatalogOpener: SessionCatalogOpener = (path) => CatalogStore.open(path);

export type SessionNavigatorTreeNode = SourceTreeNode | DetectedSourcesTreeNode | DetectedSourceTreeNode | DetectedSourcesEmptyTreeNode | ConnectAgentTreeNode | EntityTreeNode | CatalogPageTreeNode | CatalogErrorTreeNode | PreviewGroupTreeNode | PreviewTreeNode;

export class SessionNavigatorTreeProvider implements vscode.TreeDataProvider<SessionNavigatorTreeNode>, vscode.Disposable {
  readonly #context: vscode.ExtensionContext;
  readonly #revealRegistry: RevealIntentRegistry;
  readonly #changed = new vscode.EventEmitter<SessionNavigatorTreeNode | undefined | null | void>();
  readonly #visibilityChanged = new vscode.EventEmitter<boolean>();
  readonly #providers = new Map<string, SessionNavigatorProvider>();
  readonly #sourceStatus = new Map<string, SourceStatus>();
  readonly #detectedSources: DetectedSourcesTreeNode = { nodeKind: 'detected-group' };
  readonly #detectedSourcesEmpty: DetectedSourcesEmptyTreeNode = { nodeKind: 'detected-empty' };
  readonly #connectAgent: ConnectAgentTreeNode = { nodeKind: 'connect-agent' };
  readonly #sourceControllers = new SourceControllerRegistry();
  readonly #intake: SourceIntakePanel;
  readonly #importCanvas: SourceImportCanvas;
  readonly #collections: CollectionsTreeProvider;
  readonly #collectionsProjectionRegistration: vscode.Disposable;
  readonly #collectionsSessionProjectionRegistration: vscode.Disposable;
  #collectionsVisibilityRegistration: vscode.Disposable | undefined;
  readonly #previewRegistration: vscode.Disposable;
  readonly #previewSavedRegistration: vscode.Disposable;
  #store: SessionCatalogPort | undefined;
  #openingStore: Promise<SessionCatalogPort> | undefined;
  #refreshing: Promise<void> | undefined;
  #scanController: AbortController | undefined;
  #probeController: AbortController | undefined;
  #probeFlight: Promise<void> | undefined;
  #refreshAgain = false;
  readonly #observedFingerprints = new Map<string, ObservedFingerprint>();
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
  // A saved-file Collection action grants a source without starting background
  // work. Explicit Refresh (or a new extension session) admits these sources.
  readonly #metadataOnlySourceIds = new Set<string>();
  #metadataOnlySourceSettings: readonly AuthorizedSourceSetting[] | undefined;
  #treeView: vscode.TreeView<SessionNavigatorTreeNode> | undefined;
  #collectionsView: vscode.TreeView<unknown> | undefined;
  #sessionViewVisible = false;
  #windowFocused = false;
  #collectionsVisible = false;
  #reportedNavigatorVisibility: boolean | undefined;
  #probeTimer: NodeJS.Timeout | undefined;
  #disposed = false;
  #revealSequence = 0;
  #opening: Promise<NavigatorBridgeResult> | undefined;
  public readonly previews: SessionPreviews;
  private readonly catalogOpener: SessionCatalogOpener;
  private readonly reportSavedPreviewCollectionFailure: (error: unknown) => void;

  public readonly onDidChangeTreeData = this.#changed.event;
  /** Fires while either the Sessions or Collections view is visible and expanded; does not own source polling. */
  public readonly onDidChangeVisibility = this.#visibilityChanged.event;

  public constructor(context: vscode.ExtensionContext, revealRegistry: RevealIntentRegistry, previews = new SessionPreviews(), catalogOpener: SessionCatalogOpener = defaultCatalogOpener, reportSavedPreviewCollectionFailure: (error: unknown) => void = () => {}) {
    this.#context = context;
    this.#revealRegistry = revealRegistry;
    this.previews = previews;
    this.catalogOpener = catalogOpener;
    this.reportSavedPreviewCollectionFailure = reportSavedPreviewCollectionFailure;
    this.#intake = new SourceIntakePanel(previews);
    this.#importCanvas = new SourceImportCanvas({
      action: (action, signal) => this.handleSourceTreeAction(action, signal),
      previewUri: (uri, signal) => this.handleIntakeUri(uri, signal),
      previewText: (text, signal) => this.#intake.previewText(text, signal),
      offerPreviewSaveAs: (preview, signal) => this.#intake.offerPreviewSaveAs(preview, signal),
    }, () => vscode.window.createWebviewPanel('jsonlView.sourceImportCanvas', 'Use Resources', vscode.ViewColumn.Active, {
      enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true,
    }));
    this.#collections = new CollectionsTreeProvider(context.globalStorageUri.fsPath, {
      referenceForNode: (node) => this.collectionReferenceForNode(node),
      referenceForDraggedSession: (reference) => {
        const entity = this.#store?.getEntity(reference.sourceId, reference.nativeId);
        if (entity === undefined || entity.generation !== reference.generation || entity.provider !== reference.providerId) return undefined;
        return this.collectionReferenceForNode({ nodeKind: 'entity', entity });
      },
      labelForReference: (reference) => this.collectionReferenceLabel(reference),
      pickReference: (purpose) => this.pickCollectionReference(purpose),
      openReference: async (reference) => {
        if (this.collectionReferenceLabel(reference) === undefined) return;
        if (reference.referenceKind === 'source' || reference.referenceKind === 'file') {
          await this.openCollectionSource(reference);
          return;
        }
        const entity = this.#store?.getEntity(reference.sourceId, reference.nativeId);
        if (entity !== undefined) await this.reveal({ nodeKind: 'entity', entity });
      },
    }, context.globalState);
    // Runtime observations may change reference labels; update only materialized rows so
    // Sessions polling cannot clear the host's collection TreeView handles.
    this.#collectionsProjectionRegistration = this.onDidChangeTreeData(() => this.#collections.refreshReferenceLabels());
    this.#collectionsSessionProjectionRegistration = this.#collections.onDidChangeTreeData(() => {
      if (!this.hideArchivedCollectionSessions()) return;
      this.invalidateAllSources();
      this.#changed.fire(undefined);
    });
    this.#previewRegistration = previews.onDidChange(() => this.#changed.fire(undefined));
    this.#previewSavedRegistration = previews.onDidSave((uri, outcome) => {
      void this.promptSavedPreviewActions(uri, outcome === 'saved-open-failed').catch((error: unknown) => {
        try { this.reportSavedPreviewCollectionFailure(error); }
        catch { /* Logging must not change the already verified Save As result. */ }
        if (!this.#disposed) {
          const registered = this.configuredSources().some((setting) => setting.provider === 'generic' && setting.rootUri === uri.toString(true));
          void vscode.window.showWarningMessage(registered
            ? 'The saved copy remains available and its source permission remains registered. A Collection change may be pending. Check the current entries before retrying; this action did not start a source scan.'
            : 'The saved copy remains available. Source registration was not confirmed; check source settings and Collection entries before retrying. This action did not start a source scan.');
        }
      });
    });
  }

  public register(): vscode.Disposable[] {
    const dragAndDropControllers = createSessionNavigatorDragAndDropControllers({
      isDisposed: () => this.#disposed,
      dragItemForNode: (node) => this.sessionReferenceForDrag(node),
      isSessionTarget: (target) => this.isSessionReferenceDropTarget(target),
      resolveDraggedSession: (reference) => this.entityForDraggedSession(reference),
      revealSession: (entity) => entity.nodeKind === 'entity' ? this.reveal(entity) : Promise.resolve(undefined),
      dropCollection: (target, transfer, token) => this.#collections.handleDrop(target, transfer, token),
    });
    this.#treeView = vscode.window.createTreeView('jsonlView.sessionNavigator', {
      treeDataProvider: this,
      canSelectMany: true,
      dragAndDropController: dragAndDropControllers.sessions,
    });
    this.#windowFocused = vscode.window.state.focused;
    this.#collectionsView = vscode.window.createTreeView('jsonlView.sourceDrop', {
      treeDataProvider: this.#collections,
      dragAndDropController: dragAndDropControllers.collections,
    });
    this.#collectionsVisibilityRegistration = this.#collectionsView.onDidChangeVisibility((event) => this.handleCollectionsVisibility(event.visible));
    const subscriptions: vscode.Disposable[] = [
      this.#treeView,
      this.#collectionsView,
      this.#collectionsVisibilityRegistration,
      this.#importCanvas,
      this.#collections,
      ...this.#collections.register(),
      vscode.commands.registerCommand('jsonlView.sessionNavigator.refresh', () => this.refresh()),
      vscode.commands.registerCommand('jsonlView.sessionNavigator.openImportCanvas', () => this.openImportCanvas()),
      vscode.commands.registerCommand('jsonlView.sessionNavigator.addSource', () => this.addSource()),
      vscode.commands.registerCommand('jsonlView.sessionNavigator.authorizeAgent', () => this.authorizeAgent()),
      vscode.commands.registerCommand('jsonlView.sessionNavigator.source.files', () => this.handleSourceTreeAction('files')),
      vscode.commands.registerCommand('jsonlView.sessionNavigator.source.folder', () => this.handleSourceTreeAction('folder')),
      vscode.commands.registerCommand('jsonlView.sessionNavigator.source.paste', () => this.handleSourceTreeAction('paste')),
      vscode.commands.registerCommand('jsonlView.sessionNavigator.source.authorizeDetected', (provider: DetectedAgentProviderId) => this.authorizeDetectedAgent(provider, new AbortController().signal)),
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
      vscode.commands.registerCommand('jsonlView.sessionNavigator.addSourceFromClipboard', () => this.handleSourceTreeAction('paste')),
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
      this.#treeView.onDidChangeVisibility((event) => this.handleSessionVisibility(event.visible)),
      vscode.window.onDidChangeWindowState((event) => {
        this.#windowFocused = event.focused;
        this.handleSessionVisibility(this.#treeView?.visible ?? false);
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('jsonlView.sessionNavigator')) {
          if (event.affectsConfiguration('jsonlView.' + SOURCES_SETTING)
            && !event.affectsConfiguration('jsonlView.' + ENABLED_SETTING)
            && this.#metadataOnlySourceSettings !== undefined
            && sameSourceSettings(this.configuredSources(), this.#metadataOnlySourceSettings)) return;
          if (event.affectsConfiguration('jsonlView.' + SOURCES_SETTING)) this.#metadataOnlySourceSettings = undefined;
          this.invalidateAllSources();
          if (event.affectsConfiguration('jsonlView.' + SOURCES_SETTING) || event.affectsConfiguration('jsonlView.' + ENABLED_SETTING)) {
            this.#scanController?.abort();
            this.#probeController?.abort();
            this.#refreshAgain = true;
            this.#initialized = false;
            if (!this.isEnabled() && this.#treeView !== undefined) this.#treeView.message = '';
            this.handleSessionVisibility(this.#treeView?.visible ?? false);
          }
          this.#changed.fire(undefined);
        }
      }),
    ];
    this.handleSessionVisibility(this.#treeView.visible);
    return subscriptions;
  }

  private sessionReferenceForDrag(node: SessionNavigatorTreeNode | CollectionsTreeNode): SessionReferenceDragItem | undefined {
    const identity = 'nodeKind' in node
      ? node.nodeKind === 'entity' ? this.collectionReferenceForNode(node) : undefined
      : node.kind === 'entry' ? this.#collections.sessionReferenceForDrag(node) : undefined;
    if (identity === undefined || identity.referenceKind !== 'session') return undefined;
    const entity = this.#store?.getEntity(identity.sourceId, identity.nativeId);
    if (entity === undefined || entity.provider !== identity.providerId
      || this.collectionReferenceForNode({ nodeKind: 'entity', entity }) === undefined) return undefined;
    return { providerId: identity.providerId, sourceId: identity.sourceId, nativeId: identity.nativeId, generation: entity.generation };
  }

  private isSessionReferenceDropTarget(target: SessionNavigatorTreeNode | undefined): boolean {
    if (target === undefined) return true;
    if (this.#disposed) return false;
    if (target.nodeKind === 'source' || target.nodeKind === 'entity') return this.collectionReferenceForNode(target) !== undefined;
    return false;
  }

  private entityForDraggedSession(reference: SessionReferenceDragItem): EntityTreeNode | undefined {
    const entity = this.#store?.getEntity(reference.sourceId, reference.nativeId);
    if (entity === undefined || entity.provider !== reference.providerId || entity.generation !== reference.generation
      || this.collectionReferenceForNode({ nodeKind: 'entity', entity }) === undefined) return undefined;
    return { nodeKind: 'entity', entity };
  }

  public openImportCanvas(): void {
    if (this.#disposed) return;
    this.#importCanvas.show();
  }

  public getTreeItem(node: SessionNavigatorTreeNode): vscode.TreeItem {
    if (node.nodeKind === 'preview-group') {
      const item = new vscode.TreeItem('Recent Previews', vscode.TreeItemCollapsibleState.Collapsed);
      item.id = 'recent-previews';
      item.contextValue = 'jsonlView.sessionNavigator.previewGroup';
      item.description = String(this.previews.list().length);
      item.iconPath = new vscode.ThemeIcon('file-symlink-file');
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
      if (preview?.savedUri !== undefined) item.label = 'Saved preview · ' + new Date(preview.createdAt).toLocaleTimeString();
      item.description = preview === undefined ? 'Refresh to remove' : String(preview.recordCount) + ' records · ' + (preview.status === 'saving' ? 'Saving…' : preview.savedUri === undefined ? 'Temporary' : 'Saved copy');
      item.tooltip = preview === undefined
        ? 'This temporary preview is no longer available.'
        : new Date(preview.createdAt).toLocaleString() + '\n' + String(preview.sizeBytes) + ' UTF-8 bytes. Temporary source is recoverable during this VS Code session only. Save As keeps a permanent copy.';
      item.iconPath = new vscode.ThemeIcon(preview?.status === 'saving' ? 'loading~spin' : 'file');
      item.command = preview?.savedUri === undefined
        ? { command: 'jsonlView.previews.open', title: 'Open temporary preview', arguments: [node] }
        : { command: 'jsonlView.previews.openSavedCopy', title: 'Open saved preview copy', arguments: [node] };
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
    if (node.nodeKind === 'detected-group') {
      const item = new vscode.TreeItem('Detected sources', vscode.TreeItemCollapsibleState.Collapsed);
      item.id = 'detected-sources';
      item.contextValue = 'jsonlView.sessionNavigator.detectedGroup';
      item.description = 'Authorize a detected local source';
      item.iconPath = new vscode.ThemeIcon('plug');
      return item;
    }
    if (node.nodeKind === 'detected-empty') {
      const item = new vscode.TreeItem('No additional local agent sources detected', vscode.TreeItemCollapsibleState.None);
      item.id = 'detected-sources.empty';
      item.contextValue = 'jsonlView.sessionNavigator.detectedPlaceholder';
      item.description = 'Use Connect local agent or Add Source';
      item.iconPath = new vscode.ThemeIcon('circle-slash');
      return item;
    }
    if (node.nodeKind === 'detected-source') {
      const label = sessionNavigatorProviderLabel(node.provider);
      const item = new vscode.TreeItem(`Connect ${label}`, vscode.TreeItemCollapsibleState.None);
      item.id = `detected-source:${node.provider}`;
      item.contextValue = 'jsonlView.sessionNavigator.detectedSource';
      item.description = 'Authorize a detected source';
      item.iconPath = new vscode.ThemeIcon(detectedProviderIcon(node.provider));
      item.command = {
        command: 'jsonlView.sessionNavigator.source.authorizeDetected',
        title: `Connect ${label}`,
        arguments: [node.provider],
      };
      return item;
    }
    if (node.nodeKind === 'connect-agent') {
      const item = new vscode.TreeItem('Connect local agent…', vscode.TreeItemCollapsibleState.None);
      item.id = 'connect-local-agent';
      item.contextValue = 'jsonlView.sessionNavigator.connectAgent';
      item.description = 'Choose a provider';
      item.tooltip = 'Explicitly choose Codex, Claude, pi, Kimi Code, or another supported local provider.';
      item.iconPath = new vscode.ThemeIcon('plug');
      item.command = { command: 'jsonlView.sessionNavigator.authorizeAgent', title: 'Connect Local Agent' };
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
    if (node === undefined) {
      const settings = this.settings();
      if (settings.length === 0) {
        // Defer provider-root filesystem discovery until the user expands the
        // candidate branch. The root stays cheap and discovery never authorizes
        // or scans a provider. Keep the explicit provider picker visible too.
        const children: SessionNavigatorTreeNode[] = [this.#detectedSources, this.#connectAgent];
        if (this.previews.list().length > 0) children.push({ nodeKind: 'preview-group' });
        return children;
      }
      const store = await this.ensureStore();
      if (this.#disposed || !this.isEnabled()) return [];
      store.syncSources(settings);
      if (!this.#initialized && this.#treeView?.visible && this.#refreshing === undefined) {
        for (const setting of settings) this.#sourceStatus.set(sourceIdFor(setting), { phase: 'loading' });
        this.#changed.fire(undefined);
        this.#initialized = true;
        void this.refresh(false);
      }
      const children: SessionNavigatorTreeNode[] = store.listSources().map((source) => ({ nodeKind: 'source', source } satisfies SourceTreeNode));
      // Agent discovery remains lazy under the same explicit branch when a
      // source is already authorized; adding Codex must not hide Pi/Kimi.
      children.push(this.#detectedSources, this.#connectAgent);
      if (this.previews.list().length > 0) children.push({ nodeKind: 'preview-group' });
      return children;
    }
    if (node.nodeKind === 'detected-group') {
      const detected = this.detectedSources();
      return detected.length > 0
        ? detected.map((setting) => ({ nodeKind: 'detected-source', provider: setting.provider as DetectedAgentProviderId } satisfies DetectedSourceTreeNode))
        : [this.#detectedSourcesEmpty];
    }
    if (node.nodeKind === 'detected-empty') return [];
    if (node.nodeKind === 'detected-source') return [];
    if (node.nodeKind === 'connect-agent') return [];
    const store = await this.ensureStore();
    if (this.#disposed || !this.isEnabled()) return [];
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

  private catalogChildren(store: SessionCatalogPort, sourceId: string, parentNativeId?: string, continuation?: CatalogPageTreeNode): Promise<SessionNavigatorTreeNode[]> {
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
    this.#sourceControllers.add(sourceId, controller);
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
      const entities = this.hideArchivedCollectionSessions() ? await this.visibleSessionEntities(page.entities) : page.entities;
      if (!current()) return [];
      const nodes: SessionNavigatorTreeNode[] = entities.map((entity) => ({ nodeKind: 'entity', entity }));
      if (page.nextCursor !== undefined) nodes.push({ nodeKind: 'catalog-page', ...identity, cursor: page.nextCursor });
      return nodes;
    }).catch((error: unknown) => current() ? this.catalogPageError(sourceId, error instanceof Error ? error.message : 'Catalog children page could not load.', key) : [])
      .finally(() => {
        if (this.#pageControllers.get(key) === controller) this.#pageControllers.delete(key);
        this.#sourceControllers.delete(sourceId, controller);
        if (this.#childrenFlights.get(key) === flight) this.#childrenFlights.delete(key);
      });
    this.#childrenFlights.set(key, flight);
    return flight;
  }

  public async refresh(includeMetadataOnlySources = true): Promise<void> {
    if (this.#disposed || !this.isEnabled()) return;
    if (includeMetadataOnlySources && this.#metadataOnlySourceIds.size > 0) {
      this.#metadataOnlySourceIds.clear();
      // The active pass may have captured its source list before onboarding.
      // Keep its callers waiting for a new pass that admits the saved file.
      if (this.#refreshing !== undefined) this.#refreshAgain = true;
    }
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
    this.#sourceControllers.add(sourceId, controller);
    const flight = this.runLoadMorePage(store, setting, sourceId, state.generation, state.fingerprint, cursor, epoch, controller, key);
    this.#pageFlights.set(key, flight);
    return flight;
  }

  private async runLoadMorePage(store: SessionCatalogPort, setting: AuthorizedSourceSetting, sourceId: string, generation: string, fingerprint: string, cursor: string, epoch: number, controller: AbortController, key: string): Promise<void> {
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
        if (isSessionSourceChangedError(error)) {
          if (store.invalidateContinuationIfCurrent(sourceId, { generation, cursor, fingerprint })) {
            store.markUpdateAvailable(sourceId, true);
          }
          this.#sourceStatus.delete(sourceId);
          this.#changed.fire(undefined);
          return;
        }
        this.#sourceStatus.set(sourceId, { phase: 'error', detail: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      if (this.#pageControllers.get(key) === controller) this.#pageControllers.delete(key);
      this.#sourceControllers.delete(sourceId, controller);
      if (this.#pageFlights.get(key) !== undefined) this.#pageFlights.delete(key);
      if (this.#sourceStatus.get(sourceId)?.phase === 'loading') this.#sourceStatus.delete(sourceId);
      this.#changed.fire(undefined);
    }
  }

  private sourceEpoch(sourceId: string): number {
    return this.#sourceEpochs.get(sourceId) ?? 0;
  }

  private canCommitPage(store: SessionCatalogPort, sourceId: string, generation: string, fingerprint: string, cursor: string, epoch: number, signal: AbortSignal): boolean {
    if (signal.aborted || this.#disposed || !this.isEnabled() || this.sourceEpoch(sourceId) !== epoch) return false;
    if (!this.settings().some((setting) => sourceIdFor(setting) === sourceId)) return false;
    const state = store.getSourcePageState(sourceId);
    return state?.generation === generation && state.nextCursor === cursor && state.fingerprint === fingerprint;
  }

  private invalidateSource(sourceId: string): void {
    this.#sourceEpochs.set(sourceId, this.sourceEpoch(sourceId) + 1);
    this.#sourceControllers.abortSource(sourceId);
  }

  private invalidateAllSources(): void {
    const sourceIds = new Set<string>([
      ...this.#sourceEpochs.keys(),
      ...this.#sourceControllers.sourceIds(),
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
    } while (this.#refreshAgain && this.isSessionPollingEligible());
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
      for (const id of this.#observedFingerprints.keys()) if (!activeSourceIds.has(id)) this.#observedFingerprints.delete(id);
      const scanSettings = settings.filter((setting) => !this.#metadataOnlySourceIds.has(sourceIdFor(setting)));
      for (const setting of scanSettings) this.#sourceStatus.set(sourceIdFor(setting), { phase: 'loading' });
      this.#changed.fire(undefined);
      const failureDetails = new Map<string, string>();
      const scanOrder = [...scanSettings].sort((left, right) => getSessionCatalogStrategy(left.provider).refreshPriority - getSessionCatalogStrategy(right.provider).refreshPriority);
      await forEachBounded(scanOrder, SOURCE_SCAN_CONCURRENCY, async (setting) => {
        if (signal.aborted || this.#disposed || !this.isEnabled()) return;
        const sourceId = sourceIdFor(setting);
        try {
          const provider = this.providerFor(setting);
          let expectedFingerprint: string | undefined;
          // The catalog is durable and already contains the last coherent
          // projection. Probe it before scanning so reopening the view is a
          // read-only fingerprint check when the provider has not changed.
          // A changed source keeps its cached rows visible until replacement
          // succeeds; the loading status communicates that refresh is pending.
          const cachedFingerprint = store.getFingerprint(sourceId);
          if (cachedFingerprint !== undefined) {
            const observed = this.#observedFingerprints.get(sourceId);
            this.#observedFingerprints.delete(sourceId);
            const currentFingerprint = observed !== undefined && observed.baseline === cachedFingerprint
              ? observed.fingerprint
              : await provider.probe(signal);
            expectedFingerprint = currentFingerprint;
            if (signal.aborted || this.#disposed || !this.isEnabled()) return;
            if (currentFingerprint === cachedFingerprint) {
              store.markUpdateAvailable(sourceId, false);
              this.#sourceStatus.delete(sourceId);
              this.#transientEmptyScans.delete(sourceId);
              this.#changed.fire(undefined);
              return;
            }
            store.markUpdateAvailable(sourceId, true);
            this.#changed.fire(undefined);
          }
          const scan = await provider.scan(signal, DEFAULT_SESSION_NAVIGATOR_BUDGET, expectedFingerprint);
          if (signal.aborted || this.#disposed || !this.isEnabled()) return;
          if (!this.settings().some((current) => sourceIdFor(current) === sourceId)) return;
          const strategy = getSessionCatalogStrategy(setting.provider);
          const emptyRetry = strategy.initialLoad.emptyTruncatedRetry;
          if (emptyRetry !== undefined && strategy.isRetryableEmptyScan(scan)) {
            const attempts = this.#transientEmptyScans.get(sourceId) ?? 0;
            if (attempts < emptyRetry.maxAttempts) {
              this.#transientEmptyScans.set(sourceId, attempts + 1);
              this.#sourceStatus.set(sourceId, { phase: 'loading', detail: emptyRetry.statusDetail });
              this.#refreshAgain = true;
              this.#changed.fire(undefined);
              return;
            }
          }
          this.#transientEmptyScans.delete(sourceId);
          const snapshot = {
            ...scan.snapshot,
            entities: scan.snapshot.entities.map((entity) => ({ ...entity, sourceId })),
            relations: scan.snapshot.relations.map((relation) => ({ ...relation, sourceId })),
          };
          const expectedPageState = store.getSourcePageState(sourceId);
          const committed = store.replaceSnapshot(sourceId, { ...snapshot, ...(scan.nextCursor === undefined ? {} : { nextCursor: scan.nextCursor }) }, scan.fingerprint, expectedPageState === undefined ? undefined : {
            expectedGeneration: expectedPageState.generation,
            ...(expectedPageState.nextCursor === undefined ? {} : { expectedCursor: expectedPageState.nextCursor }),
            ...(expectedPageState.fingerprint === undefined ? {} : { expectedFingerprint: expectedPageState.fingerprint }),
            signal,
          });
          if (provider.scanPage !== undefined && strategy.initialLoad.maximumPages > 1) {
            let continuation = scan.nextCursor ?? scan.snapshot.nextCursor;
            let pages = 1;
            let generation = committed.sourceGeneration;
            let currentFingerprint = scan.fingerprint;
            while (continuation !== undefined && pages < strategy.initialLoad.maximumPages) {
              let page: Awaited<ReturnType<NonNullable<SessionNavigatorProvider['scanPage']>>>;
              try { page = await provider.scanPage(signal, DEFAULT_SESSION_NAVIGATOR_BUDGET, continuation); }
              catch (error) {
                if (signal.aborted || this.#disposed || !this.isEnabled()) return;
                if (isSessionSourceChangedError(error)) {
                  if (store.invalidateContinuationIfCurrent(sourceId, { generation, cursor: continuation, fingerprint: currentFingerprint })) {
                    store.markUpdateAvailable(sourceId, true);
                  }
                  this.#changed.fire(undefined);
                  break;
                }
                throw error;
              }
              if (signal.aborted || this.#disposed || !this.isEnabled()) return;
              if (!this.settings().some((current) => sourceIdFor(current) === sourceId)) return;
              const pageSnapshot = {
                ...page.snapshot,
                entities: page.snapshot.entities.map((entity) => ({ ...entity, sourceId })),
                relations: page.snapshot.relations.map((relation) => ({ ...relation, sourceId })),
              };
              const appended = store.appendSnapshot(sourceId, { ...pageSnapshot, ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) }, page.fingerprint, {
                expectedGeneration: generation,
                expectedCursor: continuation,
                expectedFingerprint: currentFingerprint,
                signal,
              });
              generation = appended.sourceGeneration;
              currentFingerprint = page.fingerprint;
              continuation = page.nextCursor ?? page.snapshot.nextCursor;
              pages += 1;
            }
          }
          this.#sourceStatus.delete(sourceId);
          this.#changed.fire(undefined);
        } catch (error) {
          if (signal.aborted || this.#disposed) return;
          const detail = error instanceof Error ? error.message : String(error);
          if (detail === 'Catalog snapshot is stale.') {
            this.#refreshAgain = true;
            return;
          }
          this.#sourceStatus.set(sourceId, { phase: 'error', detail });
          this.#changed.fire(undefined);
          failureDetails.set(sourceId, detail);
        }
      });
      const failures = settings.flatMap((setting) => {
        const detail = failureDetails.get(sourceIdFor(setting));
        return detail === undefined ? [] : [sourceLabelFor(setting) + ': ' + detail];
      });
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

  public async reveal(node: EntityTreeNode): Promise<RevealOpenResult | undefined> {
    const sequence = ++this.#revealSequence;
    const currentIntent = (): boolean => sequence === this.#revealSequence && !this.#disposed && this.isEnabled();
    if (!currentIntent()) return;
    const store = await this.ensureStore();
    if (!currentIntent()) return;
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
      if (!currentIntent()) return;
      if (currentFingerprint !== store.getFingerprint(node.entity.sourceId)) {
        if (!getSessionCatalogStrategy(setting.provider).allowsStaleLocation(location)) {
          void vscode.window.showWarningMessage('This navigation entry is stale. Refresh the Session Navigator.');
          return;
        }
        store.markUpdateAvailable(node.entity.sourceId, true);
        this.#changed.fire(undefined);
      }
    } catch {
      if (!currentIntent()) return;
      void vscode.window.showWarningMessage('The authorized source file is no longer available.');
      return;
    }
    const configuredRoot = vscode.Uri.parse(rootUriString);
    const rootPath = getSessionCatalogStrategy(setting.provider).resolveLocationRoot(configuredRoot.fsPath);
    const root = rootPath === configuredRoot.fsPath ? configuredRoot : vscode.Uri.file(rootPath);
    const rootIsFile = await isRegularFile(root.fsPath);
    if (!currentIntent()) return;
    if (rootIsFile && basename(root.fsPath) !== location.relativePath) {
      void vscode.window.showWarningMessage('This navigation entry is stale. Refresh the Session Navigator.');
      return;
    }
    const target = rootIsFile ? root : vscode.Uri.joinPath(root, ...location.relativePath.split(/[\\/]+/u));
    const [canonicalRoot, canonicalTarget] = await Promise.all([realpath(root.fsPath).catch(() => undefined), realpath(target.fsPath).catch(() => undefined)]);
    if (!currentIntent()) return;
    if (canonicalRoot === undefined || canonicalTarget === undefined || !isContainedFile(canonicalRoot, canonicalTarget) || !(await isRegularFile(canonicalTarget))) {
      void vscode.window.showWarningMessage('The authorized source file is no longer available.');
      return;
    }
    if (!currentIntent()
      || !this.settings().some((current) => sourceIdFor(current) === node.entity.sourceId)
      || store.getLocation({ sourceId: node.entity.sourceId, generation: node.entity.generation, nativeId: node.entity.nativeId }) === undefined) return;
    const canonicalUri = vscode.Uri.file(canonicalTarget);
    const intent: RevealIntent = {
      sourceId: node.entity.sourceId,
      catalogGeneration: node.entity.generation,
      nativeId: node.entity.nativeId,
      anchorOrdinal: location.rowOrdinal,
    };
    const ticket = this.#revealRegistry.set(canonicalUri.toString(), intent, () => currentIntent()
      && this.settings().some((current) => sourceIdFor(current) === node.entity.sourceId)
      && store.getLocation({ sourceId: node.entity.sourceId, generation: node.entity.generation, nativeId: node.entity.nativeId }) !== undefined);
    try {
      await vscode.commands.executeCommand('vscode.openWith', canonicalUri, 'jsonlView.editor');
    } catch (error) {
      ticket.clear();
      if (currentIntent()) void vscode.window.showErrorMessage(`JsonlView could not open the selected source: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!ticket.taken) ticket.clear();
    const result = await ticket.result;
    if (!currentIntent()) return result;
    if (result.outcome === 'filtered-out') void vscode.window.showInformationMessage('The target record is hidden by the current filters. Clear the filters to reveal it.');
    else if (['timeout', 'no-view', 'not-found', 'stale'].includes(result.outcome)) void vscode.window.showWarningMessage('The target record could not be confirmed in the visible JsonlView editor. Refresh the source and retry.');
    else if (result.outcome === 'unauthorized') void vscode.window.showWarningMessage('This navigation source is no longer authorized. Refresh the Session Navigator.');
    else if (result.outcome === 'out-of-range') void vscode.window.showWarningMessage('The target record is outside the current source. Refresh the Session Navigator.');
    return result;
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
    const rootPath = getSessionCatalogStrategy(node.entity.provider).resolveLocationRoot(configuredRoot.fsPath);
    const root = rootPath === configuredRoot.fsPath ? configuredRoot : vscode.Uri.file(rootPath);
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

  private async savePreviewAs(node: unknown): Promise<'cancelled' | 'failed' | 'saved' | 'saved-open-failed' | undefined> {
    const preview = this.previewFromCommand(node);
    if (preview === undefined) return undefined;
    return this.previews.saveAs(preview.sourceUri);
  }

  private async promptSavedPreviewActions(uri: vscode.Uri, openFailed: boolean): Promise<void> {
    if (this.#disposed) return;
    const filename = basename(uri.fsPath);
    const action = await vscode.window.showInformationMessage(
      `Saved "${filename}".${openFailed ? ' VS Code could not open the copy.' : ''} Add it as a source or file it into a Collection?`,
      'Add as source', 'Add to Collection', 'Dismiss',
    );
    if (action === 'Add as source' && !this.#disposed) {
      await this.confirmCustomSource(uri, () => this.#disposed);
      return;
    }
    if (action !== 'Add to Collection' || this.#disposed) return;

    const target = await this.pickSavedFileCollection(filename);
    if (target === undefined || this.#disposed) return;
    if (!/\.(?:jsonl|ndjson)$/iu.test(filename)) {
      void vscode.window.showWarningMessage('Save the preview with a .jsonl or .ndjson extension before adding it to a Collection.');
      return;
    }

    let canonical: vscode.Uri;
    try { canonical = await validateLocalSourceUri(uri.toString(true)); }
    catch (error) {
      if (!this.#disposed) void vscode.window.showWarningMessage(error instanceof Error ? error.message : 'The saved local file is unavailable.');
      return;
    }
    if (this.#disposed) return;
    const actionLabel = 'Register and Add';
    const confirmed = await vscode.window.showWarningMessage(
      `Register "${basename(canonical.fsPath)}" as a read-only source and add it to "${target.displayName}"? This does not enable Session Navigator.`,
      { modal: true }, actionLabel,
    );
    if (confirmed !== actionLabel || this.#disposed) return;

    const setting: AuthorizedSourceSetting = { provider: 'generic', rootUri: canonical.toString(true) };
    const sourceId = sourceIdFor(setting);
    if (!this.configuredSources().some((candidate) => sourceIdFor(candidate) === sourceId)) {
      await this.authorizeSourceSetting(setting, () => this.#disposed, false);
    }
    if (this.#disposed) return;
    await this.registerSavedFileMetadata();
    if (this.#disposed) return;

    const identity: CollectionReferenceIdentity = {
      providerId: setting.provider, sourceId, nativeId: '@file', referenceKind: 'file',
    };
    const current = (): boolean => !this.#disposed
      && this.configuredSources().some((candidate) => sourceIdFor(candidate) === sourceId)
      && this.#store?.getSourceMetadata(sourceId)?.canonicalUri === setting.rootUri
      && this.#store?.getSourceMetadata(sourceId)?.sourceKind === 'exact_file'
      && this.#store?.getSourceMetadata(sourceId)?.authorizationState === 'authorized';
    await this.#collections.addSavedFileReference(identity, target, current);
  }

  private async pickSavedFileCollection(filename: string): Promise<{ readonly collectionId?: string; readonly displayName: string; readonly expectedRevision: string } | undefined> {
    let cursor: string | undefined;
    for (;;) {
      const page = await this.#collections.listCollectionsPage(cursor === undefined ? {} : { cursor });
      const items: Array<{ label: string; collectionId?: string; create?: boolean; next?: boolean }> = [
        { label: '$(plus) New Collection…', create: true },
        ...page.items.map((collection) => ({ label: collection.displayName, collectionId: collection.collectionId })),
        ...(page.nextCursor === undefined ? [] : [{ label: 'More collections…', next: true }]),
      ];
      const choice = await vscode.window.showQuickPick(items, {
        title: 'Add Saved File to Collection', placeHolder: 'Choose a Collection or create one',
      });
      if (choice === undefined || this.#disposed) return undefined;
      if (choice.next === true) { cursor = page.nextCursor; continue; }
      if (choice.create === true) {
        const proposedName = basename(filename).replace(/\.(?:jsonl|ndjson)$/iu, '');
        const displayName = await vscode.window.showInputBox({
          title: 'New Collection', value: proposedName, prompt: 'Collection name (metadata only)', ignoreFocusOut: true,
          validateInput: (value) => value.trim().length === 0 ? 'Enter a Collection name.' : undefined,
        });
        return displayName === undefined || this.#disposed ? undefined : { displayName, expectedRevision: page.metadataRevision };
      }
      if (choice.collectionId !== undefined) {
        return { collectionId: choice.collectionId, displayName: choice.label, expectedRevision: page.metadataRevision };
      }
    }
  }

  private async registerSavedFileMetadata(): Promise<void> {
    const store = await this.ensureStore(false);
    if (this.#disposed) return;
    const currentSettings = this.isEnabled() ? this.settings() : mergeSourceSettings(this.configuredSources(), []);
    const inputs: CatalogSourceInput[] = currentSettings.map((setting) => ({
      sourceId: sourceIdFor(setting), providerId: setting.provider, sourceKind: catalogSourceKind(setting),
      canonicalUri: setting.rootUri, displayLabel: sourceLabelFor(setting), configRevision: 'explicit-source-setting',
      authorizationState: 'authorized', availabilityState: 'unknown',
    }));
    store.reconcileSourceMetadata(inputs, this.isEnabled());
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
    this.#probeController?.abort();
    this.invalidateAllSources();
    if (this.#probeTimer !== undefined) clearInterval(this.#probeTimer);
    this.#probeTimer = undefined;
    this.#store?.close();
    this.#store = undefined;
    this.#providers.clear();
    this.#collectionsVisibilityRegistration?.dispose();
    this.#collectionsVisibilityRegistration = undefined;
    this.#collectionsProjectionRegistration.dispose();
    this.#collectionsSessionProjectionRegistration.dispose();
    this.#collections.dispose();
    this.#importCanvas.dispose();
    void this.#intake.dispose().catch(() => { /* Preserve any preview whose cleanup could not be verified. */ });
    this.#previewRegistration.dispose();
    this.#previewSavedRegistration.dispose();
    void this.previews.dispose().catch(() => {});
    this.#changed.dispose();
    this.#visibilityChanged.dispose();
  }

  private async ensureStore(syncConfiguredSources = true): Promise<SessionCatalogPort> {
    if (this.#store !== undefined) return this.#store;
    if (this.#openingStore !== undefined) return this.#openingStore;
    this.#openingStore = this.openStore(syncConfiguredSources);
    try { return await this.#openingStore; }
    finally { this.#openingStore = undefined; }
  }

  private async openStore(syncConfiguredSources: boolean): Promise<SessionCatalogPort> {
    const directory = vscode.Uri.joinPath(this.#context.globalStorageUri, 'session-navigator');
    await vscode.workspace.fs.createDirectory(directory);
    const store = await this.catalogOpener(vscode.Uri.joinPath(directory, 'catalog.sqlite').fsPath);
    if (this.#disposed) { store.close(); throw new Error('Session Navigator is disposed.'); }
    this.#store = store;
    if (syncConfiguredSources && this.isEnabled()) this.#store.syncSources(this.settings());
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

  private hideArchivedCollectionSessions(): boolean {
    return vscode.workspace.getConfiguration('jsonlView').get<boolean>('sessionNavigator.hideArchivedCollectionSessions', false);
  }

  private async visibleSessionEntities(entities: readonly CatalogEntity[]): Promise<readonly CatalogEntity[]> {
    if (entities.length === 0) return entities;
    const identities = entities.map((entity) => ({
      providerId: entity.provider,
      sourceId: entity.sourceId,
      nativeId: entity.nativeId,
      referenceKind: 'session' as const,
    }));
    const archived = await this.#collections.archivedSessionReferences(identities);
    const hidden = new Set(archived.map((identity) => JSON.stringify([identity.providerId, identity.sourceId, identity.nativeId])));
    return entities.filter((entity) => !hidden.has(JSON.stringify([entity.provider, entity.sourceId, entity.nativeId])));
  }

  private detectedSources(): readonly AuthorizedSourceSetting[] {
    const excluded = new Set(this.#context.globalState.get<string[]>(EXCLUDED_SOURCES_KEY, []));
    const authorized = new Set(this.settings().map(sourceIdFor));
    return discoverDefaultSources().filter((setting) => !excluded.has(sourceIdFor(setting)) && !authorized.has(sourceIdFor(setting)));
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

  private async addSource(): Promise<void> {
    if (this.#disposed) return;
    const action = await chooseSourceIntakeAction(() => vscode.window.createQuickPick<SourceIntakeQuickPickItem>());
    if (this.#disposed || action === undefined) return;
    if (action === 'agent') await this.authorizeAgent();
    else await this.handleSourceTreeAction(action);
  }

  private async handleIntakeUri(value: string, signal: AbortSignal): Promise<Awaited<ReturnType<SourceIntakePanel['previewUri']>> | 'folder'> {
    const canonical = await validateLocalSourceUri(value);
    if (signal.aborted || this.#disposed) return 'folder';
    const details = await lstat(canonical.fsPath);
    if (details.isDirectory()) {
      await this.handleSourceTreeAction('folder', signal);
      return 'folder';
    }
    return this.#intake.previewUri(canonical, signal);
  }

  private collectionReferenceForNode(value: unknown): CollectionReferenceIdentity | undefined {
    if (value === null || typeof value !== 'object' || this.#disposed) return undefined;
    const node = value as SessionNavigatorTreeNode;
    if (node.nodeKind === 'source' && node.source !== undefined) {
      const file = this.#store?.getSourceMetadata(node.source.sourceId)?.sourceKind === 'exact_file';
      const reference: CollectionReferenceIdentity = { providerId: node.source.provider, sourceId: node.source.sourceId, nativeId: file ? '@file' : '@source', referenceKind: file ? 'file' : 'source' };
      return this.collectionReferenceLabel(reference) === undefined ? undefined : reference;
    }
    if (node.nodeKind !== 'entity' || node.entity === undefined) return undefined;
    const reference: CollectionReferenceIdentity = { providerId: node.entity.provider, sourceId: node.entity.sourceId, nativeId: node.entity.nativeId, referenceKind: 'session' };
    const current = this.#store?.getEntity(reference.sourceId, reference.nativeId);
    return current?.generation === node.entity.generation && this.collectionReferenceLabel(reference) !== undefined ? reference : undefined;
  }

  private collectionReferenceLabel(reference: CollectionReferenceIdentity): string | undefined {
    if (this.#disposed || this.#store === undefined) return undefined;
    const candidates = reference.referenceKind === 'file' ? this.configuredSources() : this.settings();
    const setting = candidates.find((source) => sourceIdFor(source) === reference.sourceId && source.provider === reference.providerId);
    if (setting === undefined) return undefined;
    if (reference.referenceKind === 'source') return reference.nativeId === '@source' ? sourceLabelFor(setting) : undefined;
    if (reference.referenceKind === 'file') {
      const metadata = this.#store.getSourceMetadata(reference.sourceId);
      return reference.nativeId === '@file' && metadata?.providerId === reference.providerId && metadata.sourceKind === 'exact_file'
        && metadata.authorizationState === 'authorized' && metadata.canonicalUri === setting.rootUri ? sourceLabelFor(setting) : undefined;
    }
    if (this.#store.getSourceProvider(reference.sourceId) !== reference.providerId) return undefined;
    const entity = this.#store.getEntity(reference.sourceId, reference.nativeId);
    return entity?.provider === reference.providerId ? entity.label : undefined;
  }

  private async openCollectionSource(reference: CollectionReferenceIdentity): Promise<void> {
    const metadata = reference.referenceKind === 'file' ? this.#store?.getSourceMetadata(reference.sourceId) : undefined;
    const uri = reference.referenceKind === 'file' ? metadata?.canonicalUri : this.#store?.getSourceRoot(reference.sourceId);
    if (uri === undefined || this.collectionReferenceLabel(reference) === undefined) return;
    const source = vscode.Uri.parse(uri);
    if (source.scheme !== 'file') return;
    const canonical = await realpath(source.fsPath).catch(() => undefined);
    const currentUri = () => reference.referenceKind === 'file' ? this.#store?.getSourceMetadata(reference.sourceId)?.canonicalUri : this.#store?.getSourceRoot(reference.sourceId);
    if (canonical === undefined || !sameLocalPath(canonical, source.fsPath) || this.collectionReferenceLabel(reference) === undefined || currentUri() !== uri) return;
    const file = await isRegularFile(canonical);
    if (this.collectionReferenceLabel(reference) === undefined || currentUri() !== uri) return;
    if (reference.referenceKind === 'file' && !file) return;
    await vscode.commands.executeCommand(file ? 'vscode.openWith' : 'revealInExplorer', vscode.Uri.file(canonical), ...(file ? ['jsonlView.editor'] : []));
  }

  private async pickCollectionReference(purpose: 'add' | 'rebind'): Promise<{ readonly identity: CollectionReferenceIdentity; readonly isCurrent: () => boolean } | undefined> {
    // Read persisted catalog rows even before Sessions is expanded. Source
    // registration and scanning still belong to the independent Sessions path.
    if (!this.#disposed && (this.settings().length > 0 || this.configuredSources().length > 0)) await this.ensureStore(false);
    if (this.#disposed) return undefined;
    const sources = new Map<string, { readonly label: string; readonly description: string; readonly identity: CollectionReferenceIdentity }>();
    for (const source of this.#store?.listSources() ?? []) {
      const identity = this.collectionReferenceForNode({ nodeKind: 'source', source });
      if (identity !== undefined) sources.set(identity.sourceId, { label: source.label, description: source.provider, identity });
    }
    for (const metadata of this.#store?.listSourceMetadata() ?? []) {
      if (metadata.sourceKind !== 'exact_file' || metadata.authorizationState !== 'authorized') continue;
      const setting = this.configuredSources().find((candidate) => sourceIdFor(candidate) === metadata.sourceId && candidate.provider === metadata.providerId);
      if (setting === undefined) continue;
      const identity: CollectionReferenceIdentity = { providerId: setting.provider, sourceId: metadata.sourceId, nativeId: '@file', referenceKind: 'file' };
      const label = this.collectionReferenceLabel(identity);
      if (label !== undefined) sources.set(identity.sourceId, { label, description: setting.provider, identity });
    }
    const choices = [...sources.values()];
    if (choices.length === 0) {
      void vscode.window.showInformationMessage('No authorized references are available in the catalog. Use Add Source to import a source, or open Agent Sessions to load existing sources, then add a reference to a Collection.');
      return undefined;
    }
    const title = purpose === 'add' ? 'Add Existing Reference' : 'Rebind Reference';
    const source = await vscode.window.showQuickPick(choices, { title: title + ': Choose Authorized Source' });
    if (source === undefined || this.collectionReferenceLabel(source.identity) === undefined) return undefined;
    const sourceUri = source.identity.referenceKind === 'file'
      ? this.#store?.getSourceMetadata(source.identity.sourceId)?.canonicalUri
      : this.#store?.getSourceRoot(source.identity.sourceId);
    const currentUri = () => source.identity.referenceKind === 'file'
      ? this.#store?.getSourceMetadata(source.identity.sourceId)?.canonicalUri
      : this.#store?.getSourceRoot(source.identity.sourceId);
    const sourceCurrent = () => sourceUri !== undefined && this.collectionReferenceLabel(source.identity) !== undefined && currentUri() === sourceUri;
    let cursor: string | undefined;
    for (;;) {
      if (!sourceCurrent()) return undefined;
      const page = this.#store?.getChildrenPage(source.identity.sourceId, undefined, 'title', { limit: 50, ...(cursor === undefined ? {} : { cursor }) });
      if (page === undefined) return undefined;
      const options = [
        { label: source.identity.referenceKind === 'file' ? 'Use registered file reference' : 'Use source reference', value: 'source' },
        { label: 'Enter exact session ID…', value: 'id' },
        ...page.entities.map((entity) => ({ label: entity.label, description: 'Session', value: entity.nativeId, entity })),
        ...(page.nextCursor === undefined ? [] : [{ label: 'Next page…', value: 'next' }]),
      ];
      const choice = await vscode.window.showQuickPick(options, { title, placeHolder: 'Select an existing target; this does not authorize or scan sources' });
      if (choice === undefined || !sourceCurrent()) return undefined;
      if (choice.value === 'next' && !('entity' in choice)) { cursor = page.nextCursor; continue; }
      if (choice.value === 'source' && !('entity' in choice)) return { identity: source.identity, isCurrent: sourceCurrent };
      const nativeId = 'entity' in choice ? choice.entity.nativeId : await vscode.window.showInputBox({ title: title + ': Exact Session ID', prompt: 'Native ID within this authorized source. No title matching or source scan.', ignoreFocusOut: true });
      if (nativeId === undefined || !sourceCurrent()) return undefined;
      const current = this.#store?.getEntity(source.identity.sourceId, nativeId);
      if (current === undefined || ('entity' in choice && current.generation !== choice.entity.generation)) return undefined;
      const identity: CollectionReferenceIdentity = { providerId: source.identity.providerId, sourceId: source.identity.sourceId, nativeId, referenceKind: 'session' };
      return { identity, isCurrent: () => sourceCurrent() && this.#store?.getEntity(identity.sourceId, identity.nativeId)?.generation === current.generation
        && this.collectionReferenceLabel(identity) !== undefined };
    }
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
      try { await this.authorizeSourceSetting(detected, cancelled); }
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

  private async authorizeSourceSetting(setting: AuthorizedSourceSetting, cancelled = () => false, refreshAfterAuthorization = true): Promise<void> {
    if (this.#disposed || cancelled()) return;
    const sourceId = sourceIdFor(setting);
    const excluded = this.#context.globalState.get<string[]>(EXCLUDED_SOURCES_KEY, []);
    const nextExcluded = excluded.filter((id) => id !== sourceId);
    await this.#context.globalState.update(EXCLUDED_SOURCES_KEY, nextExcluded);
    if (this.#disposed || cancelled()) return;
    const current = this.configuredSources();
    const alreadyAuthorized = current.some((candidate) => sourceIdFor(candidate) === sourceId);
    const next = parseAuthorizedSources([...current, setting]);
    if (!refreshAfterAuthorization) {
      this.#metadataOnlySourceIds.add(sourceId);
      this.#metadataOnlySourceSettings = next;
    }
    try {
      await vscode.workspace.getConfiguration('jsonlView').update(SOURCES_SETTING, next, vscode.ConfigurationTarget.Global);
    } catch (error) {
      if (!refreshAfterAuthorization && !sameSourceSettings(this.configuredSources(), next)) {
        this.#metadataOnlySourceSettings = undefined;
        this.#metadataOnlySourceIds.delete(sourceId);
      }
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
        if (!refreshAfterAuthorization) this.#metadataOnlySourceSettings = current;
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
    if (refreshAfterAuthorization && this.isEnabled()) await this.refresh();
  }

  private async handleSourceTreeAction(action: SourceTreeAction, signal?: AbortSignal): Promise<void> {
    const cancelled = () => this.#disposed || signal?.aborted === true;
    if (cancelled()) return;
    if (action === 'paste') {
      this.#intake.show();
      return;
    }
    const selection = await vscode.window.showOpenDialog({
      canSelectFiles: action === 'files',
      canSelectFolders: action === 'folder',
      canSelectMany: action === 'files',
      openLabel: 'Add Source',
      ...(action === 'files' ? { filters: { 'JSONL / NDJSON': ['jsonl', 'ndjson'], 'All files': ['*'] } } : {}),
    });
    if (selection === undefined) return;
    if (cancelled()) return;
    if (action === 'files') {
      let canonical: readonly vscode.Uri[] | undefined;
      try {
        canonical = await validateSourceSelection(selection, validateLocalSourceUri, cancelled);
      } catch (error) {
        if (!cancelled()) void vscode.window.showWarningMessage(error instanceof Error ? error.message : String(error));
        return;
      }
      if (canonical === undefined || cancelled()) return;
      const openedTargets: vscode.Uri[] = [];
      for (const uri of canonical) {
        if (cancelled()) return;
        const authorized = await this.confirmCanonicalSource(uri, cancelled);
        if (authorized && hasJsonlExtension(uri.fsPath)) openedTargets.push(uri);
      }
      if (openedTargets.length === 1 && !cancelled()) {
        await vscode.commands.executeCommand('vscode.openWith', openedTargets[0]!, 'jsonlView.editor');
      } else if (openedTargets.length > 1 && !this.isEnabled() && !cancelled()) {
        void vscode.window.showInformationMessage(
          `Authorized ${String(openedTargets.length)} read-only sources. Enable Session Navigator to browse them in the sidebar.`,
          'Enable',
        ).then((choice) => {
          if (choice !== 'Enable' || cancelled() || this.#disposed) return;
          void this.setEnabled(true).then((enabled) => {
            if (!enabled && !this.#disposed) {
              void vscode.window.showWarningMessage('Session Navigator could not be enabled. Check the effective setting and try again.');
            }
          }, () => {
            if (!this.#disposed) void vscode.window.showWarningMessage('Session Navigator could not be enabled. Check the effective setting and try again.');
          });
        });
      }
      return;
    }
    for (const uri of selection) await this.confirmCustomSource(uri, cancelled);
  }

  private async confirmCustomSource(uri: vscode.Uri, cancelled: () => boolean): Promise<void> {
    if (cancelled() || this.#disposed) return;
    let canonical: vscode.Uri;
    try { canonical = await validateLocalSourceUri(uri.toString()); }
    catch (error) {
      if (!cancelled() && !this.#disposed) void vscode.window.showWarningMessage(error instanceof Error ? error.message : String(error));
      return;
    }
    await this.confirmCanonicalSource(canonical, cancelled);
  }

  private async confirmCanonicalSource(canonical: vscode.Uri, cancelled: () => boolean): Promise<boolean> {
    if (cancelled() || this.#disposed) return false;
    const action = await vscode.window.showWarningMessage(
      `Add ${canonical.fsPath} as a read-only source?`,
      { modal: true },
      'Add source',
    );
    if (action !== 'Add source' || cancelled() || this.#disposed) return false;
    const provider = await vscode.window.showQuickPick(
      SOURCE_PROVIDER_CHOICES,
      { placeHolder: 'Choose the source format to authorize' },
    );
    if (provider === undefined || cancelled() || this.#disposed) return false;
    await this.authorizeSourceUri(provider.value, canonical, cancelled);
    return !cancelled() && !this.#disposed;
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

  private handleSessionVisibility(visible: boolean): void {
    this.#sessionViewVisible = visible;
    this.publishNavigatorVisibility();
    if (this.isSessionPollingEligible()) {
      const pollingWasActive = this.#probeTimer !== undefined;
      if (!pollingWasActive) {
        this.#probeTimer = setInterval(() => { void this.probeVisibleSources(); }, PROBE_INTERVAL_MS);
      }
      if (!this.#initialized) {
        this.#initialized = true;
        if (this.#scanController?.signal.aborted) this.#refreshAgain = true;
        void this.refresh(false);
      } else if (!pollingWasActive) {
        void this.probeVisibleSources();
      }
    } else {
      if (this.#scanController !== undefined || [...this.#sourceStatus.values()].some((status) => status.phase === 'error')) this.#initialized = false;
      this.#scanController?.abort();
      this.#probeController?.abort();
      this.invalidateAllSources();
      if (this.#probeTimer !== undefined) clearInterval(this.#probeTimer);
      this.#probeTimer = undefined;
    }
  }

  private isSessionPollingEligible(): boolean {
    return !this.#disposed && this.#treeView?.visible === true && this.#windowFocused && this.isEnabled() && this.settings().length > 0;
  }

  private handleCollectionsVisibility(visible: boolean): void {
    this.#collectionsVisible = visible;
    this.publishNavigatorVisibility();
  }

  private publishNavigatorVisibility(): void {
    const visible = this.#sessionViewVisible || this.#collectionsVisible;
    if (this.#reportedNavigatorVisibility === visible) return;
    this.#reportedNavigatorVisibility = visible;
    this.#visibilityChanged.fire(visible);
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

  private async focusNavigatorView(): Promise<boolean> {
    try {
      await vscode.commands.executeCommand('workbench.view.extension.jsonlViewSessionNavigator');
    } catch {
      return false;
    }
    // Preserve the user's native panel layout and current tree selection.
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
    let sourceId = target === undefined ? undefined : this.sourceIdForTarget(target.sourceUri);
    if (target !== undefined && sourceId === undefined) {
      if (this.#treeView !== undefined) this.#treeView.message = 'Use Add Source to explicitly import and authorize this file; Collections membership grants no source access.';
      await this.addSource();
      if (this.#disposed) return disabled('cancelled');
      if (!this.isEnabled()) return disabled('cancelled');
      sourceId = this.sourceIdForTarget(target.sourceUri);
      if (sourceId === undefined) {
        return {
          version: 1, status: 'authorization-required', enabled: 'enabled', authorization: 'required', authorizationReadback: 'not-requested',
          action: 'focus-add-source', errorCode: 'AUTHORIZATION_REQUIRED', stage: 'authorization', recoverable: true,
        };
      }
    }
    const authorized = this.settings().length > 0;
    const opened = await this.focusNavigatorView();
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

  private probeVisibleSources(): Promise<void> {
    if (!this.isSessionPollingEligible()) return Promise.resolve();
    if (this.#probeFlight !== undefined && !this.#probeController?.signal.aborted) return this.#probeFlight;
    const controller = new AbortController();
    this.#probeController = controller;
    const flight = this.runVisibleSourceProbe(controller.signal).finally(() => {
      if (this.#probeController === controller) this.#probeController = undefined;
      if (this.#probeFlight === flight) this.#probeFlight = undefined;
    });
    this.#probeFlight = flight;
    return flight;
  }

  private async runVisibleSourceProbe(signal: AbortSignal): Promise<void> {
    if (signal.aborted || !this.isSessionPollingEligible()) return;
    try {
      const store = await this.ensureStore();
      let detectedChange = false;
      for (const setting of this.settings()) {
        if (signal.aborted || !this.isSessionPollingEligible()) return;
        const sourceId = sourceIdFor(setting);
        if (this.#metadataOnlySourceIds.has(sourceId)) continue;
        const provider = this.providerFor(setting);
        try {
          const fingerprint = await provider.probe(signal);
          if (signal.aborted || !this.isSessionPollingEligible()) return;
          const previous = store.getFingerprint(sourceId);
          if (previous !== undefined) {
            const changed = fingerprint !== previous;
            store.markUpdateAvailable(sourceId, changed);
            detectedChange ||= changed;
            if (changed) this.#observedFingerprints.set(sourceId, { baseline: previous, fingerprint });
            else this.#observedFingerprints.delete(sourceId);
          }
        } catch {
          // Keep the current catalog on probe failure; a later probe or manual refresh can retry.
        }
      }
      if (signal.aborted || !this.isSessionPollingEligible()) return;
      this.#changed.fire(undefined);
      if (detectedChange && !signal.aborted && this.isSessionPollingEligible()) {
        if (this.#refreshing !== undefined) this.#refreshAgain = true;
        else await this.refresh(false);
      }
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

function sameLocalPath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function detectedProviderIcon(provider: DetectedAgentProviderId): string {
  switch (provider) {
    case 'codex': return 'terminal';
    case 'claude': return 'comment-discussion';
    case 'pi': return 'terminal';
    case 'kimi': return 'globe';
    case 'gemini': return 'sparkle';
    case 'opencode': return 'code';
    case 'agentsview': return 'list-tree';
    default: return 'plug';
  }
}

async function isRegularFile(path: string): Promise<boolean> {
  try { return (await lstat(path)).isFile(); } catch { return false; }
}

async function forEachBounded<T>(values: readonly T[], concurrency: number, action: (value: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(values.length, concurrency) }, async () => {
    while (next < values.length) {
      const index = next++;
      await action(values[index]!);
    }
  }));
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
