import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CollectionsError, type CollectionReferenceIdentity, type CollectionsMutationCommand } from '../../src/application';
import { CollectionsStore } from '../../src/infrastructure/navigator/collections-store';
import { COLLECTIONS_SCHEMA_V2 } from '../../src/infrastructure/navigator/collections-schema';
import { CollectionsMutationRecovery, COLLECTIONS_PENDING_PREFIX } from '../../src/experimental/session-navigator/collections-recovery';

const ui = vi.hoisted(() => ({ commands: new Map<string, (node?: unknown) => Promise<void>>(), input: vi.fn(), warning: vi.fn(), picker: vi.fn() }));
vi.mock('vscode', () => ({
  EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
  TreeItem: class { constructor(public label: string, public collapsibleState: number) {} },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1 }, ThemeIcon: class { constructor(public id: string) {} },
  commands: { registerCommand: (id: string, callback: (node?: unknown) => Promise<void>) => { ui.commands.set(id, callback); return { dispose() {} }; } },
  window: { showInputBox: ui.input, showWarningMessage: ui.warning, showInformationMessage: vi.fn(), showQuickPick: ui.picker },
}));
import { CollectionsTreeProvider, type CollectionsTreeNode } from '../../src/experimental/session-navigator/collections-tree-provider';

let root: string;
let path: string;
let store: CollectionsStore;
const source: CollectionReferenceIdentity = { providerId: 'codex', sourceId: 'source-a', nativeId: 'session-a', referenceKind: 'session' };
const target: CollectionReferenceIdentity = { ...source, sourceId: 'source-b' };
const revision = () => store.listCollections().metadataRevision;
function mutate(mutation: Omit<CollectionsMutationCommand, 'requestId' | 'expectedRevision'>) {
  return store.applyMutation({ ...mutation, requestId: randomUUID(), expectedRevision: revision() } as CollectionsMutationCommand);
}
function seed() { const collection = store.createCollection('Work', revision()); return store.addEntry(collection.collectionId, source, revision()); }
function journal(values = new Map<string, unknown>()) {
  return { values, keys: () => [...values.keys()], get: (key: string) => values.get(key),
    update: vi.fn(async (key: string, value: unknown) => { if (value === undefined) values.delete(key); else values.set(key, structuredClone(value)); }) };
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'jsonlview-collection-attrs-')); path = join(root, 'collections', 'metadata.sqlite');
  store = await CollectionsStore.open(path); ui.commands.clear(); vi.clearAllMocks();
});
afterEach(async () => { vi.restoreAllMocks(); store.close(); await rm(root, { recursive: true, force: true }); });

