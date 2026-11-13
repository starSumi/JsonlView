import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { backup, DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollectionReferenceIdentity } from '../../src/application';
import { collectionsMutationRequestId, CollectionsStore } from '../../src/infrastructure/navigator/collections-store';
import { COLLECTIONS_SCHEMA, COLLECTIONS_SCHEMA_V1 } from '../../src/infrastructure/navigator/collections-schema';
import { COLLECTIONS_RECEIPT_CAPACITY } from '../../src/infrastructure/navigator/collections-store';

vi.mock('node:sqlite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:sqlite')>();
  return { ...actual, backup: vi.fn(actual.backup) };
});

let root: string;
let path: string;
let store: CollectionsStore;
const reference: CollectionReferenceIdentity = { providerId: 'codex', sourceId: 'source-a', nativeId: 'thread-a', referenceKind: 'session' };
const revision = () => store.listCollections().metadataRevision;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'jsonlview-collections-')); path = join(root, 'metadata.sqlite'); store = await CollectionsStore.open(path); });
afterEach(async () => { store.close(); await rm(root, { recursive: true, force: true }); });

describe('user-owned Collections metadata store', () => {
  it('persists CRUD and many-to-many references without changing source bytes or other collections', async () => {
    const source = join(root, 'source.jsonl');
    await writeFile(source, '{"synthetic":true}\n');
    const before = await stat(source);
    const a = store.createCollection(' A ', revision());
    const b = store.createCollection('B', revision());
    const entry = store.addEntry(a.collectionId, reference, revision());
    const second = store.addEntry(b.collectionId, reference, revision());
    expect(second.entryId).toBe(entry.entryId);
    store.renameCollection(a.collectionId, 'Renamed', revision());
    store.close(); store = await CollectionsStore.open(path);
    expect(store.listCollections().items.map((item) => item.displayName)).toEqual(['B', 'Renamed']);
    expect(store.removeEntry(a.collectionId, entry.entryId, revision())).toBe(true);
    expect(store.deleteCollection(a.collectionId, revision())).toBe(true);
    expect(store.listEntries(b.collectionId).items).toHaveLength(1);
    expect(await readFile(source, 'utf8')).toBe('{"synthetic":true}\n');
    expect((await stat(source)).mtimeMs).toBe(before.mtimeMs);
    const db = new DatabaseSync(path, { readOnly: true });
    expect(db.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
    const columns = db.prepare('PRAGMA table_info(collection_entry)').all().map((row) => row.name);
    expect(columns).not.toContain('path'); expect(columns).not.toContain('label');
    db.close();
  });

  it('keeps provider/source/kind identities distinct and repeated operations unchanged', () => {
    const collection = store.createCollection('Work', revision());
    const first = store.addEntry(collection.collectionId, reference, revision());
    const stableRevision = revision();
    expect(store.addEntry(collection.collectionId, reference, revision()).entryId).toBe(first.entryId);
    store.renameCollection(collection.collectionId, 'Work', revision());
    expect(store.removeEntry(collection.collectionId, randomUUID(), revision())).toBe(false);
    expect(store.deleteCollection(randomUUID(), revision())).toBe(false);
    expect(revision()).toBe(stableRevision);
    store.addEntry(collection.collectionId, { ...reference, sourceId: 'source-b' }, revision());
    store.addEntry(collection.collectionId, { ...reference, providerId: 'claude' }, revision());
    store.addEntry(collection.collectionId, { ...reference, nativeId: '@source', referenceKind: 'source' }, revision());
    expect(store.listEntries(collection.collectionId).items).toHaveLength(4);
  });

  it('projects only archived references that still have a collection membership and matches the full identity', () => {
    const collection = store.createCollection('Work', revision());
    const archived = store.addEntry(collection.collectionId, reference, revision());
    const sameNativeOtherSource = { ...reference, sourceId: 'source-b' };
    store.addEntry(collection.collectionId, sameNativeOtherSource, revision());
    store.applyMutation({ requestId: randomUUID(), expectedRevision: revision(), action: 'setLocalArchive', payload: { entryId: archived.entryId, archivedAtMs: 1 } });
    expect(store.listArchivedSessionReferences([reference, sameNativeOtherSource])).toEqual([reference]);
    expect(() => store.listArchivedSessionReferences(Array.from({ length: 501 }, () => reference))).toThrow('INVALID_ARGUMENT');

    store.removeEntry(collection.collectionId, archived.entryId, revision());
    expect(store.listArchivedSessionReferences([reference, sameNativeOtherSource])).toEqual([]);
    store.addEntry(collection.collectionId, reference, revision());
    expect(store.listArchivedSessionReferences([reference, sameNativeOtherSource])).toEqual([reference]);
  });

  it('pages beyond the handed-off 200/500 truncation limits without losing or duplicating data', () => {
    const collection = store.createCollection('Work', revision());
    const fixture = new DatabaseSync(path);
    fixture.exec('BEGIN IMMEDIATE');
    const insertCollection = fixture.prepare('INSERT INTO user_collection VALUES (?, ?)');
    for (let i = 0; i < 205; i++) insertCollection.run(randomUUID(), i % 2 ? '同名' : 'Equal');
    const insertEntry = fixture.prepare('INSERT INTO collection_entry(entry_id, provider_id, source_id, native_id, reference_kind) VALUES (?, ?, ?, ?, ?)');
    const link = fixture.prepare('INSERT INTO collection_membership VALUES (?, ?)');
    let firstId = '';
    for (let i = 0; i < 505; i++) {
      const id = randomUUID(); if (i === 0) firstId = id;
      insertEntry.run(id, reference.providerId, reference.sourceId, 'thread-' + String(i), reference.referenceKind);
      link.run(collection.collectionId, id);
    }
    fixture.exec('UPDATE collections_state SET revision = revision + 1; COMMIT'); fixture.close();
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = store.listCollections({ limit: 37, ...(cursor === undefined ? {} : { cursor }) });
      ids.push(...page.items.map((item) => item.collectionId)); cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(ids).toHaveLength(206); expect(new Set(ids).size).toBe(206);
    const stableRevision = revision();
    expect(store.addEntry(collection.collectionId, { ...reference, nativeId: 'thread-0' }, revision()).entryId).toBe(firstId);
    expect(revision()).toBe(stableRevision);
    store.addEntry(collection.collectionId, { ...reference, nativeId: 'new-after-505' }, revision());
    const entries: string[] = []; cursor = undefined;
    do {
      const page = store.listEntries(collection.collectionId, { limit: 100, ...(cursor === undefined ? {} : { cursor }) });
      entries.push(...page.items.map((entry) => entry.entryId)); cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(new Set(entries).size).toBe(506);
  });

  it('rejects stale revisions, foreign-scope cursors and changed snapshots without partial writes', () => {
    const a = store.createCollection('A', revision());
    const b = store.createCollection('B', revision());
    const page = store.listCollections({ limit: 1 });
    expect(() => store.listEntries(a.collectionId, { cursor: page.nextCursor! })).toThrow('INVALID_ARGUMENT');
    store.renameCollection(b.collectionId, 'C', revision());
    expect(() => store.listCollections({ cursor: page.nextCursor! })).toThrow('SNAPSHOT_CHANGED');
    expect(() => store.deleteCollection(a.collectionId, page.metadataRevision)).toThrow('REVISION_CONFLICT');
    expect(store.listCollections().items).toHaveLength(2);
  });

  it.each(['not-an-id', '', '00000000-0000-0000-0000-00000000000Z'])('rejects malformed continuation IDs in both page scopes: %s', (id) => {
    const collection = store.createCollection('Work', revision());
    const cursor = (scope: string, name: string) => Buffer.from(JSON.stringify({ scope, revision: revision(), id, name })).toString('base64url');
    expect(() => store.listCollections({ cursor: cursor('collections', 'Work') })).toThrow('INVALID_ARGUMENT');
    expect(() => store.listEntries(collection.collectionId, { cursor: cursor(collection.collectionId, '') })).toThrow('INVALID_ARGUMENT');
  });

  it('rejects malformed collection scope and page sort/revision fields', () => {
    const collection = store.createCollection('Work', revision());
    const base = { scope: 'collections', revision: revision(), id: collection.collectionId, name: 'Work' };
    const cursor = (changes: Partial<typeof base>) => Buffer.from(JSON.stringify({ ...base, ...changes })).toString('base64url');
    expect(() => store.listEntries('bad-scope', { cursor: cursor({ scope: 'bad-scope', name: '' }) })).toThrow('INVALID_ARGUMENT');
    for (const name of ['', ' Work ', 'bad\u0000name']) expect(() => store.listCollections({ cursor: cursor({ name }) })).toThrow('INVALID_ARGUMENT');
    expect(() => store.listCollections({ cursor: cursor({ revision: 'not-a-revision' }) })).toThrow('INVALID_ARGUMENT');
    expect(() => store.listEntries(collection.collectionId, { cursor: cursor({ scope: collection.collectionId, name: 'unexpected' }) })).toThrow('INVALID_ARGUMENT');
  });

  it('rolls back a failed link, including the new entry anchor and global revision', () => {
    const collection = store.createCollection('Work', revision());
    const db = new DatabaseSync(path);
    db.exec("CREATE TRIGGER reject_link BEFORE INSERT ON collection_membership BEGIN SELECT RAISE(ABORT, 'private raw error'); END;");
    const before = revision(); const receiptCount = db.prepare('SELECT count(*) AS n FROM collections_mutation_receipt').get()?.n;
    expect(() => store.applyMutation({ requestId: randomUUID(), expectedRevision: before, action: 'addEntry', payload: { collectionId: collection.collectionId, identity: reference } })).toThrow('METADATA_UNAVAILABLE');
    expect(revision()).toBe(before);
    expect(db.prepare('SELECT count(*) AS n FROM collection_entry').get()?.n).toBe(0);
    expect(db.prepare('SELECT count(*) AS n FROM collections_mutation_receipt').get()?.n).toBe(receiptCount);
    db.close();
  });

  it('reports bounded writer contention and permits retry with the same revision', () => {
    const db = new DatabaseSync(path); const before = revision();
    db.exec('BEGIN IMMEDIATE');
    expect(() => store.createCollection('Blocked', before)).toThrow('STORE_BUSY');
    db.exec('ROLLBACK'); db.close();
    expect(revision()).toBe(before);
    store.createCollection('Retry', before);
    expect(store.listCollections().items).toHaveLength(1);
  });

  it('refuses unsupported or foreign schema before creating tables or changing journal mode', async () => {
    const foreign = join(root, 'foreign.sqlite'); const db = new DatabaseSync(foreign);
    db.exec('CREATE TABLE collections_state(singleton INTEGER, schema_version INTEGER); INSERT INTO collections_state VALUES(1, 99)');
    db.close(); const before = await readFile(foreign);
    await expect(CollectionsStore.open(foreign)).rejects.toThrow('METADATA_UNAVAILABLE');
    expect(await readFile(foreign)).toEqual(before);
  });

  it('refuses and preserves a tableless database carrying a future SQLite user_version marker', async () => {
    const future = join(root, 'future-marker.sqlite'); const db = new DatabaseSync(future);
    db.exec('PRAGMA user_version = 99'); db.close(); const before = await readFile(future);
    await expect(CollectionsStore.open(future)).rejects.toThrow('METADATA_UNAVAILABLE');
    expect(await readFile(future)).toEqual(before);
  });

  it.each([
    ['missing column', (sql: string) => sql.replaceAll('native_id', 'other_id')],
    ['missing primary key', (sql: string) => sql.replace(', PRIMARY KEY (collection_id, entry_id)', '')],
    ['missing unique key', (sql: string) => sql.replace(',\n    UNIQUE (provider_id, source_id, native_id, reference_kind)', '')],
    ['missing cascade', (sql: string) => sql.replaceAll(' ON DELETE CASCADE', '')],
    ['missing foreign keys', (sql: string) => sql.replace(/ REFERENCES (user_collection\(collection_id\)|collection_entry\(entry_id\)) ON DELETE CASCADE/gu, '')],
    ['unexpected object', (sql: string) => sql + '\nCREATE VIEW foreign_view AS SELECT * FROM user_collection;'],
    ['future version', (sql: string) => sql.replaceAll('schema_version = 4', 'schema_version = 99').replace('VALUES (1, 4, 0)', 'VALUES (1, 99, 0)')],
  ])('retains all bytes and refuses a receipt-bearing schema with %s', async (_reason, alter) => {
    const malformed = join(root, 'malformed.sqlite'); const db = new DatabaseSync(malformed);
    try {
      db.exec(alter(COLLECTIONS_SCHEMA));
      expect(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT GLOB 'sqlite_*'").all()).toHaveLength(6);
    } finally { db.close(); }
    const before = await readFile(malformed);
    await expect(CollectionsStore.open(malformed)).rejects.toThrow('METADATA_UNAVAILABLE');
    expect(await readFile(malformed)).toEqual(before);
    const retained = new DatabaseSync(malformed, { readOnly: true });
    try { expect(retained.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('delete'); }
    finally { retained.close(); }
  });

  it.each([{ code: 'SQLITE_BUSY' }, { code: 'SQLITE_LOCKED' }, { errcode: 5 }, { errcode: 6 }])('classifies contention without leaking raw errors: %j', (detail) => {
    const before = revision();
    const failure = Object.assign(new Error('private SQLite failure'), detail);
    const exec = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementationOnce(() => { throw failure; });
    try { expect(() => store.createCollection('Blocked', before)).toThrow('STORE_BUSY'); }
    finally { exec.mockRestore(); }
    expect(revision()).toBe(before); expect(store.listCollections().items).toHaveLength(0);
  });

  it.each([false, true])('refuses a foreign sqliteforeign table even when owned tables exist: %s', async (initialized) => {
    const foreign = join(root, 'prefix.sqlite'); const db = new DatabaseSync(foreign);
    try {
      if (initialized) db.exec(COLLECTIONS_SCHEMA);
      db.exec('CREATE TABLE sqliteforeign(marker TEXT)');
    } finally { db.close(); }
    const before = await readFile(foreign);
    await expect(CollectionsStore.open(foreign)).rejects.toThrow('METADATA_UNAVAILABLE');
    expect(await readFile(foreign)).toEqual(before);
  });

  it('refuses a structurally valid database with broken membership foreign keys before journal changes', async () => {
    const broken = join(root, 'broken-links.sqlite'); const db = new DatabaseSync(broken, { enableForeignKeyConstraints: false });
    try {
      db.exec(COLLECTIONS_SCHEMA);
      db.prepare('INSERT INTO collection_membership VALUES (?, ?)').run(randomUUID(), randomUUID());
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(2);
    } finally { db.close(); }
    const before = await readFile(broken);
    await expect(CollectionsStore.open(broken)).rejects.toThrow('METADATA_UNAVAILABLE');
    expect(await readFile(broken)).toEqual(before);
  });

  it('never resets corrupt storage and rejects malformed names, identities and bounds', async () => {
    const corrupt = join(root, 'corrupt.sqlite'); await writeFile(corrupt, 'not a database');
    await expect(CollectionsStore.open(corrupt)).rejects.toThrow('METADATA_UNAVAILABLE');
    expect(await readFile(corrupt, 'utf8')).toBe('not a database');
    for (const name of ['', ' ', 'bad\u0000name', 'x'.repeat(121)]) expect(() => store.createCollection(name, revision())).toThrow('INVALID_ARGUMENT');
    expect(() => store.listCollections({ limit: 101 })).toThrow('INVALID_ARGUMENT');
    const collection = store.createCollection('Work', revision());
    expect(() => store.addEntry(collection.collectionId, { ...reference, nativeId: '' }, revision())).toThrow('INVALID_ARGUMENT');
    store.close(); expect(() => store.listCollections()).toThrow('METADATA_UNAVAILABLE');
  });

  it('replays canonical requests before CAS and rejects reused IDs with changed commands', () => {
    const collection = store.createCollection('Work', revision());
    const requestId = randomUUID(); const expectedRevision = revision();
    const command = { requestId, expectedRevision, action: 'addEntry' as const, payload: { collectionId: collection.collectionId, identity: reference } };
    const first = store.applyMutation(command);
    const replay = store.applyMutation({ ...command, payload: { collectionId: collection.collectionId,
      identity: { referenceKind: 'session', nativeId: 'thread-a', sourceId: 'source-a', providerId: 'codex' } } });
    expect(replay).toEqual(first);
    expect(store.listEntries(collection.collectionId).items).toHaveLength(1);
    expect(() => store.applyMutation({ ...command, payload: { collectionId: collection.collectionId,
      identity: { ...reference, nativeId: 'different-thread' } } })).toThrow('MUTATION_CONFLICT');
    expect(() => store.applyMutation({ ...command, requestId: randomUUID() })).toThrow('REVISION_CONFLICT');
    expect(revision()).toBe(String(Number(expectedRevision) + 1));
  });

  it('derives the same request locator from identical retained input and property reordering', () => {
    const input = { expectedRevision: revision(), action: 'createCollection' as const, payload: { displayName: 'Stable request' } };
    const reordered = { payload: { displayName: 'Stable request' }, action: 'createCollection' as const, expectedRevision: revision() };
    expect(collectionsMutationRequestId(input)).toBe(collectionsMutationRequestId(reordered));
    expect(collectionsMutationRequestId(input)).not.toBe(collectionsMutationRequestId({ ...input, expectedRevision: '1' }));
  });

  it('returns the committed receipt after a simulated lost COMMIT response and process reopen', async () => {
    const command = { requestId: randomUUID(), expectedRevision: revision(), action: 'createCollection' as const,
      payload: { displayName: 'Once' } };
    const original = DatabaseSync.prototype.exec; let lose = true;
    const exec = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
      original.call(this, sql);
      if (sql === 'COMMIT' && lose) { lose = false; throw new Error('simulated lost response'); }
    });
    try { expect(() => store.applyMutation(command)).toThrow('METADATA_UNAVAILABLE'); }
    finally { exec.mockRestore(); }
    store.close(); store = await CollectionsStore.open(path);
    const receipt = store.applyMutation(command);
    expect(receipt.result).toMatchObject({ displayName: 'Once' });
    expect(store.listCollections().items).toHaveLength(1);
  });

  it('serializes duplicate request IDs across two independent store connections', async () => {
    const second = await CollectionsStore.open(path);
    const command = { requestId: randomUUID(), expectedRevision: revision(), action: 'createCollection' as const,
      payload: { displayName: 'Shared request' } };
    const competingWriter = new DatabaseSync(path); competingWriter.exec('BEGIN IMMEDIATE');
    try {
      expect(() => store.applyMutation(command)).toThrow('STORE_BUSY');
      competingWriter.exec('ROLLBACK');
      const firstReceipt = store.applyMutation(command);
      expect(second.applyMutation(command)).toEqual(firstReceipt);
      expect(store.listCollections().items).toHaveLength(1);
    } finally { try { competingWriter.exec('ROLLBACK'); } catch { /* already released */ } competingWriter.close(); second.close(); }
  });

  it('upgrades only exact v1 DDL after retaining and validating an online same-directory backup', async () => {
    const legacyPath = join(root, 'legacy.sqlite'); const legacy = new DatabaseSync(legacyPath);
    legacy.exec(COLLECTIONS_SCHEMA_V1);
    legacy.prepare('INSERT INTO user_collection VALUES (?, ?)').run(randomUUID(), 'Retained v1');
    legacy.prepare('UPDATE collections_state SET revision = 7').run(); legacy.close();
    const migrated = await CollectionsStore.open(legacyPath);
    try {
      expect(migrated.listCollections()).toMatchObject({ metadataRevision: '7', items: [{ displayName: 'Retained v1' }] });
      const artifacts = (await readdir(root)).filter((name) => name.startsWith('legacy.sqlite.pre-v4.') && name.endsWith('.bak'));
      expect(artifacts).toHaveLength(1);
      const backupDb = new DatabaseSync(join(root, artifacts[0]!), { readOnly: true });
      try { expect(backupDb.prepare('SELECT schema_version, revision FROM collections_state').get()).toEqual({ schema_version: 1, revision: 7 }); }
      finally { backupDb.close(); }
    } finally { migrated.close(); }
    const reopened = await CollectionsStore.open(legacyPath);
    try {
      const command = { requestId: randomUUID(), expectedRevision: '7', action: 'createCollection' as const,
        payload: { displayName: 'After migration' } };
      const receipt = reopened.applyMutation(command);
      reopened.close();
      const restarted = await CollectionsStore.open(legacyPath);
      try { expect(restarted.applyMutation(command)).toEqual(receipt); expect(restarted.listCollections().items).toHaveLength(2); }
      finally { restarted.close(); }
    } finally { reopened.close(); }
  });

  it('rolls back v1 migration and keeps its source bytes and failed backup artifact when backup fails', async () => {
    const legacyPath = join(root, 'backup-failure.sqlite'); const legacy = new DatabaseSync(legacyPath);
    legacy.exec(COLLECTIONS_SCHEMA_V1); legacy.close();
    const before = await readFile(legacyPath);
    vi.mocked(backup).mockRejectedValueOnce(new Error('injected backup failure'));
    await expect(CollectionsStore.open(legacyPath)).rejects.toThrow('METADATA_UNAVAILABLE');
    expect(await readFile(legacyPath)).toEqual(before);
    const artifacts = (await readdir(root)).filter((name) => name.startsWith('backup-failure.sqlite.pre-v4.') && name.endsWith('.bak'));
    expect(artifacts).toHaveLength(1);
    const unchanged = new DatabaseSync(legacyPath, { readOnly: true });
    try { expect(unchanged.prepare('SELECT schema_version FROM collections_state').get()?.schema_version).toBe(1); }
    finally { unchanged.close(); }
  });

  it('accepts the exact former ALTER/RENAME v2 migration layout across reopen', async () => {
    const legacyPath = join(root, 'former-migration.sqlite'); const legacy = new DatabaseSync(legacyPath);
    legacy.exec(COLLECTIONS_SCHEMA_V1);
    legacy.exec(`CREATE TABLE collections_state_v2 (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1), schema_version INTEGER NOT NULL CHECK (schema_version = 2),
      revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision BETWEEN 0 AND 9007199254740991));
      INSERT INTO collections_state_v2 SELECT singleton, 2, revision FROM collections_state;
      DROP TABLE collections_state; ALTER TABLE collections_state_v2 RENAME TO collections_state;
      CREATE TABLE collections_mutation_receipt (
        request_id TEXT PRIMARY KEY NOT NULL, command_hash TEXT NOT NULL CHECK (length(command_hash) = 64),
        operation TEXT NOT NULL CHECK (operation IN ('createCollection', 'renameCollection', 'deleteCollection', 'addEntry', 'removeEntry')),
        previous_revision INTEGER NOT NULL CHECK (typeof(previous_revision) = 'integer' AND previous_revision BETWEEN 0 AND 9007199254740991),
        metadata_revision INTEGER NOT NULL CHECK (typeof(metadata_revision) = 'integer' AND metadata_revision BETWEEN 0 AND 9007199254740991),
        changed INTEGER NOT NULL CHECK (changed IN (0, 1)), result_json TEXT NOT NULL CHECK (length(result_json) BETWEEN 2 AND 32768));`);
    legacy.close();
    const first = await CollectionsStore.open(legacyPath);
    const command = { requestId: randomUUID(), expectedRevision: '0', action: 'createCollection' as const, payload: { displayName: 'Retained' } };
    const receipt = first.applyMutation(command); first.close();
    const second = await CollectionsStore.open(legacyPath);
    try { expect(second.applyMutation(command)).toEqual(receipt); expect(second.listCollections().items).toHaveLength(1); }
    finally { second.close(); }
  });

  it('rejects a backup whose DDL fails verification and leaves the source v1 database unchanged', async () => {
    const legacyPath = join(root, 'invalid-backup.sqlite'); const legacy = new DatabaseSync(legacyPath);
    legacy.exec(COLLECTIONS_SCHEMA_V1); legacy.close();
    const before = await readFile(legacyPath);
    vi.mocked(backup).mockImplementationOnce(async (_source, target) => {
      const invalid = new DatabaseSync(target); invalid.exec('CREATE VIEW foreign_view AS SELECT * FROM user_collection'); invalid.close();
      return 1;
    });
    await expect(CollectionsStore.open(legacyPath)).rejects.toThrow('METADATA_UNAVAILABLE');
    expect(await readFile(legacyPath)).toEqual(before);
    const unchanged = new DatabaseSync(legacyPath, { readOnly: true });
    try { expect(unchanged.prepare('SELECT schema_version FROM collections_state').get()?.schema_version).toBe(1); }
    finally { unchanged.close(); }
    expect((await readdir(root)).some((name) => name.startsWith('invalid-backup.sqlite.pre-v4.') && name.endsWith('.bak'))).toBe(true);
  });

  it('refuses new writes at receipt capacity without evicting an existing idempotency key', () => {
    const fixture = new DatabaseSync(path); fixture.exec('BEGIN IMMEDIATE');
    const insert = fixture.prepare(`INSERT INTO collections_mutation_receipt
      (request_id, command_hash, operation, previous_revision, metadata_revision, changed, result_json) VALUES (?, ?, ?, 0, 0, 0, 'false')`);
    for (let i = 0; i < COLLECTIONS_RECEIPT_CAPACITY; i++) insert.run(randomUUID(), 'a'.repeat(64), 'deleteCollection');
    fixture.exec('COMMIT'); fixture.close();
    expect(() => store.applyMutation({ requestId: randomUUID(), expectedRevision: revision(), action: 'createCollection',
      payload: { displayName: 'Full' } })).toThrow('RECEIPT_CAPACITY');
    expect(revision()).toBe('0');
    const check = new DatabaseSync(path, { readOnly: true });
    try { expect(check.prepare('SELECT count(*) AS n FROM collections_mutation_receipt').get()?.n).toBe(COLLECTIONS_RECEIPT_CAPACITY); }
    finally { check.close(); }
  });
});
