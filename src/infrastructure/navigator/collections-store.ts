import { randomUUID } from 'node:crypto';
import { mkdir, open as openFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { CollectionsError, type CollectionEntryReference, type CollectionReferenceIdentity, type CollectionsMutation, type CollectionsMutationCommand, type CollectionsMutationReceipt, type CollectionsPage, type CollectionsPageRequest, type CollectionsPort, type UserCollection } from '@application/index';
import { COLLECTIONS_SCHEMA, COLLECTIONS_STATE_V4_DDL, COLLECTIONS_PENDING_DDL, COLLECTIONS_RECEIPT_V3_DDL, COLLECTIONS_ENTRY_V3_DDL, COLLECTIONS_MEMBERSHIP_DDL, verifyCollectionsSchema } from './collections-schema';
import { CollectionsCommandJournal, collectionsCommandHash as commandHash } from './collections-journal';

interface CollectionRow { collection_id: string; display_name: string; entry_count: number }
interface EntryRow { entry_id: string; collection_id: string; provider_id: CollectionReferenceIdentity['providerId']; source_id: string; native_id: string; reference_kind: CollectionReferenceIdentity['referenceKind']; display_alias: string | null; local_archived_at_ms: number | null }
interface PageKey { scope: string; revision: string; id: string; name: string }
const PROVIDERS = new Set(['codex', 'claude', 'pi', 'kimi', 'gemini', 'opencode', 'agentsview', 'generic']);
export const COLLECTIONS_RECEIPT_CAPACITY = 10_000;
export type CollectionsMutationInput = CollectionsMutation & { readonly expectedRevision: string };

/** Only the owned metadata database is accessed; provider/catalog connections are never attached. */
export class CollectionsStore implements CollectionsPort {
  #closed = false;
  private readonly db: DatabaseSync;
  private readonly journal: CollectionsCommandJournal;
  private constructor(db: DatabaseSync) { this.db = db; this.journal = new CollectionsCommandJournal(db, validateCollectionsMutationCommand); }

  public static async open(path: string): Promise<CollectionsStore> {
    let db: DatabaseSync | undefined;
    try {
      await mkdir(dirname(path), { recursive: true });
      db = new DatabaseSync(path, { timeout: 250, enableForeignKeyConstraints: true });
      const fresh = verifyCollectionsSchema(db);
      if (!fresh && db.prepare('PRAGMA foreign_key_check').get() !== undefined) throw new CollectionsError('METADATA_UNAVAILABLE');
      if (!fresh && Number((db.prepare('SELECT schema_version FROM collections_state WHERE singleton = 1').get() as { schema_version: number }).schema_version) < 4) {
        await migrateLegacy(db, path);
      }
      db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      if (db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1 || db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'wal'
        || db.prepare('PRAGMA synchronous').get()?.synchronous !== 2) throw new CollectionsError('METADATA_UNAVAILABLE');
      if (fresh) db.exec(COLLECTIONS_SCHEMA);
      return new CollectionsStore(db);
    } catch (error) {
      try { db?.close(); } catch { /* Opening failed; retain the original failure class. */ }
      throw fixedError(error);
    }
  }

  public listCollections(request: CollectionsPageRequest = {}): CollectionsPage<UserCollection> {
    return this.read(() => {
      const revision = this.revision();
      const key = pageKey(request, 'collections', revision);
      const limit = pageLimit(request);
      const rows = this.db.prepare(`SELECT c.collection_id, c.display_name,
        (SELECT count(*) FROM collection_membership m WHERE m.collection_id = c.collection_id) AS entry_count
        FROM user_collection c WHERE ? IS NULL OR c.display_name COLLATE BINARY > ?
          OR (c.display_name COLLATE BINARY = ? AND c.collection_id > ?)
        ORDER BY c.display_name COLLATE BINARY, c.collection_id LIMIT ?`)
        .all(key?.name ?? null, key?.name ?? null, key?.name ?? null, key?.id ?? null, limit + 1) as unknown as CollectionRow[];
      const items = rows.slice(0, limit).map(toCollection);
      const last = items.at(-1);
      return { items, metadataRevision: revision, ...(rows.length > limit && last !== undefined ? { nextCursor: encodeKey({ scope: 'collections', revision, id: last.collectionId, name: last.displayName }) } : {}) };
    });
  }

  public listEntries(collectionId: string, request: CollectionsPageRequest = {}): CollectionsPage<CollectionEntryReference> {
    validId(collectionId);
    return this.read(() => {
      const revision = this.revision();
      const key = pageKey(request, collectionId, revision);
      const limit = pageLimit(request);
      if (this.collectionById(collectionId) === undefined) throw new CollectionsError('NOT_FOUND');
      const rows = this.db.prepare(`SELECT e.*, m.collection_id FROM collection_membership m
        JOIN collection_entry e ON e.entry_id = m.entry_id WHERE m.collection_id = ? AND (? IS NULL OR e.entry_id > ?)
        ORDER BY e.entry_id LIMIT ?`).all(collectionId, key?.id ?? null, key?.id ?? null, limit + 1) as unknown as EntryRow[];
      const items = rows.slice(0, limit).map(toEntry);
      const last = items.at(-1);
      return { items, metadataRevision: revision, ...(rows.length > limit && last !== undefined ? { nextCursor: encodeKey({ scope: collectionId, revision, id: last.entryId, name: '' }) } : {}) };
    });
  }

  public listArchivedSessionReferences(identities: readonly CollectionReferenceIdentity[]): readonly CollectionReferenceIdentity[] {
    if (!Array.isArray(identities) || identities.length > 500) throw new CollectionsError('INVALID_ARGUMENT');
    if (identities.length === 0) return [];
    const unique = new Map<string, CollectionReferenceIdentity>();
    for (const identity of identities) {
      validateIdentity(identity);
      if (identity.referenceKind !== 'session') continue;
      unique.set(JSON.stringify([identity.providerId, identity.sourceId, identity.nativeId]), identity);
    }
    if (unique.size === 0) return [];
    return this.read(() => {
      const candidates = [...unique.values()];
      const predicates = candidates.map(() => "(e.provider_id = ? AND e.source_id = ? AND e.native_id = ?)").join(' OR ');
      const parameters = candidates.flatMap(({ providerId, sourceId, nativeId }) => [providerId, sourceId, nativeId]);
      const rows = this.db.prepare(`SELECT e.provider_id, e.source_id, e.native_id FROM collection_entry e
        WHERE e.reference_kind = 'session' AND e.local_archived_at_ms IS NOT NULL
          AND EXISTS (SELECT 1 FROM collection_membership m WHERE m.entry_id = e.entry_id)
          AND (${predicates})`)
        .all(...parameters) as unknown as Array<Pick<EntryRow, 'provider_id' | 'source_id' | 'native_id'>>;
      return rows.map((row) => ({ providerId: row.provider_id, sourceId: row.source_id, nativeId: row.native_id, referenceKind: 'session' }));
    });
  }

  public createCollection(displayName: string, expectedRevision: string): UserCollection {
    return this.applyMutation({ requestId: randomUUID(), expectedRevision, action: 'createCollection', payload: { displayName } }).result as UserCollection;
  }

  public renameCollection(collectionId: string, displayName: string, expectedRevision: string): UserCollection {
    return this.applyMutation({ requestId: randomUUID(), expectedRevision, action: 'renameCollection', payload: { collectionId, displayName } }).result as UserCollection;
  }

  public deleteCollection(collectionId: string, expectedRevision: string): boolean {
    return this.applyMutation({ requestId: randomUUID(), expectedRevision, action: 'deleteCollection', payload: { collectionId } }).result as boolean;
  }

  public addEntry(collectionId: string, identity: CollectionReferenceIdentity, expectedRevision: string): CollectionEntryReference {
    return this.applyMutation({ requestId: randomUUID(), expectedRevision, action: 'addEntry', payload: { collectionId, identity } }).result as CollectionEntryReference;
  }

  public removeEntry(collectionId: string, entryId: string, expectedRevision: string): boolean {
    return this.applyMutation({ requestId: randomUUID(), expectedRevision, action: 'removeEntry', payload: { collectionId, entryId } }).result as boolean;
  }

  public applyMutation(command: CollectionsMutationCommand, beforeApply?: () => void): CollectionsMutationReceipt {
    validateCollectionsMutationCommand(command);
    const hash = commandHash(command);
    return this.mutateReceipt(command, hash, beforeApply);
  }

  public validateMutation(command: CollectionsMutationCommand): void {
    validateCollectionsMutationCommand(command);
    this.read(() => {
      if (this.revision() !== command.expectedRevision) throw new CollectionsError('REVISION_CONFLICT');
      this.validateEntryMutation(command);
    });
  }

  public listPendingMutations(): readonly CollectionsMutationCommand[] { return this.read(() => this.journal.list()); }
  public acceptPendingMutation(command: CollectionsMutationCommand): void { this.importLegacyMutations([command]); }
  public importLegacyMutations(commands: readonly CollectionsMutationCommand[]): void { this.journalWrite(() => this.journal.accept(commands)); }
  public completePendingMutation(command: CollectionsMutationCommand): void { this.journalWrite(() => this.journal.complete(command)); }

  private journalWrite(operation: () => void): void {
    this.assertOpen();
    try { this.db.exec('BEGIN IMMEDIATE'); operation(); this.db.exec('COMMIT'); }
    catch (error) { this.rollback(); throw fixedError(error); }
  }

  public close(): void { if (!this.#closed) { this.#closed = true; this.db.close(); } }

  private revision(): string {
    const row = this.db.prepare('SELECT revision FROM collections_state WHERE singleton = 1').get();
    if (!Number.isSafeInteger(row?.revision) || Number(row?.revision) < 0) throw new CollectionsError('METADATA_UNAVAILABLE');
    return String(row?.revision);
  }

  private collectionById(id: string): UserCollection | undefined {
    const row = this.db.prepare(`SELECT c.*,
      (SELECT count(*) FROM collection_membership m WHERE m.collection_id = c.collection_id) AS entry_count
      FROM user_collection c WHERE collection_id = ?`).get(id) as unknown as CollectionRow | undefined;
    return row === undefined ? undefined : toCollection(row);
  }

  private read<T>(operation: () => T): T {
    this.assertOpen();
    try { this.db.exec('BEGIN'); const value = operation(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.rollback(); throw fixedError(error); }
  }

  private mutateReceipt(command: CollectionsMutationCommand, hash: string, beforeApply?: () => void): CollectionsMutationReceipt {
    this.assertOpen();
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const prior = this.db.prepare('SELECT * FROM collections_mutation_receipt WHERE request_id = ?').get(command.requestId) as ReceiptRow | undefined;
      if (prior !== undefined) {
        if (prior.command_hash !== hash) throw new CollectionsError('MUTATION_CONFLICT');
        this.db.exec('COMMIT');
        return fromReceipt(prior);
      }
      const previousRevision = this.revision();
      if (previousRevision !== command.expectedRevision) throw new CollectionsError('REVISION_CONFLICT');
      if (Number(previousRevision) === Number.MAX_SAFE_INTEGER) throw new CollectionsError('METADATA_UNAVAILABLE');
      const count = Number((this.db.prepare('SELECT count(*) AS count FROM collections_mutation_receipt').get() as { count: number }).count);
      if (count >= COLLECTIONS_RECEIPT_CAPACITY) throw new CollectionsError('RECEIPT_CAPACITY');
      beforeApply?.();
      this.validateEntryMutation(command);
      const result = this.applyCommand(command);
      const metadataRevision = result.changed ? String(Number(previousRevision) + 1) : previousRevision;
      if (result.changed) this.db.prepare('UPDATE collections_state SET revision = revision + 1 WHERE singleton = 1').run();
      const resultJson = JSON.stringify(result.value);
      if (Buffer.byteLength(resultJson, 'utf8') > 32_768) throw new CollectionsError('METADATA_UNAVAILABLE');
      this.db.prepare(`INSERT INTO collections_mutation_receipt
        (request_id, command_hash, operation, previous_revision, metadata_revision, changed, result_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(command.requestId, hash, command.action, Number(previousRevision), Number(metadataRevision), result.changed ? 1 : 0, resultJson);
      this.db.exec('COMMIT');
      return { requestId: command.requestId, operation: command.action, commandHash: hash, previousRevision, metadataRevision,
        changed: result.changed, result: result.value };
    } catch (error) { this.rollback(); throw fixedError(error); }
  }

  private applyCommand(command: CollectionsMutationCommand): { value: UserCollection | CollectionEntryReference | boolean; changed: boolean } {
    switch (command.action) {
      case 'createCollection': {
        const name = validateName(command.payload.displayName); const id = randomUUID();
        this.db.prepare('INSERT INTO user_collection(collection_id, display_name) VALUES (?, ?)').run(id, name);
        return { value: { collectionId: id, displayName: name, entryCount: 0 }, changed: true };
      }
      case 'renameCollection': {
        validId(command.payload.collectionId); const name = validateName(command.payload.displayName);
        const current = this.collectionById(command.payload.collectionId); if (current === undefined) throw new CollectionsError('NOT_FOUND');
        const changed = current.displayName !== name;
        if (changed) this.db.prepare('UPDATE user_collection SET display_name = ? WHERE collection_id = ?').run(name, command.payload.collectionId);
        return { value: { ...current, displayName: name }, changed };
      }
      case 'deleteCollection': {
        validId(command.payload.collectionId);
        const changed = this.db.prepare('DELETE FROM user_collection WHERE collection_id = ?').run(command.payload.collectionId).changes === 1;
        return { value: changed, changed };
      }
      case 'addEntry': {
        validId(command.payload.collectionId); validateIdentity(command.payload.identity);
        if (this.collectionById(command.payload.collectionId) === undefined) throw new CollectionsError('NOT_FOUND');
        const identity = command.payload.identity;
        this.db.prepare(`INSERT INTO collection_entry(entry_id, provider_id, source_id, native_id, reference_kind)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT(provider_id, source_id, native_id, reference_kind) DO NOTHING`)
          .run(randomUUID(), identity.providerId, identity.sourceId, identity.nativeId, identity.referenceKind);
        const row = this.db.prepare('SELECT entry_id FROM collection_entry WHERE provider_id = ? AND source_id = ? AND native_id = ? AND reference_kind = ?')
          .get(identity.providerId, identity.sourceId, identity.nativeId, identity.referenceKind) as { entry_id: string };
        const changed = this.db.prepare('INSERT INTO collection_membership VALUES (?, ?) ON CONFLICT DO NOTHING').run(command.payload.collectionId, row.entry_id).changes === 1;
        return { value: { ...identity, entryId: row.entry_id, collectionId: command.payload.collectionId }, changed };
      }
      case 'removeEntry': {
        validId(command.payload.collectionId); validId(command.payload.entryId);
        const changed = this.db.prepare('DELETE FROM collection_membership WHERE collection_id = ? AND entry_id = ?').run(command.payload.collectionId, command.payload.entryId).changes === 1;
        return { value: changed, changed };
      }
      case 'setAlias': {
        const current = this.entryById(command.payload.entryId);
        const alias = command.payload.displayAlias === null ? null : validateName(command.payload.displayAlias);
        const changed = current.display_alias !== alias;
        if (changed) this.db.prepare('UPDATE collection_entry SET display_alias = ? WHERE entry_id = ?').run(alias, current.entry_id);
        return { value: changed, changed };
      }
      case 'setLocalArchive': {
        const current = this.entryById(command.payload.entryId);
        if (current.reference_kind !== 'session') throw new CollectionsError('INVALID_ARGUMENT');
        const changed = current.local_archived_at_ms !== command.payload.archivedAtMs;
        if (changed) this.db.prepare('UPDATE collection_entry SET local_archived_at_ms = ? WHERE entry_id = ?').run(command.payload.archivedAtMs, current.entry_id);
        return { value: changed, changed };
      }
      case 'rebindEntry': {
        const current = this.entryById(command.payload.entryId);
        const identity = command.payload.identity; validateIdentity(identity);
        const collision = this.db.prepare('SELECT entry_id FROM collection_entry WHERE provider_id = ? AND source_id = ? AND native_id = ? AND reference_kind = ?')
          .get(identity.providerId, identity.sourceId, identity.nativeId, identity.referenceKind);
        if (collision !== undefined && collision.entry_id !== current.entry_id) throw new CollectionsError('IDENTITY_CONFLICT');
        if (current.local_archived_at_ms !== null && identity.referenceKind !== 'session') throw new CollectionsError('INVALID_ARGUMENT');
        const changed = collision === undefined;
        if (changed) this.db.prepare('UPDATE collection_entry SET provider_id = ?, source_id = ?, native_id = ?, reference_kind = ? WHERE entry_id = ?')
          .run(identity.providerId, identity.sourceId, identity.nativeId, identity.referenceKind, current.entry_id);
        return { value: changed, changed };
      }
    }
  }

  private entryById(entryId: string): EntryRow {
    validId(entryId);
    const current = this.db.prepare('SELECT * FROM collection_entry WHERE entry_id = ?').get(entryId) as unknown as EntryRow | undefined;
    if (current === undefined) throw new CollectionsError('NOT_FOUND');
    return current;
  }

  private validateEntryMutation(command: CollectionsMutationCommand): void {
    if (command.action === 'renameCollection' || command.action === 'addEntry') {
      if (this.collectionById(command.payload.collectionId) === undefined) throw new CollectionsError('NOT_FOUND');
    }
    if (command.action === 'setAlias') { this.entryById(command.payload.entryId); return; }
    if (command.action === 'setLocalArchive') {
      if (this.entryById(command.payload.entryId).reference_kind !== 'session') throw new CollectionsError('INVALID_ARGUMENT');
    }
    if (command.action === 'rebindEntry') {
      const current = this.entryById(command.payload.entryId); const identity = command.payload.identity;
      const collision = this.db.prepare('SELECT entry_id FROM collection_entry WHERE provider_id = ? AND source_id = ? AND native_id = ? AND reference_kind = ?')
        .get(identity.providerId, identity.sourceId, identity.nativeId, identity.referenceKind);
      if (collision !== undefined && collision.entry_id !== current.entry_id) throw new CollectionsError('IDENTITY_CONFLICT');
      if (current.local_archived_at_ms !== null && identity.referenceKind !== 'session') throw new CollectionsError('INVALID_ARGUMENT');
    }
  }

  private rollback(): void { try { this.db.exec('ROLLBACK'); } catch { /* No transaction was acquired or it already settled. */ } }
  private assertOpen(): void { if (this.#closed) throw new CollectionsError('METADATA_UNAVAILABLE'); }
}
interface ReceiptRow {
  request_id: string; command_hash: string; operation: CollectionsMutationCommand['action']; previous_revision: number;
  metadata_revision: number; changed: number; result_json: string;
}
function fromReceipt(row: ReceiptRow): CollectionsMutationReceipt {
  return { requestId: row.request_id, operation: row.operation, commandHash: row.command_hash,
    previousRevision: String(row.previous_revision), metadataRevision: String(row.metadata_revision),
    changed: row.changed === 1, result: JSON.parse(row.result_json) as CollectionsMutationReceipt['result'] };
}
/** Deterministic locator only for callers retaining this exact input, including its revision. */
export function collectionsMutationRequestId(input: CollectionsMutationInput): string {
  const placeholder: CollectionsMutationCommand = { ...input, requestId: '00000000-0000-0000-0000-000000000000' };
  validateCollectionsMutationCommand(placeholder);
  const digest = commandHash(placeholder).slice(0, 32).split('');
  digest[12] = '5';
  digest[16] = ((Number.parseInt(digest[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  const hex = digest.join('');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
}
export function validateCollectionsMutationCommand(command: CollectionsMutationCommand): void {
  if (command === null || typeof command !== 'object' || Array.isArray(command)
    || !hasExactKeys(command, ['action', 'expectedRevision', 'payload', 'requestId'])) throw new CollectionsError('INVALID_ARGUMENT');
  validId(command.requestId);
  if (typeof command.expectedRevision !== 'string' || !/^(0|[1-9]\d{0,15})$/u.test(command.expectedRevision)
    || !Number.isSafeInteger(Number(command.expectedRevision))) throw new CollectionsError('INVALID_ARGUMENT');
  if (command.action === 'createCollection') {
    if (!hasExactKeys(command.payload, ['displayName']) || typeof command.payload.displayName !== 'string') throw new CollectionsError('INVALID_ARGUMENT');
    validateName(command.payload.displayName);
  } else if (command.action === 'renameCollection') {
    if (!hasExactKeys(command.payload, ['collectionId', 'displayName']) || typeof command.payload.collectionId !== 'string' || typeof command.payload.displayName !== 'string') throw new CollectionsError('INVALID_ARGUMENT');
    validId(command.payload.collectionId); validateName(command.payload.displayName);
  } else if (command.action === 'deleteCollection') {
    if (!hasExactKeys(command.payload, ['collectionId']) || typeof command.payload.collectionId !== 'string') throw new CollectionsError('INVALID_ARGUMENT');
    validId(command.payload.collectionId);
  } else if (command.action === 'addEntry') {
    if (!hasExactKeys(command.payload, ['collectionId', 'identity']) || typeof command.payload.collectionId !== 'string'
      || !hasExactKeys(command.payload.identity, ['nativeId', 'providerId', 'referenceKind', 'sourceId'])) throw new CollectionsError('INVALID_ARGUMENT');
    validId(command.payload.collectionId); validateIdentity(command.payload.identity);
  } else if (command.action === 'removeEntry') {
    if (!hasExactKeys(command.payload, ['collectionId', 'entryId']) || typeof command.payload.collectionId !== 'string' || typeof command.payload.entryId !== 'string') throw new CollectionsError('INVALID_ARGUMENT');
    validId(command.payload.collectionId); validId(command.payload.entryId);
  } else if (command.action === 'setAlias') {
    if (!hasExactKeys(command.payload, ['entryId', 'displayAlias']) || typeof command.payload.entryId !== 'string'
      || (command.payload.displayAlias !== null && typeof command.payload.displayAlias !== 'string')) throw new CollectionsError('INVALID_ARGUMENT');
    validId(command.payload.entryId);
    if (command.payload.displayAlias !== null) validateName(command.payload.displayAlias);
  } else if (command.action === 'setLocalArchive') {
    if (!hasExactKeys(command.payload, ['entryId', 'archivedAtMs']) || typeof command.payload.entryId !== 'string'
      || (command.payload.archivedAtMs !== null && (!Number.isSafeInteger(command.payload.archivedAtMs) || command.payload.archivedAtMs < 0))) throw new CollectionsError('INVALID_ARGUMENT');
    validId(command.payload.entryId);
  } else if (command.action === 'rebindEntry') {
    if (!hasExactKeys(command.payload, ['entryId', 'identity']) || typeof command.payload.entryId !== 'string'
      || !hasExactKeys(command.payload.identity, ['nativeId', 'providerId', 'referenceKind', 'sourceId'])) throw new CollectionsError('INVALID_ARGUMENT');
    validId(command.payload.entryId); validateIdentity(command.payload.identity);
  } else throw new CollectionsError('INVALID_ARGUMENT');
  const canonical = JSON.stringify({ action: command.action, expectedRevision: command.expectedRevision, payload: canonicalValue(command.payload) });
  if (Buffer.byteLength(canonical, 'utf8') > 16_384) throw new CollectionsError('INVALID_ARGUMENT');
}
function hasExactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
}
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonicalValue(item)]));
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new CollectionsError('INVALID_ARGUMENT');
  if (value === undefined || typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') throw new CollectionsError('INVALID_ARGUMENT');
  return value;
}

async function migrateLegacy(db: DatabaseSync, path: string): Promise<void> {
  const backupPath = join(dirname(path), basename(path) + '.pre-v4.' + randomUUID() + '.bak');
  let reserve: Awaited<ReturnType<typeof openFile>> | undefined;
  let source: DatabaseSync | undefined;
  try {
    db.exec('BEGIN IMMEDIATE');
    const freshVersion = verifyCollectionsSchema(db)
      ? undefined
      : Number((db.prepare('SELECT schema_version FROM collections_state WHERE singleton = 1').get() as { schema_version: number }).schema_version);
    if (freshVersion === 4) { db.exec('COMMIT'); return; }
    if (freshVersion !== 1 && freshVersion !== 2 && freshVersion !== 3) throw new CollectionsError('METADATA_UNAVAILABLE');
    reserve = await openFile(backupPath, 'wx'); await reserve.close(); reserve = undefined;
    source = new DatabaseSync(path, { readOnly: true, enableForeignKeyConstraints: true });
    await backup(source, backupPath, { rate: 32 });
    const copy = new DatabaseSync(backupPath, { readOnly: true, enableForeignKeyConstraints: true });
    try {
      if (verifyCollectionsSchema(copy) !== false
        || Number((copy.prepare('SELECT schema_version FROM collections_state WHERE singleton = 1').get() as { schema_version: number }).schema_version) !== freshVersion
        || copy.prepare('PRAGMA foreign_key_check').get() !== undefined
        || copy.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') throw new CollectionsError('METADATA_UNAVAILABLE');
      const backupRevision = Number((copy.prepare('SELECT revision FROM collections_state WHERE singleton = 1').get() as { revision: number }).revision);
      if (backupRevision !== Number((db.prepare('SELECT revision FROM collections_state WHERE singleton = 1').get() as { revision: number }).revision)) {
        throw new CollectionsError('METADATA_UNAVAILABLE');
      }
    } finally { copy.close(); }
    source.close(); source = undefined;
    const revision = (db.prepare('SELECT revision FROM collections_state WHERE singleton = 1').get() as { revision: number }).revision;
    // Copy using SQL inside the writer transaction; no catalog/provider attachment or
    // unbounded JS materialization. Recreate canonical DDL, preserving receipt JSON verbatim.
    if (freshVersion < 3) db.exec(`CREATE TEMP TABLE retained_membership AS SELECT * FROM collection_membership;
      DROP TABLE collection_membership;
      CREATE TEMP TABLE retained_entry AS SELECT * FROM collection_entry;
      DROP TABLE collection_entry;
      ${COLLECTIONS_ENTRY_V3_DDL}
      INSERT INTO collection_entry(entry_id, provider_id, source_id, native_id, reference_kind)
        SELECT entry_id, provider_id, source_id, native_id, reference_kind FROM retained_entry;
      DROP TABLE retained_entry;
      ${COLLECTIONS_MEMBERSHIP_DDL}
      INSERT INTO collection_membership SELECT * FROM retained_membership;
      DROP TABLE retained_membership;`);
    if (freshVersion === 2) db.exec(`CREATE TEMP TABLE retained_receipt AS SELECT * FROM collections_mutation_receipt;
      DROP TABLE collections_mutation_receipt;
      ${COLLECTIONS_RECEIPT_V3_DDL}
      INSERT INTO collections_mutation_receipt SELECT * FROM retained_receipt;
      DROP TABLE retained_receipt;`);
    else if (freshVersion === 1) db.exec(COLLECTIONS_RECEIPT_V3_DDL);
    db.exec(`DROP TABLE collections_state; ${COLLECTIONS_STATE_V4_DDL} ${COLLECTIONS_PENDING_DDL}`);
    db.prepare('INSERT INTO collections_state VALUES (1, 4, ?)').run(revision);
    verifyCollectionsSchema(db);
    if (db.prepare('PRAGMA foreign_key_check').get() !== undefined) throw new CollectionsError('METADATA_UNAVAILABLE');
    db.exec('COMMIT');
  } catch (error) {
    try { source?.close(); } catch { /* preserve migration failure */ }
    try { db.exec('ROLLBACK'); } catch { /* preserve migration failure */ }
    throw error;
  } finally { try { await reserve?.close(); } catch { /* reservation already closed */ } }
}

function toCollection(row: CollectionRow): UserCollection { return { collectionId: row.collection_id, displayName: row.display_name, entryCount: Number(row.entry_count) }; }
function toEntry(row: EntryRow): CollectionEntryReference { return { entryId: row.entry_id, collectionId: row.collection_id, providerId: row.provider_id, sourceId: row.source_id, nativeId: row.native_id, referenceKind: row.reference_kind,
  ...(row.display_alias === null ? {} : { displayAlias: row.display_alias }), ...(row.local_archived_at_ms === null ? {} : { localArchivedAtMs: row.local_archived_at_ms }) }; }
function validId(value: string): void { if (typeof value !== 'string' || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/u.test(value)) throw new CollectionsError('INVALID_ARGUMENT'); }
function validateName(value: string): string {
  if (typeof value !== 'string') throw new CollectionsError('INVALID_ARGUMENT');
  const name = value.trim();
  if (!name || [...name].length > 120 || Buffer.byteLength(name, 'utf8') > 512 || /[\u0000-\u001f\u007f]/u.test(name)) throw new CollectionsError('INVALID_ARGUMENT');
  return name;
}
function validateIdentity(value: CollectionReferenceIdentity): void {
  if (value === null || typeof value !== 'object' || !PROVIDERS.has(value.providerId)
    || typeof value.sourceId !== 'string' || !value.sourceId || value.sourceId.length > 256
    || typeof value.nativeId !== 'string' || !value.nativeId || value.nativeId.length > 4096
    || !['session', 'file', 'source'].includes(value.referenceKind) || (value.referenceKind === 'source' && value.nativeId !== '@source')
    || (value.referenceKind === 'file' && value.nativeId !== '@file')
    || /[\u0000-\u001f\u007f]/u.test(value.sourceId + value.nativeId)) throw new CollectionsError('INVALID_ARGUMENT');
}
function pageLimit(request: CollectionsPageRequest): number {
  const limit = request.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new CollectionsError('INVALID_ARGUMENT');
  return limit;
}
function encodeKey(key: PageKey): string { return Buffer.from(JSON.stringify(key)).toString('base64url'); }
function pageKey(request: CollectionsPageRequest, scope: string, revision: string): PageKey | undefined {
  if (request.cursor === undefined) return undefined;
  try {
    if (typeof request.cursor !== 'string' || request.cursor.length > 4096) throw new Error();
    const key = JSON.parse(Buffer.from(request.cursor, 'base64url').toString('utf8')) as PageKey;
    if (key.scope !== scope || typeof key.id !== 'string' || typeof key.name !== 'string' || typeof key.revision !== 'string') throw new Error();
    validId(key.id);
    if (!/^(0|[1-9]\d{0,15})$/u.test(key.revision) || !Number.isSafeInteger(Number(key.revision))) throw new Error();
    if (scope === 'collections') {
      if (validateName(key.name) !== key.name) throw new Error();
    } else {
      validId(key.scope);
      if (key.name !== '') throw new Error();
    }
    if (key.revision !== revision) throw new CollectionsError('SNAPSHOT_CHANGED');
    return key;
  } catch (error) { throw error instanceof CollectionsError ? error : new CollectionsError('INVALID_ARGUMENT'); }
}
function fixedError(error: unknown): CollectionsError {
  if (error instanceof CollectionsError) return error;
  const detail = error !== null && typeof error === 'object' ? error : undefined;
  const errcode = detail !== undefined && 'errcode' in detail ? detail.errcode : undefined;
  const code = detail !== undefined && 'code' in detail ? detail.code : undefined;
  return new CollectionsError(errcode === 5 || errcode === 6 || code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' ? 'STORE_BUSY' : 'METADATA_UNAVAILABLE');
}