describe('independent Collections entry metadata', () => {
  it('shares alias and local intent across links, retains them after every unlink, and clears them without source changes', async () => {
    const entry = seed(); const second = store.createCollection('Other', revision());
    mutate({ action: 'setAlias', payload: { entryId: entry.entryId, displayAlias: 'My alias' } });
    mutate({ action: 'setLocalArchive', payload: { entryId: entry.entryId, archivedAtMs: 123 } });
    store.addEntry(second.collectionId, source, revision());
    for (const collectionId of [entry.collectionId, second.collectionId]) expect(store.listEntries(collectionId).items).toMatchObject([{ displayAlias: 'My alias', localArchivedAtMs: 123 }]);
    store.removeEntry(entry.collectionId, entry.entryId, revision()); store.removeEntry(second.collectionId, entry.entryId, revision());
    store.close(); store = await CollectionsStore.open(path);
    expect(store.addEntry(entry.collectionId, source, revision()).entryId).toBe(entry.entryId);
    expect(store.listEntries(entry.collectionId).items[0]).toMatchObject({ displayAlias: 'My alias', localArchivedAtMs: 123 });
    mutate({ action: 'setAlias', payload: { entryId: entry.entryId, displayAlias: null } });
    mutate({ action: 'setLocalArchive', payload: { entryId: entry.entryId, archivedAtMs: null } });
    expect(store.listEntries(entry.collectionId).items[0]).toEqual(entry);
  });

  it('rebinds the durable anchor and every link atomically, preserving aliases and session archive intent', () => {
    const entry = seed(); const second = store.createCollection('Other', revision()); store.addEntry(second.collectionId, source, revision());
    mutate({ action: 'setAlias', payload: { entryId: entry.entryId, displayAlias: 'Alias' } });
    mutate({ action: 'setLocalArchive', payload: { entryId: entry.entryId, archivedAtMs: 123 } });
    const originalRevision = revision();
    const command: CollectionsMutationCommand = { requestId: randomUUID(), expectedRevision: originalRevision, action: 'rebindEntry', payload: { entryId: entry.entryId, identity: target } };
    const receipt = store.applyMutation(command);
    expect(store.applyMutation(command)).toEqual(receipt);
    for (const collectionId of [entry.collectionId, second.collectionId]) expect(store.listEntries(collectionId).items).toMatchObject([{ ...target, entryId: entry.entryId, displayAlias: 'Alias', localArchivedAtMs: 123 }]);
    expect(() => store.applyMutation({ ...command, requestId: randomUUID(), payload: { entryId: entry.entryId, identity: source } })).toThrow('REVISION_CONFLICT');
  });

  it('refuses exact identity collisions instead of merging, and distinguishes equal native IDs under separate sources', () => {
    const entry = seed(); const other = store.addEntry(entry.collectionId, target, revision());
    expect(other.entryId).not.toBe(entry.entryId); const before = store.listEntries(entry.collectionId);
    expect(() => mutate({ action: 'rebindEntry', payload: { entryId: entry.entryId, identity: target } })).toThrow('IDENTITY_CONFLICT');
    expect(store.listEntries(entry.collectionId)).toEqual(before);
  });

  it('supports exact-file refs while preserving the separate legacy session identity domain', () => {
    const entry = seed(); const file = { providerId: 'generic' as const, sourceId: 'file-source', nativeId: '@file', referenceKind: 'file' as const };
    const ref = store.addEntry(entry.collectionId, file, revision());
    expect(ref.referenceKind).toBe('file');
    expect(() => mutate({ action: 'setLocalArchive', payload: { entryId: ref.entryId, archivedAtMs: 1 } })).toThrow('INVALID_ARGUMENT');
    expect(() => store.addEntry(entry.collectionId, { ...file, nativeId: 'path.jsonl' }, revision())).toThrow('INVALID_ARGUMENT');
    expect(store.addEntry(entry.collectionId, { ...source, nativeId: '@source' }, revision()).referenceKind).toBe('session');
    mutate({ action: 'setLocalArchive', payload: { entryId: entry.entryId, archivedAtMs: 1 } });
    expect(() => mutate({ action: 'rebindEntry', payload: { entryId: entry.entryId, identity: { ...file, sourceId: 'another-file' } } })).toThrow('INVALID_ARGUMENT');
  });

  it('rejects known collisions and invalid archive-kind transitions before journal acceptance, allowing the next valid action', async () => {
    const entry = seed(); store.addEntry(entry.collectionId, target, revision()); const state = journal(); const recovery = new CollectionsMutationRecovery(state);
    await expect(recovery.execute(store, { expectedRevision: revision(), action: 'rebindEntry', payload: { entryId: entry.entryId, identity: target } })).rejects.toThrow('IDENTITY_CONFLICT');
    expect(store.listPendingMutations()).toHaveLength(0);
    await recovery.execute(store, { expectedRevision: revision(), action: 'setLocalArchive', payload: { entryId: entry.entryId, archivedAtMs: 123 } });
    const file = { providerId: 'generic' as const, sourceId: 'file-source', nativeId: '@file', referenceKind: 'file' as const };
    await expect(recovery.execute(store, { expectedRevision: revision(), action: 'rebindEntry', payload: { entryId: entry.entryId, identity: file } })).rejects.toThrow('INVALID_ARGUMENT');
    expect(store.listPendingMutations()).toHaveLength(0);
    await recovery.execute(store, { expectedRevision: revision(), action: 'setLocalArchive', payload: { entryId: entry.entryId, archivedAtMs: null } });
    await recovery.execute(store, { expectedRevision: revision(), action: 'rebindEntry', payload: { entryId: entry.entryId, identity: file } });
    expect(store.listEntries(entry.collectionId).items.find((item) => item.entryId === entry.entryId)).toMatchObject(file);
    expect(store.listPendingMutations()).toHaveLength(0); expect(state.update).not.toHaveBeenCalled();
  });

  it.each(['setAlias', 'setLocalArchive', 'rebindEntry'] as const)('recovers %s once after a lost COMMIT response and reopen', async (action) => {
    const entry = seed(); const payload = action === 'setAlias' ? { entryId: entry.entryId, displayAlias: 'Retained' }
      : action === 'setLocalArchive' ? { entryId: entry.entryId, archivedAtMs: 77 } : { entryId: entry.entryId, identity: target };
    const command = { requestId: randomUUID(), expectedRevision: revision(), action, payload } as CollectionsMutationCommand;
    const original = DatabaseSync.prototype.exec; let lose = true;
    const exec = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
      original.call(this, sql); if (sql === 'COMMIT' && lose) { lose = false; throw new Error('lost reply'); }
    });
    try { expect(() => store.applyMutation(command)).toThrow('METADATA_UNAVAILABLE'); } finally { exec.mockRestore(); }
    store.close(); store = await CollectionsStore.open(path);
    const recovered = store.applyMutation(command); expect(recovered.changed).toBe(true);
    expect(recovered.metadataRevision).toBe(String(Number(command.expectedRevision) + 1));
    expect(store.applyMutation(command)).toEqual(recovered);
  });

  it.each(['@source', '@file'])('replays a legacy session ID %s without changing its receipt or blocking later commands', async (nativeId) => {
    store.close();
    const legacyPath = join(root, 'legacy-session.sqlite');
    const db = new DatabaseSync(legacyPath); db.exec(COLLECTIONS_SCHEMA_V2);
    const collectionId = randomUUID(); const entryId = randomUUID();
    const identity: CollectionReferenceIdentity = { providerId: 'pi', sourceId: 'owned-source', nativeId, referenceKind: 'session' };
    const command: CollectionsMutationCommand = { requestId: randomUUID(), expectedRevision: '1', action: 'addEntry', payload: { collectionId, identity } };
    const resultJson = JSON.stringify({ ...identity, entryId, collectionId }, null, 2);
    const hash = createHash('sha256').update(JSON.stringify({ action: command.action, expectedRevision: command.expectedRevision,
      payload: { collectionId, identity: { nativeId, providerId: identity.providerId, referenceKind: 'session', sourceId: identity.sourceId } } })).digest('hex');
    db.prepare('INSERT INTO user_collection VALUES (?, ?)').run(collectionId, 'Legacy');
    db.prepare('INSERT INTO collection_entry VALUES (?, ?, ?, ?, ?)').run(entryId, identity.providerId, identity.sourceId, nativeId, 'session');
    db.prepare('INSERT INTO collection_membership VALUES (?, ?)').run(collectionId, entryId);
    db.exec('UPDATE collections_state SET revision = 2');
    db.prepare('INSERT INTO collections_mutation_receipt VALUES (?, ?, ?, 1, 2, 1, ?)').run(command.requestId, hash, command.action, resultJson);
    db.close();
    store = await CollectionsStore.open(legacyPath); store.close(); store = await CollectionsStore.open(legacyPath);
    const state = journal(new Map([[COLLECTIONS_PENDING_PREFIX + command.requestId, { version: 1, command }]]));
    const recovery = new CollectionsMutationRecovery(state);
    await recovery.recover(store);
    expect(state.values.size).toBe(1); expect(store.listPendingMutations()).toHaveLength(0); expect(state.update).not.toHaveBeenCalled();
    expect(store.applyMutation(command).result).toEqual(JSON.parse(resultJson));
    const check = new DatabaseSync(legacyPath, { readOnly: true });
    try { expect(check.prepare('SELECT command_hash, result_json FROM collections_mutation_receipt').get()).toEqual({ command_hash: hash, result_json: resultJson }); } finally { check.close(); }
    await recovery.execute(store, { expectedRevision: '2', action: 'createCollection', payload: { displayName: 'Still usable' } });
    expect(store.listCollections().items).toHaveLength(2);
  });

  it('preserves old v2 receipt hashes and JSON verbatim and replays the original pending journal after migration and second reopen', async () => {
    store.close(); const legacyPath = join(root, 'legacy.sqlite'); const db = new DatabaseSync(legacyPath); db.exec(COLLECTIONS_SCHEMA_V2);
    const collectionId = randomUUID(); const resultJson = JSON.stringify({ collectionId, displayName: 'Legacy', entryCount: 0 }, null, 2);
    const command: CollectionsMutationCommand = { requestId: randomUUID(), expectedRevision: '0', action: 'createCollection', payload: { displayName: 'Legacy' } };
    const hash = createHash('sha256').update(JSON.stringify({ action: command.action, expectedRevision: command.expectedRevision, payload: command.payload })).digest('hex');
    db.prepare('INSERT INTO user_collection VALUES (?, ?)').run(collectionId, 'Legacy'); db.exec('UPDATE collections_state SET revision = 1');
    db.prepare('INSERT INTO collections_mutation_receipt VALUES (?, ?, ?, 0, 1, 1, ?)').run(command.requestId, hash, command.action, resultJson); db.close();
    store = await CollectionsStore.open(legacyPath); store.close(); store = await CollectionsStore.open(legacyPath);
    const state = journal(new Map([[COLLECTIONS_PENDING_PREFIX + command.requestId, { version: 1, command }]]));
    await new CollectionsMutationRecovery(state).recover(store); expect(state.values.size).toBe(1); expect(store.listCollections().items).toHaveLength(1);
    expect(store.listPendingMutations()).toHaveLength(0); expect(state.update).not.toHaveBeenCalled();
    const check = new DatabaseSync(legacyPath, { readOnly: true });
    try { expect(check.prepare('SELECT command_hash, result_json FROM collections_mutation_receipt').get()).toEqual({ command_hash: hash, result_json: resultJson }); } finally { check.close(); }
    const [backupName] = (await readdir(root)).filter((name) => name.startsWith('legacy.sqlite.pre-v4.') && name.endsWith('.bak'));
    expect(backupName).toBeDefined(); expect((await readFile(join(root, backupName!))).byteLength).toBeGreaterThan(0);
    const copy = new DatabaseSync(join(root, backupName!), { readOnly: true });
    try { expect(copy.prepare('SELECT schema_version, revision FROM collections_state').get()).toEqual({ schema_version: 2, revision: 1 }); } finally { copy.close(); }
  });

  it('rolls back an interrupted v2 migration after DDL and retains its verified backup and reopenable old schema', async () => {
    store.close(); const legacyPath = join(root, 'interrupted.sqlite'); const db = new DatabaseSync(legacyPath); db.exec(COLLECTIONS_SCHEMA_V2);
    const collectionId = randomUUID(); const entryId = randomUUID();
    db.prepare('INSERT INTO user_collection VALUES (?, ?)').run(collectionId, 'Legacy');
    db.prepare('INSERT INTO collection_entry VALUES (?, ?, ?, ?, ?)').run(entryId, source.providerId, source.sourceId, source.nativeId, source.referenceKind);
    db.prepare('INSERT INTO collection_membership VALUES (?, ?)').run(collectionId, entryId); db.close();
    const before = await readFile(legacyPath); const original = DatabaseSync.prototype.exec;
    const exec = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
      original.call(this, sql); if (sql.includes('CREATE TEMP TABLE retained_membership')) throw new Error('migration interrupted');
    });
    try { await expect(CollectionsStore.open(legacyPath)).rejects.toThrow('METADATA_UNAVAILABLE'); } finally { exec.mockRestore(); }
    expect(await readFile(legacyPath)).toEqual(before);
    const retained = new DatabaseSync(legacyPath, { readOnly: true });
    try { expect(retained.prepare('SELECT schema_version FROM collections_state').get()?.schema_version).toBe(2); expect(retained.prepare('SELECT * FROM collection_membership').all()).toHaveLength(1); } finally { retained.close(); }
    expect((await readdir(root)).some((name) => name.startsWith('interrupted.sqlite.pre-v4.'))).toBe(true);
    store = await CollectionsStore.open(legacyPath); store.close(); store = await CollectionsStore.open(legacyPath);
    expect(store.listEntries(collectionId).items).toMatchObject([{ ...source, entryId }]);
  });
});

