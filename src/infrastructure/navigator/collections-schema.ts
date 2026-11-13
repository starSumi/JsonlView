import { DatabaseSync } from 'node:sqlite';
import { CollectionsError } from '@application/index';

/** Refuse foreign/future databases before changing journal mode or creating tables. */
export function verifyCollectionsSchema(db: DatabaseSync): boolean {
  const actual = schemaObjects(db);
  const applicationId = db.prepare('PRAGMA application_id').get()?.application_id;
  const userVersion = db.prepare('PRAGMA user_version').get()?.user_version;
  if (applicationId !== 0 || userVersion !== 0) throw new CollectionsError('METADATA_UNAVAILABLE');
  if (actual.length === 0) return true;
  // This private database accepts only its own versioned DDL: exact object and
  // constraint definitions bind required columns, PKs, unique keys and cascades.
  let matchedVersion: number | undefined;
  for (const [version, ddl] of [[4, COLLECTIONS_SCHEMA], [3, COLLECTIONS_SCHEMA_V3], [2, COLLECTIONS_SCHEMA_V2], [1, COLLECTIONS_SCHEMA_V1]] as const) {
    const reference = new DatabaseSync(':memory:');
    try { reference.exec(ddl); if (JSON.stringify(actual) === JSON.stringify(schemaObjects(reference))) matchedVersion = version; }
    finally { reference.close(); }
  }
  const oldMigration = referenceMigratedV2();
  try { if (JSON.stringify(actual) === JSON.stringify(schemaObjects(oldMigration))) matchedVersion = 2; }
  finally { oldMigration.close(); }
  if (matchedVersion === undefined) throw new CollectionsError('METADATA_UNAVAILABLE');
  const state = db.prepare('SELECT singleton, schema_version, revision FROM collections_state').all();
  if (state.length !== 1 || state[0]?.singleton !== 1 || ![1, 2, 3, 4].includes(Number(state[0]?.schema_version))
    || Number(state[0]?.schema_version) !== matchedVersion
    || !Number.isSafeInteger(state[0]?.revision) || Number(state[0]?.revision) < 0) throw new CollectionsError('METADATA_UNAVAILABLE');
  return false;
}

function schemaObjects(db: DatabaseSync): unknown[] {
  return db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name").all()
    .map((row) => ({ ...row, sql: typeof row.sql === 'string' ? row.sql.trim().replace(/\s+/gu, ' ') : row.sql }));
}

export const COLLECTIONS_STATE_V2_DDL = `CREATE TABLE collections_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1), schema_version INTEGER NOT NULL CHECK (schema_version = 2),
    revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision BETWEEN 0 AND 9007199254740991)
  );`;
export const COLLECTIONS_RECEIPT_DDL = `CREATE TABLE collections_mutation_receipt (
    request_id TEXT PRIMARY KEY NOT NULL,
    command_hash TEXT NOT NULL CHECK (length(command_hash) = 64),
    operation TEXT NOT NULL CHECK (operation IN ('createCollection', 'renameCollection', 'deleteCollection', 'addEntry', 'removeEntry')),
    previous_revision INTEGER NOT NULL CHECK (typeof(previous_revision) = 'integer' AND previous_revision BETWEEN 0 AND 9007199254740991),
    metadata_revision INTEGER NOT NULL CHECK (typeof(metadata_revision) = 'integer' AND metadata_revision BETWEEN 0 AND 9007199254740991),
    changed INTEGER NOT NULL CHECK (changed IN (0, 1)),
    result_json TEXT NOT NULL CHECK (length(result_json) BETWEEN 2 AND 32768)
  );`;

export const COLLECTIONS_SCHEMA_V2 = `BEGIN IMMEDIATE;
  ${COLLECTIONS_STATE_V2_DDL}
  INSERT INTO collections_state VALUES (1, 2, 0);
  CREATE TABLE user_collection (
    collection_id TEXT PRIMARY KEY NOT NULL, display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120)
  );
  CREATE INDEX user_collection_name ON user_collection(display_name COLLATE BINARY, collection_id);
  CREATE TABLE collection_entry (
    entry_id TEXT PRIMARY KEY NOT NULL, provider_id TEXT NOT NULL, source_id TEXT NOT NULL, native_id TEXT NOT NULL,
    reference_kind TEXT NOT NULL CHECK (reference_kind IN ('session', 'source')),
    UNIQUE (provider_id, source_id, native_id, reference_kind)
  );
  CREATE TABLE collection_membership (
    collection_id TEXT NOT NULL REFERENCES user_collection(collection_id) ON DELETE CASCADE,
    entry_id TEXT NOT NULL REFERENCES collection_entry(entry_id) ON DELETE CASCADE, PRIMARY KEY (collection_id, entry_id)
  );
  CREATE INDEX collection_membership_entry ON collection_membership(entry_id, collection_id);
  ${COLLECTIONS_RECEIPT_DDL}
  COMMIT;`;

