import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CollectionsStore } from '../../src/infrastructure/navigator/collections-store';
import type { CollectionsMutationCommand } from '../../src/application/collections/collections-model';
import { collectionsCommandHash, COLLECTIONS_PENDING_CAPACITY } from '../../src/infrastructure/navigator/collections-journal';
import { COLLECTIONS_SCHEMA_V3 } from '../../src/infrastructure/navigator/collections-schema';
import { COLLECTIONS_PENDING_PREFIX, CollectionsMutationRecovery } from '../../src/experimental/session-navigator/collections-recovery';

let root: string;
let first: CollectionsStore;
let second: CollectionsStore;
const emptyLegacy = { keys: () => [], get: () => undefined, update: vi.fn() };
function command(displayName = 'Accepted', expectedRevision = '0'): Extract<CollectionsMutationCommand, { action: 'createCollection' }> { return { requestId: randomUUID(), action: 'createCollection', expectedRevision, payload: { displayName } }; }
function legacy(commands: readonly CollectionsMutationCommand[]) {
  const values = new Map<string, unknown>(commands.map((item) => [COLLECTIONS_PENDING_PREFIX + item.requestId, { version: 1, command: item }]));
  return { keys: () => [...values.keys()], get: (key: string) => values.get(key), update: vi.fn(), values };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'jsonlview-collection-journal-')); first = await CollectionsStore.open(join(root, 'metadata.sqlite')); second = await CollectionsStore.open(join(root, 'metadata.sqlite')); });
afterEach(async () => { vi.restoreAllMocks(); first.close(); second.close(); await rm(root, { recursive: true, force: true }); });