describe('native Collections metadata commands', () => {
  async function host() {
    const entry = seed(); let authorized = true; const state = journal();
    const open = vi.fn(); const candidate = { identity: target, isCurrent: () => authorized };
    const provider = new CollectionsTreeProvider(root, { referenceForNode: () => undefined, labelForReference: () => authorized ? 'Provider title' : undefined,
      openReference: open, pickReference: async () => candidate }, state);
    provider.register();
    const node = async () => { const [collection] = await provider.getChildren(); return (await provider.getChildren(collection))[0]!; };
    const run = (name: string, value?: CollectionsTreeNode) => ui.commands.get('jsonlView.sessionNavigator.collections.' + name)!(value);
    return { entry, state, provider, node, run, open, revoke: () => { authorized = false; }, authorize: () => { authorized = true; } };
  }

  it('renders aliases only while authorized, preserves direct open, and exposes session-only local archive/restore', async () => {
    const h = await host();
    try {
      ui.input.mockResolvedValueOnce('My alias'); await h.run('alias', await h.node());
      const node = await h.node(); expect(h.provider.getTreeItem(node).label).toBe('My alias');
      await h.run('archive', node); const archived = await h.node();
      expect(h.provider.getTreeItem(archived)).toMatchObject({ contextValue: 'jsonlView.collection.entry.session.archived', description: 'Local archive intent' });
      await h.run('open', archived); expect(h.open).toHaveBeenCalledOnce();
      h.revoke(); expect(h.provider.getTreeItem(archived).label).toBe('Source unavailable'); expect(h.provider.getTreeItem(archived).command).toBeUndefined();
      expect(h.provider.getTreeItem(archived).contextValue).toBe('jsonlView.collection.entry.unavailable.archived');
      await h.run('alias', archived); expect(ui.input).toHaveBeenCalledOnce();
      await h.run('restore', archived); expect(store.listEntries(h.entry.collectionId).items[0]?.localArchivedAtMs).toBeUndefined();
    } finally { h.provider.dispose(); }
  });

  it('requires explicit rebind confirmation and rechecks the chosen candidate after the prompt', async () => {
    const h = await host();
    try {
      ui.warning.mockResolvedValueOnce(undefined); await h.run('rebind', await h.node());
      expect(store.listEntries(h.entry.collectionId).items[0]?.sourceId).toBe(source.sourceId);
      ui.warning.mockImplementationOnce(async () => { h.revoke(); return 'Rebind Reference'; });
      await h.run('rebind', await h.node()); expect(store.listPendingMutations()).toHaveLength(0);
      expect(store.listEntries(h.entry.collectionId).items[0]?.sourceId).toBe(source.sourceId);
    } finally { h.provider.dispose(); }
  });

  it('commits a confirmed rebind through the pending journal and preserves direct open on the new reference', async () => {
    const h = await host();
    try {
      ui.warning.mockResolvedValueOnce('Rebind Reference'); await h.run('rebind', await h.node());
      expect(store.listPendingMutations()).toHaveLength(0); expect(h.state.update).not.toHaveBeenCalled();
      expect(store.listEntries(h.entry.collectionId).items).toMatchObject([{ ...target, entryId: h.entry.entryId }]);
      await h.run('open', await h.node()); expect(h.open).toHaveBeenCalledWith(expect.objectContaining(target));
    } finally { h.provider.dispose(); }
  });

  it('retains pending rebind and readable metadata after authorization is revoked during persistence; committed receipts can clean up after revoke', async () => {
    const h = await host();
    try {
      const accept = CollectionsStore.prototype.acceptPendingMutation;
      vi.spyOn(CollectionsStore.prototype, 'acceptPendingMutation').mockImplementationOnce(function (this: CollectionsStore, command) { accept.call(this, command); h.revoke(); });
      ui.warning.mockResolvedValueOnce('Rebind Reference'); await h.run('rebind', await h.node());
      expect(store.listPendingMutations()).toHaveLength(1); expect(store.listEntries(h.entry.collectionId).items[0]?.sourceId).toBe(source.sourceId);
      const rows = await h.provider.getChildren(); expect(rows).toMatchObject([{ kind: 'notice' }, { kind: 'collection' }]);
      h.authorize(); await h.run('refresh'); expect(store.listPendingMutations()).toHaveLength(0);
      expect(store.listEntries(h.entry.collectionId).items[0]?.sourceId).toBe(target.sourceId);
      expect(h.state.update).not.toHaveBeenCalled();
      const command: CollectionsMutationCommand = { requestId: randomUUID(), expectedRevision: revision(), action: 'rebindEntry', payload: { entryId: h.entry.entryId, identity: source } };
      store.applyMutation(command); h.revoke();
      const persistence = journal(new Map([[COLLECTIONS_PENDING_PREFIX + command.requestId, { version: 1, command }]]));
      await new CollectionsMutationRecovery(persistence, () => true, () => { throw new CollectionsError('SOURCE_UNAVAILABLE'); }).recover(store);
      expect(persistence.values.size).toBe(1); expect(store.listPendingMutations()).toHaveLength(0); expect(persistence.update).not.toHaveBeenCalled();
    } finally { h.provider.dispose(); }
  });
});