export const COLLECTIONS_STATE_V3_DDL = COLLECTIONS_STATE_V2_DDL.replace('schema_version = 2', 'schema_version = 3');
export const COLLECTIONS_RECEIPT_V3_DDL = COLLECTIONS_RECEIPT_DDL.replace("'removeEntry'", "'removeEntry', 'setAlias', 'setLocalArchive', 'rebindEntry'");
export const COLLECTIONS_ENTRY_V3_DDL = `CREATE TABLE collection_entry (
    entry_id TEXT PRIMARY KEY NOT NULL, provider_id TEXT NOT NULL, source_id TEXT NOT NULL, native_id TEXT NOT NULL,
    reference_kind TEXT NOT NULL CHECK (reference_kind IN ('session', 'file', 'source')),
    display_alias TEXT CHECK (display_alias IS NULL OR length(display_alias) BETWEEN 1 AND 120),
    local_archived_at_ms INTEGER CHECK (local_archived_at_ms IS NULL OR (typeof(local_archived_at_ms) = 'integer' AND local_archived_at_ms BETWEEN 0 AND 9007199254740991 AND reference_kind = 'session')),
    UNIQUE (provider_id, source_id, native_id, reference_kind)
  );`;
export const COLLECTIONS_MEMBERSHIP_DDL = `CREATE TABLE collection_membership (
    collection_id TEXT NOT NULL REFERENCES user_collection(collection_id) ON DELETE CASCADE,
    entry_id TEXT NOT NULL REFERENCES collection_entry(entry_id) ON DELETE CASCADE, PRIMARY KEY (collection_id, entry_id)
  );
  CREATE INDEX collection_membership_entry ON collection_membership(entry_id, collection_id);`;
export const COLLECTIONS_SCHEMA_V3 = COLLECTIONS_SCHEMA_V2
  .replace(COLLECTIONS_STATE_V2_DDL, COLLECTIONS_STATE_V3_DDL)
  .replace('VALUES (1, 2, 0)', 'VALUES (1, 3, 0)')
  .replace(/CREATE TABLE collection_entry \([\s\S]*?\n  \);/u, COLLECTIONS_ENTRY_V3_DDL)
  .replace(COLLECTIONS_RECEIPT_DDL, COLLECTIONS_RECEIPT_V3_DDL);

export const COLLECTIONS_STATE_V4_DDL = COLLECTIONS_STATE_V2_DDL.replace('schema_version = 2', 'schema_version = 4');
export const COLLECTIONS_PENDING_DDL = `CREATE TABLE collections_pending_command (
    request_id TEXT PRIMARY KEY NOT NULL,
    command_hash TEXT NOT NULL CHECK (length(command_hash) = 64),
    command_json TEXT NOT NULL CHECK (length(command_json) BETWEEN 2 AND 32768)
  );`;
export const COLLECTIONS_SCHEMA = COLLECTIONS_SCHEMA_V3
  .replace(COLLECTIONS_STATE_V3_DDL, COLLECTIONS_STATE_V4_DDL)
  .replace('VALUES (1, 3, 0)', 'VALUES (1, 4, 0)')
  .replace('  COMMIT;', `  ${COLLECTIONS_PENDING_DDL}\n  COMMIT;`);

/** The only pre-receipt schema accepted for the additive v1 -> v2 upgrade. */
export const COLLECTIONS_SCHEMA_V1 = `BEGIN IMMEDIATE;
  CREATE TABLE collections_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1), schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision BETWEEN 0 AND 9007199254740991)
  );
  INSERT INTO collections_state VALUES (1, 1, 0);
  CREATE TABLE user_collection (
    collection_id TEXT PRIMARY KEY NOT NULL, display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120)
  );
  CREATE INDEX user_collection_name ON user_collection(display_name COLLATE BINARY, collection_id);
  CREATE TABLE collection_entry (
    entry_id TEXT PRIMARY KEY NOT NULL, provider_id TEXT NOT NULL, source_id TEXT NOT NULL, native_id TEXT NOT NULL,
    reference_kind TEXT NOT NULL CHECK (reference_kind IN ('session', 'source')),
    UNIQUE (provider_id, source_id, native_id, reference_kind)
  );
  CREATE TABLE collection_membership (
    collection_id TEXT NOT NULL REFERENCES user_collection(collection_id) ON DELETE CASCADE,
    entry_id TEXT NOT NULL REFERENCES collection_entry(entry_id) ON DELETE CASCADE, PRIMARY KEY (collection_id, entry_id)
  );
  CREATE INDEX collection_membership_entry ON collection_membership(entry_id, collection_id);
  COMMIT;`;

function referenceV1(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(COLLECTIONS_SCHEMA_V1);
  return db;
}

/** Exact DDL emitted by the former ALTER/RENAME migration, never a general SQL normalizer. */
function referenceMigratedV2(): DatabaseSync {
  const db = referenceV1();
  db.exec('DROP TABLE collections_state');
  db.exec(COLLECTIONS_STATE_V2_DDL.replace('CREATE TABLE collections_state', 'CREATE TABLE "collections_state"').replace(/\s+\);$/u, ');'));
  db.exec('INSERT INTO collections_state VALUES (1, 2, 0)');
  db.exec(COLLECTIONS_RECEIPT_DDL.replace(/\s+\);$/u, ');'));
  return db;
}