describe('Collections shared SQLite acceptance journal', () => {
  it('documents the stale whole-extension Memento overwrite reproduced before this fix', () => {
    let shared: Record<string, unknown> = {};
    const windowState = () => {
      const local: Record<string, unknown> = structuredClone(shared);
      return { keys: () => Object.keys(local), get: (key: string) => local[key],
        update: (key: string, value: unknown) => {
          if (value === undefined) delete local[key]; else local[key] = structuredClone(value);
          // ExtensionMemento persists the whole extension object, not a per-key CAS.
          shared = structuredClone(local);
        } };
    };
    const stateA = windowState(); const stateB = windowState();
    stateA.update('A', 1); stateB.update('B', 1); stateA.update('A', undefined);
    expect(shared).toEqual({}); expect(stateB.keys()).toEqual(['B']);
  });

  it('retains B accepted command when A completes and B loses SQLite CAS across two owners', async () => {
    const savedA = deferred(); const savedB = deferred(); const releaseA = deferred(); const releaseB = deferred();
    const acceptA = first.acceptPendingMutation.bind(first); const acceptB = second.acceptPendingMutation.bind(second);
    vi.spyOn(first, 'acceptPendingMutation').mockImplementation(async (item) => { acceptA(item); savedA.resolve(); await releaseA.promise; });
    vi.spyOn(second, 'acceptPendingMutation').mockImplementation(async (item) => { acceptB(item); savedB.resolve(); await releaseB.promise; });
    const a = new CollectionsMutationRecovery(emptyLegacy).execute(first, { action: 'createCollection', expectedRevision: '0', payload: { displayName: 'A' } });
    const b = new CollectionsMutationRecovery(emptyLegacy).execute(second, { action: 'createCollection', expectedRevision: '0', payload: { displayName: 'B' } });
    const outcomeB = b.catch((error: unknown) => error);
    await Promise.all([savedA.promise, savedB.promise]); expect(second.listPendingMutations()).toHaveLength(2); releaseA.resolve(); await a; releaseB.resolve();
    expect(await outcomeB).toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(first.listPendingMutations()).toEqual(second.listPendingMutations());
    expect(second.listPendingMutations()).toMatchObject([{ payload: { displayName: 'B' } }]);
    first.close(); first = await CollectionsStore.open(join(root, 'metadata.sqlite'));
    await expect(new CollectionsMutationRecovery(emptyLegacy).recover(first)).rejects.toThrow('REVISION_CONFLICT');
    expect(first.listPendingMutations()).toHaveLength(1); expect(first.listCollections().items).toMatchObject([{ displayName: 'A' }]);
    expect(emptyLegacy.update).not.toHaveBeenCalled();
  });

  it('completes only the exact UUID/hash with its matching committed receipt', () => {
    const a = command('A'); const b = command('B', '1');
    first.acceptPendingMutation(a); second.acceptPendingMutation(b);
    expect(() => first.completePendingMutation(a)).toThrow('MUTATION_CONFLICT');
    first.applyMutation(a);
    expect(() => first.completePendingMutation({ ...a, payload: { displayName: 'Changed' } })).toThrow('MUTATION_CONFLICT');
    expect(first.listPendingMutations()).toHaveLength(2);
    first.completePendingMutation(a); second.completePendingMutation(a);
    expect(second.listPendingMutations()).toEqual([b]);
  });

  it('enforces capacity under the shared writer lock without evicting accepted commands', () => {
    const items = Array.from({ length: COLLECTIONS_PENDING_CAPACITY }, (_, i) => command('Item ' + i)); first.importLegacyMutations(items);
    expect(() => second.acceptPendingMutation(command('Overflow'))).toThrow('METADATA_UNAVAILABLE');
    expect(second.listPendingMutations()).toHaveLength(COLLECTIONS_PENDING_CAPACITY);
    const lock = new DatabaseSync(join(root, 'metadata.sqlite')); lock.exec('BEGIN IMMEDIATE');
    try { expect(() => second.acceptPendingMutation(command('Locked'))).toThrow('STORE_BUSY'); }
    finally { lock.exec('ROLLBACK'); lock.close(); }
  });

  it('atomically imports original legacy UUID/command and skips matching committed receipts on later activation', async () => {
    const item = command('Legacy'); const state = legacy([item]);
    const apply = first.applyMutation.bind(first); vi.spyOn(first, 'applyMutation').mockImplementationOnce(() => { throw new Error('stopped after import'); });
    await expect(new CollectionsMutationRecovery(state).recover(first)).rejects.toThrow('stopped after import');
    expect(second.listPendingMutations()).toEqual([item]); vi.mocked(first.applyMutation).mockImplementation(apply);
    await new CollectionsMutationRecovery(state).recover(first);
    const receipt = second.applyMutation(item); await new CollectionsMutationRecovery(state).recover(second);
    expect(second.applyMutation(item)).toEqual(receipt); expect(first.listPendingMutations()).toHaveLength(0);
    expect(new CollectionsMutationRecovery(state).hasPending(first)).toBe(false);
    expect(state.values.size).toBe(1); expect(state.update).not.toHaveBeenCalled();
  });

  it('rejects invalid legacy snapshots before importing any command', async () => {
    const state = legacy([command()]); state.values.set(COLLECTIONS_PENDING_PREFIX + randomUUID(), { version: 2, command: command() });
    await expect(new CollectionsMutationRecovery(state).recover(first)).rejects.toThrow('METADATA_UNAVAILABLE');
    expect(first.listPendingMutations()).toHaveLength(0); expect(first.listCollections().items).toHaveLength(0);
    expect(state.values.size).toBe(2); expect(state.update).not.toHaveBeenCalled();
  });

  it('rolls back all imported commands on a legacy UUID/hash collision', () => {
    const original = command(); first.applyMutation(original);
    expect(() => second.importLegacyMutations([command('Do not import'), { ...original, payload: { displayName: 'Other' } }])).toThrow('MUTATION_CONFLICT');
    expect(first.listPendingMutations()).toHaveLength(0); expect(first.listCollections().items).toHaveLength(1);
  });

  it.each(['json', 'hash', 'oversize'])('retains corrupt pending %s across reopen while metadata remains readable', async (kind) => {
    const item = command(); first.acceptPendingMutation(item); const db = new DatabaseSync(join(root, 'metadata.sqlite'));
    if (kind === 'json') db.prepare('UPDATE collections_pending_command SET command_json = ?').run('{bad');
    else if (kind === 'oversize') db.prepare('UPDATE collections_pending_command SET command_json = ?').run('漢'.repeat(20_000));
    else db.prepare('UPDATE collections_pending_command SET command_hash = ?').run('f'.repeat(64));
    const before = db.prepare('SELECT * FROM collections_pending_command').all(); db.close();
    await expect(new CollectionsMutationRecovery(emptyLegacy).recover(second)).rejects.toThrow('METADATA_UNAVAILABLE');
    expect(first.listCollections().items).toEqual([]); first.close(); first = await CollectionsStore.open(join(root, 'metadata.sqlite'));
    expect(() => first.listPendingMutations()).toThrow('METADATA_UNAVAILABLE');
    const retained = new DatabaseSync(join(root, 'metadata.sqlite'));
    try { expect(retained.prepare('SELECT * FROM collections_pending_command').all()).toEqual(before); } finally { retained.close(); }
  });

  it('migrates exact v3 attributes, orphan anchors, memberships and receipt JSON verbatim', async () => {
    const path = join(root, 'v3.sqlite'); const db = new DatabaseSync(path); db.exec(COLLECTIONS_SCHEMA_V3);
    const collectionId = randomUUID(); const entryId = randomUUID(); const orphanId = randomUUID(); const oldCommand = command('Old receipt');
    db.prepare('INSERT INTO user_collection VALUES (?, ?)').run(collectionId, 'Retained');
    db.prepare('INSERT INTO collection_entry VALUES (?, ?, ?, ?, ?, ?, ?)').run(entryId, 'codex', 'source', 'thread', 'session', 'Alias', 123);
    db.prepare('INSERT INTO collection_entry VALUES (?, ?, ?, ?, ?, ?, ?)').run(orphanId, 'generic', 'file-source', '@file', 'file', 'File alias', null);
    db.prepare('INSERT INTO collection_membership VALUES (?, ?)').run(collectionId, entryId);
    const resultJson = '{ "collectionId": "' + randomUUID() + '", "displayName": "Old receipt", "entryCount": 0 }';
    db.prepare('INSERT INTO collections_mutation_receipt VALUES (?, ?, ?, ?, ?, ?, ?)').run(oldCommand.requestId, collectionsCommandHash(oldCommand), oldCommand.action, 0, 1, 1, resultJson);
    db.exec('UPDATE collections_state SET revision = 1');
    const entries = db.prepare('SELECT * FROM collection_entry ORDER BY entry_id').all(); db.close();
    const migrated = await CollectionsStore.open(path);
    try { expect(migrated.listEntries(collectionId).items).toMatchObject([{ displayAlias: 'Alias', localArchivedAtMs: 123 }]); expect(migrated.applyMutation(oldCommand).result).toEqual(JSON.parse(resultJson)); }
    finally { migrated.close(); }
    const raw = new DatabaseSync(path, { readOnly: true });
    try { expect(raw.prepare('SELECT * FROM collection_entry ORDER BY entry_id').all()).toEqual(entries); expect(raw.prepare('SELECT result_json FROM collections_mutation_receipt').get()?.result_json).toBe(resultJson); expect(raw.prepare('SELECT schema_version FROM collections_state').get()?.schema_version).toBe(4); }
    finally { raw.close(); }
    const [backupName] = (await readdir(root)).filter((name) => name.startsWith('v3.sqlite.pre-v4.') && name.endsWith('.bak'));
    expect(backupName).toBeDefined(); const copy = new DatabaseSync(join(root, backupName!), { readOnly: true });
    try { expect(copy.prepare('SELECT * FROM collection_entry ORDER BY entry_id').all()).toEqual(entries); expect(copy.prepare('SELECT schema_version FROM collections_state').get()?.schema_version).toBe(3); }
    finally { copy.close(); }
    const reopened = await CollectionsStore.open(path);
    try { reopened.importLegacyMutations([oldCommand]); expect(reopened.listPendingMutations()).toHaveLength(0); expect(reopened.applyMutation(oldCommand).result).toEqual(JSON.parse(resultJson)); }
    finally { reopened.close(); }
  });
});