describe('native Collections add-reference entrypoint', () => {
  async function host() {
    const collection = store.createCollection('Work', revision()); const state = journal(); let authorized = true;
    const candidate = { identity: target, isCurrent: () => authorized };
    const pick = vi.fn(async () => candidate as typeof candidate | undefined);
    const provider = new CollectionsTreeProvider(root, { referenceForNode: () => undefined, labelForReference: () => authorized ? 'Existing session' : undefined,
      openReference: async () => {}, pickReference: pick }, state);
    provider.register(); const [node] = await provider.getChildren(); const [empty] = await provider.getChildren(node);
    const run = () => ui.commands.get('jsonlView.sessionNavigator.collections.addReference')!(empty);
    return { collection, state, provider, empty: empty!, pick, candidate, run, revoke: () => { authorized = false; }, authorize: () => { authorized = true; } };
  }

  it('offers a leaf action whose accepted reference is committed through the shared journal', async () => {
    const h = await host();
    try {
      expect(h.provider.getTreeItem(h.empty).command).toMatchObject({ command: 'jsonlView.sessionNavigator.collections.addReference', arguments: [h.empty] });
      expect(await h.provider.getChildren(h.empty)).toEqual([]);
      await h.run();
      expect(store.listEntries(h.collection.collectionId).items).toMatchObject([{ ...target }]);
      expect(store.listPendingMutations()).toHaveLength(0); expect(h.state.update).not.toHaveBeenCalled();
      const [collection] = await h.provider.getChildren();
      h.pick.mockResolvedValueOnce({ identity: source, isCurrent: () => true });
      await ui.commands.get('jsonlView.sessionNavigator.collections.addReference')!(collection);
      expect(store.listEntries(h.collection.collectionId).items.map((entry) => entry.sourceId).sort()).toEqual(['source-a', 'source-b']);
    } finally { h.provider.dispose(); }
  });

  it.each(['cancel', 'refresh', 'revoke', 'unavailable label', 'stale candidate', 'deleted collection', 'dispose'] as const)('does not accept a new change after %s during selection', async (cause) => {
    const h = await host(); const initialRevision = revision();
    try {
      h.pick.mockImplementationOnce(async () => {
        if (cause === 'cancel') return undefined;
        if (cause === 'refresh') h.provider.refresh();
        if (cause === 'revoke') h.revoke();
        if (cause === 'unavailable label') { h.revoke(); return { ...h.candidate, isCurrent: () => true }; }
        if (cause === 'deleted collection') store.deleteCollection(h.collection.collectionId, revision());
        if (cause === 'dispose') h.provider.dispose();
        return cause === 'stale candidate' ? { ...h.candidate, isCurrent: () => false } : h.candidate;
      });
      await h.run();
      expect(store.listPendingMutations()).toHaveLength(0);
      if (cause === 'deleted collection') expect(store.listCollections().items).toHaveLength(0);
      else { expect(store.listEntries(h.collection.collectionId).items).toHaveLength(0); expect(revision()).toBe(initialRevision); }
    } finally { h.provider.dispose(); }
  });

  it('retains the accepted command if authorization is revoked during acceptance and recovers the same link once', async () => {
    const h = await host();
    try {
      const accept = CollectionsStore.prototype.acceptPendingMutation;
      vi.spyOn(CollectionsStore.prototype, 'acceptPendingMutation').mockImplementationOnce(function (this: CollectionsStore, command) { accept.call(this, command); h.revoke(); });
      await h.run();
      const [pending] = store.listPendingMutations();
      expect(pending).toMatchObject({ action: 'addEntry', payload: { collectionId: h.collection.collectionId, identity: target } });
      expect(store.listEntries(h.collection.collectionId).items).toHaveLength(0);
      h.authorize(); await ui.commands.get('jsonlView.sessionNavigator.collections.refresh')!();
      expect(store.listPendingMutations()).toHaveLength(0); expect(store.listEntries(h.collection.collectionId).items).toHaveLength(1);
      const repeated = store.applyMutation(pending!);
      expect(repeated.requestId).toBe(pending!.requestId); expect(store.listEntries(h.collection.collectionId).items).toHaveLength(1);
    } finally { h.provider.dispose(); }
  });
});
