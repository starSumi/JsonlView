import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { CollectionsError, type CollectionEntryReference, type CollectionReferenceIdentity, type CollectionsMutationReceipt, type CollectionsPage, type CollectionsPageRequest, type CollectionsPort, type UserCollection } from '@application/index';
import { CollectionsStore, type CollectionsMutationInput } from '@infrastructure/navigator/collections-store';
import { CollectionsMutationRecovery, type CollectionsMutationState } from './collections-recovery';
import { parseSessionReferenceDragPayload, SESSION_NAVIGATOR_TREE_MIME, SESSION_REFERENCE_DND_LIMIT, SESSION_REFERENCE_MIME, type SessionReferenceDragItem } from './session-reference-dnd';

export type CollectionsTreeNode =
  | { readonly kind: 'collection'; readonly collection: UserCollection; readonly revision: string }
  | { readonly kind: 'add-reference'; readonly collectionId: string; readonly revision: string }
  | { readonly kind: 'entry'; readonly entry: CollectionEntryReference; readonly revision: string }
  | { readonly kind: 'page'; readonly collectionId?: string; readonly cursor: string }
  | { readonly kind: 'notice'; readonly message: string };
type CollectionEntryNode = Extract<CollectionsTreeNode, { readonly kind: 'entry' }>;

export interface CollectionsHost {
  /** Reads an already authorized catalog only; never creates, authorizes, probes or scans a source. */
  readonly referenceForNode: (node: unknown) => CollectionReferenceIdentity | undefined;
  readonly labelForReference: (reference: CollectionReferenceIdentity) => string | undefined;
  readonly openReference: (reference: CollectionReferenceIdentity) => Promise<void>;
  readonly pickReference?: (purpose: 'add' | 'rebind') => Promise<{ readonly identity: CollectionReferenceIdentity; readonly isCurrent: () => boolean } | undefined>;
  /** Resolves an untrusted drag token through the current authorized catalog and exact generation. */
  readonly referenceForDraggedSession?: (reference: SessionReferenceDragItem) => CollectionReferenceIdentity | undefined;
}

type StoreOpener = (path: string) => Promise<CollectionsPort>;

/** User metadata has its own lifecycle/event owner, independent of the runtime session projection. */
export class CollectionsTreeProvider implements vscode.TreeDataProvider<CollectionsTreeNode>, vscode.Disposable {
  readonly #changed = new vscode.EventEmitter<CollectionsTreeNode | CollectionsTreeNode[] | undefined>();
  readonly #path: string;
  readonly #host: CollectionsHost;
  readonly #open: StoreOpener;
  readonly #recovery: CollectionsMutationRecovery;
  #commands: Promise<unknown> = Promise.resolve();
  #recoveryError: string | undefined;
  #store: CollectionsPort | undefined;
  #opening: Promise<CollectionsPort | undefined> | undefined;
  #issued = new WeakSet<object>();
  readonly #renderedReferenceLabels = new Map<CollectionEntryNode, string | undefined>();
  #epoch = 0;
  #disposed = false;
  public readonly onDidChangeTreeData = this.#changed.event;
  public readonly dropMimeTypes: readonly string[] = [SESSION_REFERENCE_MIME, SESSION_NAVIGATOR_TREE_MIME];

  public constructor(storageRoot: string, host: CollectionsHost, state: CollectionsMutationState, open: StoreOpener = CollectionsStore.open) {
    this.#path = join(storageRoot, 'collections', 'metadata.sqlite');
    this.#host = host;
    this.#open = open;
    this.#recovery = new CollectionsMutationRecovery(state, () => !this.#disposed, (command) => {
      if (command.action === 'rebindEntry' && this.#host.labelForReference(command.payload.identity) === undefined) throw new CollectionsError('SOURCE_UNAVAILABLE');
    });
  }

  public register(): vscode.Disposable[] {
    const command = (suffix: string, action: (node: unknown) => Promise<void> | void, mutation = true) => vscode.commands.registerCommand(
      'jsonlView.sessionNavigator.collections.' + suffix,
      (node: unknown) => this.run(() => mutation ? this.mutate(() => action(node)) : action(node)),
    );
    return [
      command('create', () => this.create()), command('rename', (node) => this.rename(node)),
      command('delete', (node) => this.delete(node)), command('fileInto', (node) => this.fileInto(node)),
      command('addReference', (node) => this.addReference(node)),
      command('unfile', (node) => this.unfile(node)), command('open', (node) => this.openEntry(node), false),
      command('refresh', () => this.retryRecovery(), false),
      command('alias', (node) => this.alias(node)), command('archive', (node) => this.archive(node, true)),
      command('restore', (node) => this.archive(node, false)), command('rebind', (node) => this.rebind(node)),
    ];
  }

  public refresh(): void {
    if (this.#disposed) return;
    this.#epoch++;
    this.#issued = new WeakSet();
    this.#renderedReferenceLabels.clear();
    this.#changed.fire(undefined);
  }

  public async listCollectionsPage(request?: CollectionsPageRequest): Promise<CollectionsPage<UserCollection>> {
    const store = await this.store(false);
    return store?.listCollections(request) ?? { items: [], metadataRevision: '0' };
  }

  /** Files a previously authorized exact-file identity through the shared mutation journal. */
  public async addSavedFileReference(
    identity: CollectionReferenceIdentity,
    destination: { readonly collectionId?: string; readonly displayName?: string; readonly expectedRevision: string },
    isCurrent: () => boolean,
  ): Promise<void> {
    await this.mutate(async () => {
      const store = await this.store(true);
      if (store === undefined || this.#disposed) return;
      this.assertReferenceCurrent(identity, isCurrent);
      let collectionId = destination.collectionId;
      let expectedRevision = destination.expectedRevision;
      if (collectionId === undefined) {
        if (destination.displayName === undefined) return;
        const created = await this.apply(store, { expectedRevision, action: 'createCollection', payload: { displayName: destination.displayName } }, () => this.assertReferenceCurrent(identity, isCurrent));
        if (created.result === null || typeof created.result !== 'object' || !('collectionId' in created.result) || typeof created.result.collectionId !== 'string') {
          throw new CollectionsError('METADATA_UNAVAILABLE');
        }
        collectionId = created.result.collectionId;
        expectedRevision = created.metadataRevision;
      }
      const receipt = await this.apply(store, {
        expectedRevision, action: 'addEntry', payload: { collectionId, identity },
      }, () => this.assertReferenceCurrent(identity, isCurrent));
      this.refresh();
      void vscode.window.showInformationMessage(receipt.changed ? 'Saved file added to Collection.' : 'This file is already in that Collection.');
    });
  }

  /** Refreshes only materialized reference rows whose current authorized label changed. */
  public refreshReferenceLabels(): void {
    if (this.#disposed) return;
    const changed: CollectionEntryNode[] = [];
    for (const [node, previousLabel] of this.#renderedReferenceLabels) {
      const label = this.#host.labelForReference(node.entry);
      if (label === previousLabel) continue;
      this.#renderedReferenceLabels.set(node, label);
      changed.push(node);
    }
    if (changed.length > 0) this.#changed.fire(changed);
  }

  /** Returns only an issued, currently available session entry for an in-app drag. */
  public sessionReferenceForDrag(value: unknown): CollectionReferenceIdentity | undefined {
    if (!this.current(value) || value.kind !== 'entry' || value.entry.referenceKind !== 'session'
      || this.#host.labelForReference(value.entry) === undefined) return undefined;
    return this.identityForEntry(value.entry);
  }

  /** Metadata-only projection; failures leave Session Navigator browsing visible. */
  public async archivedSessionReferences(identities: readonly CollectionReferenceIdentity[]): Promise<readonly CollectionReferenceIdentity[]> {
    if (this.#disposed || identities.length === 0) return [];
    try {
      const store = await this.store(false);
      if (this.#disposed || store === undefined) return [];
      return store.listArchivedSessionReferences(identities);
    } catch {
      return [];
    }
  }

  public handleDrop(target: CollectionsTreeNode | undefined, dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): Promise<void> {
    return this.run(() => this.mutate(() => this.dropReferences(target, dataTransfer, token)));
  }

  private async dropReferences(target: CollectionsTreeNode | undefined, dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): Promise<void> {
    if (token.isCancellationRequested || !this.current(target) || target.kind !== 'collection') return;
    const transfer = dataTransfer.get(SESSION_REFERENCE_MIME) ?? dataTransfer.get(SESSION_NAVIGATOR_TREE_MIME);
    if (transfer === undefined) return;
    const text = await transfer.asString();
    if (token.isCancellationRequested || !this.current(target)) return;
    const payload = parseSessionReferenceDragPayload(text);
    if (payload === undefined) {
      void vscode.window.showWarningMessage('Collections: the session reference drop is invalid or exceeds its limit.');
      return;
    }
    const store = await this.store(false);
    if (store === undefined || token.isCancellationRequested || !this.current(target)) return;
    let expectedRevision = target.revision;
    let added = 0;
    let unavailable = 0;
    for (const dragged of payload.references.slice(0, SESSION_REFERENCE_DND_LIMIT)) {
      if (token.isCancellationRequested || this.#disposed || !this.current(target)) break;
      const identity = this.#host.referenceForDraggedSession?.(dragged);
      if (identity === undefined || identity.referenceKind !== 'session'
        || identity.providerId !== dragged.providerId || identity.sourceId !== dragged.sourceId || identity.nativeId !== dragged.nativeId
        || this.#host.labelForReference(identity) === undefined) {
        unavailable++;
        continue;
      }
      const guard = () => {
        if (!this.current(target) || this.#host.labelForReference(identity) === undefined
          || JSON.stringify(this.#host.referenceForDraggedSession?.(dragged)) !== JSON.stringify(identity)) throw new CollectionsError('SOURCE_UNAVAILABLE');
      };
      guard();
      const receipt = await this.apply(store, {
        expectedRevision,
        action: 'addEntry',
        payload: { collectionId: target.collection.collectionId, identity },
      }, guard);
      expectedRevision = receipt.metadataRevision;
      if (receipt.changed) added++;
    }
    if (added > 0 || unavailable > 0) this.refresh();
    if (unavailable > 0) void vscode.window.showWarningMessage(`${String(unavailable)} session reference(s) were stale or no longer authorized and were skipped.`);
  }

  public getTreeItem(node: CollectionsTreeNode): vscode.TreeItem {
    const item = new vscode.TreeItem('', vscode.TreeItemCollapsibleState.None);
    if (node.kind === 'collection') {
      item.label = node.collection.displayName;
      item.id = 'collection:' + node.collection.collectionId;
      item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
      item.contextValue = 'jsonlView.collection';
      item.description = String(node.collection.entryCount) + ' references';
      item.iconPath = new vscode.ThemeIcon('library');
      item.tooltip = 'A user-owned collection. Removing it removes only collection metadata and links.';
    } else if (node.kind === 'add-reference') {
      item.label = 'Add an existing reference…';
      item.id = 'collection-add-reference:' + node.collectionId;
      item.contextValue = 'jsonlView.collection.addReference';
      item.iconPath = new vscode.ThemeIcon('add');
      item.tooltip = 'Choose an authorized source, registered file or indexed session. Import new sources separately with Add Source.';
      item.command = { command: 'jsonlView.sessionNavigator.collections.addReference', title: 'Add Existing Reference', arguments: [node] };
    } else if (node.kind === 'entry') {
      const label = this.#host.labelForReference(node.entry);
      // A queued host callback may render a node after a root refresh invalidated it.
      // Do not let that stale callback repopulate the current projection cache.
      if (this.#issued.has(node)) this.#renderedReferenceLabels.set(node, label);
      item.label = label === undefined ? 'Source unavailable' : node.entry.displayAlias ?? label;
      item.id = 'collection-entry:' + node.entry.collectionId + ':' + node.entry.entryId;
      item.contextValue = (label === undefined ? 'jsonlView.collection.entry.unavailable' : 'jsonlView.collection.entry.' + node.entry.referenceKind)
        + (node.entry.localArchivedAtMs === undefined ? '' : '.archived');
      item.iconPath = new vscode.ThemeIcon(label === undefined ? 'circle-slash' : node.entry.referenceKind === 'source' ? 'folder' : 'file');
      item.description = label === undefined ? 'Reference retained · remove link available' : node.entry.localArchivedAtMs === undefined ? 'Reference' : 'Local archive intent';
      item.tooltip = label === undefined ? 'No current authorized catalog entry. Collection membership grants no source access.' : 'Open the currently authorized source in JsonlView.';
      if (label !== undefined) item.command = { command: 'jsonlView.sessionNavigator.collections.open', title: 'Open reference', arguments: [node] };
    } else if (node.kind === 'page') {
      item.label = 'More collections…';
      if (node.collectionId !== undefined) item.label = 'More references…';
      item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
      item.iconPath = new vscode.ThemeIcon('ellipsis');
    } else {
      item.label = node.message;
      item.iconPath = new vscode.ThemeIcon('info');
    }
    return item;
  }

  public async getChildren(node?: CollectionsTreeNode): Promise<CollectionsTreeNode[]> {
    if (this.#disposed || (node !== undefined && !this.current(node))) return [];
    if (node?.kind === 'entry' || node?.kind === 'notice' || node?.kind === 'add-reference') return [];
    const epoch = this.#epoch;
    try {
      const store = await this.store(false);
      if (this.#disposed || epoch !== this.#epoch) return [];
      if (store === undefined) return this.issue([{ kind: 'notice', message: 'Create a collection to organize source references.' }]);
      const collectionId = node?.kind === 'collection' ? node.collection.collectionId : node?.collectionId;
      const request = node?.kind === 'page' ? { cursor: node.cursor } : {};
      const page = collectionId === undefined ? store.listCollections(request) : store.listEntries(collectionId, request);
      const nodes: CollectionsTreeNode[] = collectionId === undefined
        ? (page.items as readonly UserCollection[]).map((collection) => ({ kind: 'collection', collection, revision: page.metadataRevision }))
        : (page.items as readonly CollectionEntryReference[]).map((entry) => ({ kind: 'entry', entry, revision: page.metadataRevision }));
      if (page.nextCursor !== undefined) nodes.push({ kind: 'page', ...(collectionId === undefined ? {} : { collectionId }), cursor: page.nextCursor });
      if (nodes.length === 0) nodes.push(collectionId === undefined
        ? { kind: 'notice', message: 'No collections. Use New Collection.' }
        : { kind: 'add-reference', collectionId, revision: page.metadataRevision });
      if (node === undefined && this.#recoveryError !== undefined) nodes.unshift({ kind: 'notice',
        message: `Pending change: ${this.#recoveryError}. Metadata remains readable; new changes are paused. Refresh Collections retries recovery.` });
      return this.issue(nodes);
    } catch {
      return this.#disposed || epoch !== this.#epoch ? [] : this.issue([{ kind: 'notice', message: 'Collections unavailable. Refresh to retry; metadata is retained.' }]);
    }
  }

  private issue(nodes: CollectionsTreeNode[]): CollectionsTreeNode[] { for (const node of nodes) this.#issued.add(node); return nodes; }

  private async create(): Promise<void> {
    const epoch = this.#epoch;
    const existing = await this.store(false);
    if (this.#disposed || epoch !== this.#epoch) return;
    const revision = existing?.listCollections().metadataRevision ?? '0';
    const name = await vscode.window.showInputBox({ title: 'New Collection', prompt: 'Collection name (metadata only)', ignoreFocusOut: true });
    if (name === undefined || this.#disposed || epoch !== this.#epoch) return;
    const store = await this.store(true);
    if (store === undefined || this.#disposed || epoch !== this.#epoch) return;
    const input = { expectedRevision: revision, action: 'createCollection' as const, payload: { displayName: name } };
    await this.apply(store, input);
    this.refresh();
  }

  private async rename(value: unknown): Promise<void> {
    const node = this.collectionNode(value);
    if (node === undefined) return;
    const name = await vscode.window.showInputBox({ title: 'Rename Collection', value: node.collection.displayName, ignoreFocusOut: true });
    if (name === undefined || !this.current(node)) return;
    const store = await this.store(true);
    if (store === undefined || !this.current(node)) return;
    const input = { expectedRevision: node.revision, action: 'renameCollection' as const, payload: { collectionId: node.collection.collectionId, displayName: name } };
    await this.apply(store, input);
    this.refresh();
  }

  private async delete(value: unknown): Promise<void> {
    const node = this.collectionNode(value);
    if (node === undefined) return;
    const choice = await vscode.window.showWarningMessage('Delete this collection and its links? Source files and other collections are preserved.', { modal: true }, 'Delete Collection');
    if (choice !== 'Delete Collection' || !this.current(node)) return;
    const store = await this.store(true);
    if (store === undefined || !this.current(node)) return;
    const input = { expectedRevision: node.revision, action: 'deleteCollection' as const, payload: { collectionId: node.collection.collectionId } };
    await this.apply(store, input);
    this.refresh();
  }

  private async fileInto(value: unknown): Promise<void> {
    const entry = this.current(value) && value.kind === 'entry' ? value : undefined;
    const reference = entry === undefined ? this.#host.referenceForNode(value) : this.identityForEntry(entry.entry);
    if (reference === undefined) return;
    const epoch = this.#epoch;
    const store = await this.store(false);
    if (this.#disposed || epoch !== this.#epoch) return;
    if (store === undefined) { void vscode.window.showInformationMessage('Create a collection first, then use Add Reference to Collection on a source or session item.'); return; }
    let cursor: string | undefined;
    for (;;) {
      const page = store.listCollections(cursor === undefined ? {} : { cursor });
      const options = page.items.map((collection) => ({ label: collection.displayName, collectionId: collection.collectionId }));
      if (page.nextCursor !== undefined) options.push({ label: 'Next page…', collectionId: '' });
      if (options.length === 0) { void vscode.window.showInformationMessage('Create a collection first.'); return; }
      const choice = await vscode.window.showQuickPick(options, { title: 'Add Reference to Collection', placeHolder: 'Adds a link only; source access stays separate' });
      if (choice === undefined || this.#disposed || epoch !== this.#epoch) return;
      if (choice.collectionId === '') { cursor = page.nextCursor; continue; }
      if (entry !== undefined && choice.collectionId === entry.entry.collectionId) {
        void vscode.window.showInformationMessage('This reference is already in that Collection.');
        return;
      }
      if (entry !== undefined && !this.current(entry)) return;
      const current = entry === undefined ? this.#host.referenceForNode(value) : this.identityForEntry(entry.entry);
      if (current === undefined || JSON.stringify(current) !== JSON.stringify(reference)) return;
      const input = { expectedRevision: page.metadataRevision, action: 'addEntry' as const, payload: { collectionId: choice.collectionId, identity: current } };
      await this.apply(store, input);
      this.refresh();
      return;
    }
  }

  private async addReference(value: unknown): Promise<void> {
    if (!this.current(value) || (value.kind !== 'collection' && value.kind !== 'add-reference') || this.#host.pickReference === undefined) return;
    const collectionId = value.kind === 'collection' ? value.collection.collectionId : value.collectionId;
    const candidate = await this.#host.pickReference('add');
    if (candidate === undefined || !this.current(value) || !candidate.isCurrent() || this.#host.labelForReference(candidate.identity) === undefined) return;
    const store = await this.store(true);
    if (store === undefined || !this.current(value)) return;
    const guard = () => { if (!this.current(value) || !candidate.isCurrent() || this.#host.labelForReference(candidate.identity) === undefined) throw new CollectionsError('SOURCE_UNAVAILABLE'); };
    guard();
    await this.apply(store, { expectedRevision: value.revision, action: 'addEntry', payload: { collectionId, identity: candidate.identity } }, guard);
    this.refresh();
  }

  private async unfile(value: unknown): Promise<void> {
    if (!this.current(value) || value.kind !== 'entry') return;
    const store = await this.store(true);
    if (store === undefined || !this.current(value)) return;
    const input = { expectedRevision: value.revision, action: 'removeEntry' as const, payload: { collectionId: value.entry.collectionId, entryId: value.entry.entryId } };
    await this.apply(store, input);
    this.refresh();
  }

  private async openEntry(value: unknown): Promise<void> {
    if (!this.current(value) || value.kind !== 'entry') return;
    if (this.#host.labelForReference(value.entry) !== undefined) await this.#host.openReference(value.entry);
  }

  private async alias(value: unknown): Promise<void> {
    if (!this.current(value) || value.kind !== 'entry' || this.#host.labelForReference(value.entry) === undefined) return;
    const alias = await vscode.window.showInputBox({ title: 'Rename Reference Alias', value: value.entry.displayAlias ?? '', prompt: 'Display metadata only. Leave empty to restore the source title.', ignoreFocusOut: true });
    if (alias === undefined || !this.current(value)) return;
    const store = await this.store(true);
    if (store === undefined || !this.current(value)) return;
    const guard = () => { if (!this.current(value) || this.#host.labelForReference(value.entry) === undefined) throw new CollectionsError('SOURCE_UNAVAILABLE'); };
    guard();
    await this.apply(store, { expectedRevision: value.revision, action: 'setAlias', payload: { entryId: value.entry.entryId, displayAlias: alias.trim() === '' ? null : alias } }, guard);
    this.refresh();
  }

  private async archive(value: unknown, archived: boolean): Promise<void> {
    if (!this.current(value) || value.kind !== 'entry' || value.entry.referenceKind !== 'session') return;
    if (archived && this.#host.labelForReference(value.entry) === undefined) return;
    if (archived === (value.entry.localArchivedAtMs !== undefined)) return;
    const store = await this.store(true);
    if (store === undefined || !this.current(value)) return;
    const guard = () => { if (!this.current(value) || (archived && this.#host.labelForReference(value.entry) === undefined)) throw new CollectionsError('SOURCE_UNAVAILABLE'); };
    guard();
    await this.apply(store, { expectedRevision: value.revision, action: 'setLocalArchive', payload: { entryId: value.entry.entryId, archivedAtMs: archived ? Date.now() : null } }, guard);
    this.refresh();
  }

  private async rebind(value: unknown): Promise<void> {
    if (!this.current(value) || value.kind !== 'entry' || this.#host.pickReference === undefined) return;
    const candidate = await this.#host.pickReference('rebind');
    if (candidate === undefined || !this.current(value) || !candidate.isCurrent()) return;
    const title = this.#host.labelForReference(candidate.identity);
    if (title === undefined) return;
    const choice = await vscode.window.showWarningMessage('Rebind this reference to ' + title + '? All of its collection links and display metadata follow the new identity. Source files are preserved.', { modal: true }, 'Rebind Reference');
    if (choice !== 'Rebind Reference' || !this.current(value) || !candidate.isCurrent()) return;
    const store = await this.store(true);
    if (store === undefined || !this.current(value)) return;
    const guard = () => { if (!this.current(value) || !candidate.isCurrent() || this.#host.labelForReference(candidate.identity) === undefined) throw new CollectionsError('SOURCE_UNAVAILABLE'); };
    guard();
    await this.apply(store, { expectedRevision: value.revision, action: 'rebindEntry', payload: { entryId: value.entry.entryId, identity: candidate.identity } }, guard);
    this.refresh();
  }

  private collectionNode(value: unknown): Extract<CollectionsTreeNode, { kind: 'collection' }> | undefined {
    return this.current(value) && value.kind === 'collection' ? value : undefined;
  }
  private identityForEntry(entry: CollectionEntryReference): CollectionReferenceIdentity {
    return {
      providerId: entry.providerId,
      sourceId: entry.sourceId,
      nativeId: entry.nativeId,
      referenceKind: entry.referenceKind,
    };
  }
  private current(value: unknown): value is CollectionsTreeNode {
    return !this.#disposed && value !== null && typeof value === 'object' && this.#issued.has(value);
  }

  private async store(create: boolean): Promise<CollectionsPort | undefined> {
    if (this.#disposed) return undefined;
    if (this.#store !== undefined) return this.#store;
    if (this.#opening !== undefined) {
      await this.#opening;
      return this.#store ?? (create && !this.#disposed ? this.store(true) : undefined);
    }
    const opening = this.openStore(create);
    this.#opening = opening;
    try { return await opening; } finally { if (this.#opening === opening) this.#opening = undefined; }
  }

  private async openStore(create: boolean): Promise<CollectionsPort | undefined> {
    if (!create) {
      try { await stat(this.#path); } catch (error) {
        if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT' && !this.#recovery.hasPending()) return undefined;
        throw new CollectionsError('METADATA_UNAVAILABLE');
      }
    }
    if (this.#disposed) return undefined;
    const store = await this.#open(this.#path);
    if (this.#disposed) { store.close(); return undefined; }
    try { await this.recover(store); }
    catch { /* Pending failure blocks new writes while existing metadata stays readable. */ }
    if (this.#disposed) { store.close(); return undefined; }
    this.#store = store;
    return store;
  }

  private mutate(action: () => Promise<void> | void): Promise<void> {
    const next = this.#commands.then(async () => {
      if (this.#disposed) return;
      const store = await this.store(false);
      if (this.#disposed) return;
      if (store !== undefined) await this.recover(store);
      if (!this.#disposed) await action();
    });
    this.#commands = next.catch(() => undefined);
    return next;
  }

  private async recover(store: CollectionsPort): Promise<void> {
    try { await this.#recovery.recover(store); this.#recoveryError = undefined; }
    catch (error) { this.#recoveryError = error instanceof CollectionsError ? error.code : 'METADATA_UNAVAILABLE'; throw error; }
  }

  private async apply(store: CollectionsPort, input: CollectionsMutationInput, guard?: () => void): Promise<CollectionsMutationReceipt> {
    try {
      const receipt = await this.#recovery.execute(store, input, guard);
      this.#recoveryError = this.#recovery.hasPending(store) ? 'METADATA_UNAVAILABLE' : undefined;
      return receipt;
    }
    catch (error) {
      this.#recoveryError = this.#recovery.hasPending(store) ? error instanceof CollectionsError ? error.code : 'METADATA_UNAVAILABLE' : undefined;
      throw error;
    }
  }

  private referenceCurrent(identity: CollectionReferenceIdentity, isCurrent: () => boolean): boolean {
    return !this.#disposed && isCurrent() && this.#host.labelForReference(identity) !== undefined;
  }
  private assertReferenceCurrent(identity: CollectionReferenceIdentity, isCurrent: () => boolean): void {
    if (!this.referenceCurrent(identity, isCurrent)) throw new CollectionsError('SOURCE_UNAVAILABLE');
  }

  private async retryRecovery(): Promise<void> {
    try {
      const store = await this.store(false);
      if (!this.#disposed && store !== undefined) await this.recover(store);
    } finally { this.refresh(); }
  }

  private async run(action: () => Promise<void> | void): Promise<void> {
    if (this.#disposed) return;
    try { await action(); }
    catch (error) {
      if (this.#disposed) return;
      const code = error instanceof CollectionsError ? error.code : 'METADATA_UNAVAILABLE';
      void vscode.window.showWarningMessage('Collections: ' + code + '. Refresh and retry. Existing metadata is retained.');
      this.refresh();
    }
  }

  public dispose(): void {
    this.#disposed = true; this.#epoch++; this.#issued = new WeakSet(); this.#renderedReferenceLabels.clear();
    this.#store?.close(); this.#store = undefined; this.#changed.dispose();
  }
}
