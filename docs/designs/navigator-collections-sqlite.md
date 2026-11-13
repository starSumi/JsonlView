---
id: "navigator-collections-sqlite"
path: "docs/designs/navigator-collections-sqlite.md"
title: "Navigator Collections SQLite DDL and WAL"
kind: "design"
status: "proposed"
owner: "product"
tags: ["collections", "sqlite", "transactions", "persistence"]
evidence: ["product-revision:14f7bfcd75edf25232c932da0dddf58a3682896f", "https://nodejs.org/docs/latest-v24.x/api/sqlite.html"]
revisit: "before implementation and when provider identity or persistence contracts change"
rollback: "withdraw the proposal and retain the source-preserving metadata boundary"
x-priority: "P1"
x-freshness: "current"
x-review-cadence: "before implementation and at each contract change"
x-last-reviewed: "2026-11-01"
---
## Current implementation boundary (2026-11-06)

The SQL proposal below is retained, not an executed schema or migration.
Current executable DDL is src/infrastructure/navigator/collections-schema.ts:
a separate owned database with collections_state, user_collection,
collection_entry, collection_membership, collections_mutation_receipt and
collections_pending_command. Schema v4 adds the shared accepted-command journal;
v3 stores aliases and session-local archive intent. Migration accepts only
verified owned legacy DDL after retaining an online backup. It has no
source-catalog attachment, authorization/scan state, paths, source titles or
source bytes. WAL/FK/synchronous FULL readback,
revision checks and fixed failures are enforced; lists use bounded continuation
pages. Local archive/receipts follow
[ADR-073](../decisions/073-collections-entry-metadata.md); lower anti-joins remain
superseded by [ADR-064](../decisions/064-independent-collections-board.md).
The implemented journal, migration and conflict limits follow
[ADR-074](../decisions/074-collections-shared-journal.md). The pending table has
request_id TEXT PRIMARY KEY, a 64-character command_hash, and bounded original
command_json. At most 64 pending commands are accepted inside the SQLite writer
transaction; acceptance commits separately from effect/receipt and cleanup.
No command journal writes use VS Code Memento. Existing visible legacy keys
remain unchanged after an atomic read-only import or matching-receipt skip.

## 1. SQLite reference DDL

This is the full proposed durable schema, **not an executed migration**. It
contains no foreign keys to catalog `sources`, `entities`, `source_registry`,
locations, checkpoints, or provider databases. Foreign-key cascades are confined
to the owned aggregate. Enable and verify foreign keys on each connection;
prepared statements bind all values. The existing `node:sqlite` contract
supports this owner and a disposable probe without additional dependencies.
[Node 24 SQLite documentation](https://nodejs.org/docs/latest-v24.x/api/sqlite.html).

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE collection_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  metadata_revision INTEGER NOT NULL
    CHECK (typeof(metadata_revision) = 'integer' AND metadata_revision BETWEEN 0 AND 9007199254740991)
);
INSERT INTO collection_state VALUES (1, 1, 0);

CREATE TABLE collection (
  collection_id TEXT PRIMARY KEY NOT NULL CHECK (length(collection_id) = 36),
  display_name TEXT NOT NULL
    CHECK (length(trim(display_name)) BETWEEN 1 AND 120),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  row_revision INTEGER NOT NULL CHECK (row_revision > 0)
);
CREATE INDEX collection_name
  ON collection(display_name COLLATE BINARY, collection_id);

CREATE TABLE collection_source_ref (
  source_ref_id TEXT PRIMARY KEY NOT NULL CHECK (length(source_ref_id) = 36),
  provider_id TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 80),
  source_id TEXT NOT NULL CHECK (length(source_id) BETWEEN 1 AND 256),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (provider_id, source_id),
  UNIQUE (source_ref_id, provider_id)
);

CREATE TABLE collection_entry (
  entry_id TEXT PRIMARY KEY NOT NULL CHECK (length(entry_id) = 36),
  display_alias TEXT
    CHECK (display_alias IS NULL OR length(trim(display_alias)) BETWEEN 1 AND 240),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  row_revision INTEGER NOT NULL CHECK (row_revision > 0)
);

CREATE TABLE collection_entry_ref (
  entry_id TEXT PRIMARY KEY NOT NULL REFERENCES collection_entry(entry_id)
    ON DELETE CASCADE,
  source_ref_id TEXT NOT NULL,
  provider_id TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 80),
  reference_kind TEXT NOT NULL
    CHECK (reference_kind IN ('session', 'file', 'source')),
  native_id TEXT NOT NULL CHECK (length(native_id) BETWEEN 1 AND 4096),
  identity_quality TEXT NOT NULL
    CHECK (identity_quality IN ('provider-stable', 'location-bound')),
  row_revision INTEGER NOT NULL CHECK (row_revision > 0),
  FOREIGN KEY (source_ref_id, provider_id)
    REFERENCES collection_source_ref(source_ref_id, provider_id)
    ON DELETE RESTRICT,
  CHECK ((reference_kind = 'file' AND native_id = '@file') OR
         (reference_kind = 'source' AND native_id = '@source') OR
         reference_kind = 'session'),
  UNIQUE (source_ref_id, reference_kind, native_id)
);

CREATE TABLE collection_local_archive_intent (
  entry_id TEXT PRIMARY KEY NOT NULL REFERENCES collection_entry_ref(entry_id)
    ON DELETE CASCADE,
  archived_at_ms INTEGER NOT NULL CHECK (archived_at_ms >= 0),
  row_revision INTEGER NOT NULL CHECK (row_revision > 0)
);
CREATE INDEX collection_local_archive_intent_page
  ON collection_local_archive_intent(archived_at_ms DESC, entry_id ASC);

CREATE TABLE collection_membership (
  collection_id TEXT NOT NULL REFERENCES collection(collection_id)
    ON DELETE CASCADE,
  entry_id TEXT NOT NULL REFERENCES collection_entry_ref(entry_id)
    ON DELETE CASCADE,
  linked_at_ms INTEGER NOT NULL CHECK (linked_at_ms >= 0),
  row_revision INTEGER NOT NULL CHECK (row_revision > 0),
  PRIMARY KEY (collection_id, entry_id)
);
CREATE INDEX collection_membership_entry
  ON collection_membership(entry_id, collection_id);
CREATE INDEX collection_membership_page
  ON collection_membership(collection_id, linked_at_ms DESC, entry_id ASC);

CREATE TABLE collection_mutation_receipt (
  request_id TEXT PRIMARY KEY NOT NULL CHECK (length(request_id) = 36),
  operation TEXT NOT NULL CHECK (operation IN
    ('create', 'update', 'delete', 'alias', 'link', 'unlink', 'move', 'rebind',
     'local-archive', 'reset-entry')),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  committed_revision INTEGER NOT NULL CHECK (committed_revision >= 0),
  result_json TEXT NOT NULL CHECK (length(result_json) BETWEEN 2 AND 8192),
  committed_at_ms INTEGER NOT NULL CHECK (committed_at_ms >= 0)
);
```

Infrastructure additionally validates canonical UUID syntax, canonical source
identity, UTF-8 byte bounds, control characters, and fixed-schema receipt JSON;
SQLite length checks are defense in depth, not the transport validator. Trim
outer Unicode whitespace; preserve case/interior spacing. Maximum serialized
request is 16 KiB; display-name/alias byte limits are 512/1024 respectively.
Receipts contain opaque result IDs, fixed operation/outcome codes and revisions,
never source paths, prompt/content, raw requests, or source-derived titles.
The composite provider/source foreign key binds each reference to its exact
registered source; the unique source-ref/kind/native key enforces v1 identity
within that source. The same native ID in another source is a distinct
reference. Do not add an authority-key column/index or merge across roots in v1.
Any imported/corrupt duplicate of one source-qualified identity is
`IDENTITY_CONFLICT`; retain all metadata, do not pick an alias or drop links
automatically, and keep the affected scope pending until explicit repair. No
migration/import is executed here.

Collection/entry/ref/local-archive-intent row revisions are the global revision of
their last effective change. Provider-observed archive state is read from the
current authorized catalog and deliberately has no duplicate metadata row.
Revision exhaustion returns `METADATA_UNAVAILABLE` before any change; v1 caps
revisions at JavaScript's maximum safe integer even though IPC uses decimal
strings. Store methods additionally enforce that local archive intents reference
sessions; rebind cannot change an intent-bearing entry to another reference kind.
Clock values are host monotonic-within-process display times clamped to their
existing row's timestamp; clocks do not decide concurrency.
Reference source rows and orphan entries may remain after last unlink so aliases
and identity deduplication survive refile. They do not hide lower entries.
Metadata garbage collection and receipt compaction are queued lifecycle work;
catalog reset is never an implicit metadata cleanup.
## 4. SQLite WAL transaction reference (implementation guidance)

This is a bounded implementation reference, not runtime code. The future
TypeScript store uses the existing `node:sqlite` owner and one metadata
connection per store. On open it enables foreign keys and requests WAL; it must
read back the journal mode and fail closed if the runtime cannot honor the
expected mode. A writer uses `BEGIN IMMEDIATE`, validates the singleton
revision, mutates only the owned tables, inserts the idempotency receipt, and
commits. Readers use short read transactions and never hold a snapshot across
IPC or provider I/O. A busy writer returns `STORE_BUSY`; it does not drop a
link or retry with a new request ID. This follows SQLite's one-writer/WAL
snapshot boundaries and foreign-key enforcement; it does not make provider
filesystem moves atomic.

[SQLite WAL](https://www.sqlite.org/wal.html) and
[SQLite snapshot isolation](https://www.sqlite.org/isolation.html) and
[SQLite foreign-key constraints](https://www.sqlite.org/foreignkeys.html) are
the normative references. The existing Node owner is documented at
[Node 24 `node:sqlite`](https://nodejs.org/docs/latest-v24.x/api/sqlite.html).

The write sequence is: `PRAGMA foreign_keys=ON`; `PRAGMA journal_mode=WAL`;
a bounded Node connection `timeout`; begin immediate; receipt lookup; revision CAS; row
changes; global revision update; receipt insert; commit; close read snapshot;
publish the one committed invalidation. No catalog/provider database is
attached to this write transaction. The lower projection may attach a
host-resolved metadata read snapshot only for a short query, and must close it
before any open/reveal effect.

The following TypeScript is a method reference over already validated inputs;
it is not copied into product runtime. `mutate` is synchronous, bounded, and
performs no provider/catalog I/O. Production error mapping converts every thrown
SQLite error to the fixed codes below; an uncertain commit is recovered by the
same request receipt, not by claiming rollback. Values and identifiers from
requests are never interpolated into SQL.

```ts
import { DatabaseSync } from 'node:sqlite';

export interface ITransactionChange<T> {
  changed: boolean;
  value: T;
  invalidation: 'metadata' | 'none';
}

function openMetadata(metadataPath: string): DatabaseSync {
  // metadataPath is host-owned profile storage, never request input.
  const db = new DatabaseSync(metadataPath, {
    timeout: 250,
    enableForeignKeyConstraints: true
  });
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA journal_mode = WAL');
  if (db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1 ||
      db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'wal') {
    db.close();
    throw new Error('METADATA_UNAVAILABLE');
  }
  return db;
}

function findEntryForVerifiedTarget(
  db: DatabaseSync, identity: IQualifiedReferenceIdentity
): string | null {
  // Only a fresh source-owner/authorization guard may supply identity.
  const row = db.prepare(
    'SELECT r.entry_id FROM collection_entry_ref r JOIN collection_source_ref s ON s.source_ref_id = r.source_ref_id AND s.provider_id = r.provider_id WHERE s.provider_id = ? AND s.source_id = ? AND r.reference_kind = ? AND r.native_id = ?'
  ).get(identity.providerId, identity.sourceId, identity.referenceKind, identity.nativeId);
  return row ? String(row.entry_id) : null;
}

function writeMetadata<T>(
  db: DatabaseSync, request: IMutationContext, operation: string,
  canonicalRequestHash: string, guard: IStoreEffectGuard,
  mutate: (nextRevision: number) => ITransactionChange<T>
): ICollectionMutationResult<T> {
  // The host also checks the receipt before resolving a fresh target.
  db.exec('BEGIN IMMEDIATE');
  let open = true;
  try {
    const receipt = db.prepare(
      'SELECT request_hash, result_json FROM collection_mutation_receipt WHERE request_id = ?'
    ).get(request.requestId);
    if (receipt) {
      if (receipt.request_hash !== canonicalRequestHash)
        throw new Error('IDEMPOTENCY_CONFLICT');
      // Validate against the fixed result schema, then redact at the port.
      const result = JSON.parse(String(receipt.result_json)) as ICollectionMutationResult<T>;
      db.exec('COMMIT'); open = false;
      return { ...result, replayed: true };
    }
    guard.assertCurrentAndNotCancelled();
    const current = String(db.prepare(
      'SELECT CAST(metadata_revision AS TEXT) AS v FROM collection_state WHERE singleton = 1'
    ).get()?.v);
    if (!/^(0|[1-9][0-9]*)$/.test(current))
      throw new Error('METADATA_UNAVAILABLE');
    if (current !== request.expectedRevision) throw new Error('REVISION_CONFLICT');
    if (Number(current) >= Number.MAX_SAFE_INTEGER)
      throw new Error('METADATA_UNAVAILABLE');
    const next = Number(current) + 1;
    const change = mutate(next);
    guard.assertCurrentAndNotCancelled();
    const revision = change.changed ? String(next) : current;
    if (change.changed) {
      const cas = db.prepare(
        'UPDATE collection_state SET metadata_revision = ? WHERE singleton = 1 AND metadata_revision = ?'
      ).run(next, Number(current));
      if (cas.changes !== 1) throw new Error('REVISION_CONFLICT');
    }
    const result: ICollectionMutationResult<T> = {
      ...change, metadataRevision: revision, replayed: false
    };
    const json = JSON.stringify(result);
    if (Buffer.byteLength(json, 'utf8') > 8192)
      throw new Error('INVALID_ARGUMENT');
    db.prepare(
      'INSERT INTO collection_mutation_receipt VALUES (?, ?, ?, ?, ?, ?)'
    ).run(request.requestId, operation, canonicalRequestHash,
          Number(revision), json, Date.now());
    db.exec('COMMIT'); open = false;
    // Only the caller publishes invalidation, after this function returns.
    return result;
  } catch (error) {
    if (open) { try { db.exec('ROLLBACK'); } catch { /* receipt recovery */ } }
    throw error; // infrastructure maps to a fixed code; never serialize error
  }
}

function moveRows(
  db: DatabaseSync, r: IMoveEntryRequest, nextRevision: number, now: number
): ITransactionChange<IMoveEntryResult> {
  for (const id of [r.fromCollectionId, r.toCollectionId]) {
    if (!db.prepare('SELECT 1 FROM collection WHERE collection_id = ?').get(id))
      throw new Error('NOT_FOUND');
  }
  if (!db.prepare(
    'SELECT 1 FROM collection_membership WHERE collection_id = ? AND entry_id = ?'
  ).get(r.fromCollectionId, r.entryId)) throw new Error('MEMBERSHIP_NOT_FOUND');
  const changed = r.fromCollectionId !== r.toCollectionId;
  if (changed) {
    db.prepare(
      'INSERT INTO collection_membership VALUES (?, ?, ?, ?) ON CONFLICT(collection_id, entry_id) DO NOTHING'
    ).run(r.toCollectionId, r.entryId, now, nextRevision);
    db.prepare(
      'DELETE FROM collection_membership WHERE collection_id = ? AND entry_id = ?'
    ).run(r.fromCollectionId, r.entryId);
  }
  const count = String(db.prepare(
    'SELECT CAST(count(*) AS TEXT) AS n FROM collection_membership WHERE entry_id = ?'
  ).get(r.entryId)?.n);
  return {
    changed,
    value: { entryId: r.entryId, fromCollectionId: r.fromCollectionId,
      toCollectionId: r.toCollectionId, remainingMembershipCount: count },
    invalidation: changed ? 'metadata' : 'none'
  };
}

function resetRows(
  db: DatabaseSync, r: IResetEntryMetadataRequest, nextRevision: number, now: number
): ITransactionChange<IResetEntryMetadataResult> {
  if (!r.clearAlias && !r.clearMemberships && !r.clearLocalArchiveIntent)
    throw new Error('INVALID_ARGUMENT');
  if (!db.prepare('SELECT 1 FROM collection_entry WHERE entry_id = ?').get(r.entryId))
    throw new Error('NOT_FOUND');
  let writes = 0;
  if (r.clearAlias) writes += Number(db.prepare(
    'UPDATE collection_entry SET display_alias = NULL, updated_at_ms = max(updated_at_ms, ?), row_revision = ? WHERE entry_id = ? AND display_alias IS NOT NULL'
  ).run(now, nextRevision, r.entryId).changes);
  if (r.clearMemberships) writes += Number(db.prepare(
    'DELETE FROM collection_membership WHERE entry_id = ?'
  ).run(r.entryId).changes);
  if (r.clearLocalArchiveIntent) writes += Number(db.prepare(
    'DELETE FROM collection_local_archive_intent WHERE entry_id = ?'
  ).run(r.entryId).changes);
  const localIntent = !!db.prepare(
    'SELECT 1 FROM collection_local_archive_intent WHERE entry_id = ?'
  ).get(r.entryId);
  const count = String(db.prepare(
    'SELECT CAST(count(*) AS TEXT) AS n FROM collection_membership WHERE entry_id = ?'
  ).get(r.entryId)?.n);
  return {
    changed: writes > 0,
    value: { entryId: r.entryId, remainingMembershipCount: count,
      localIntent, providerMutation: 'none' },
    invalidation: writes > 0 ? 'metadata' : 'none'
  };
}
```

For `setLocalArchiveIntent(true)`, the same wrapper first verifies the resolved
reference kind is `session`, ensures the unique entry/ref, then executes
`INSERT ... ON CONFLICT(entry_id) DO NOTHING` for the intent. False executes
only `DELETE ... WHERE entry_id = ?`; neither branch touches membership or any
provider database. Repeated values are no-ops. `fileInto` uses the unique
source-qualified identity `(providerId, sourceId, nativeId)` and
composite membership key, with no replacement/cascade
of an existing entry. `deleteCollection` executes one bound DELETE and lets
owned membership FKs cascade; entries, local archive intents, aliases and sources
survive. Rebind updates the one ref in this wrapper after collision/kind checks;
all uniqueness failures roll back. The methods must use this same wrapper for
receipt, revision and commit behavior.
Resolve/create runs under `BEGIN IMMEDIATE`: lookup the exact
`(providerId, sourceId, nativeId)` before inserting, and reuse the winner on a
uniqueness race after rechecking that source's authorization/currentness. A
different source registration remains a distinct entry even when provider and
native IDs match. Alias, membership, and local archive changes stay attached to
that exact entry. Existing catalog `product_title` values remain source-local
fallback display data; no overlay is copied to another source.

Rebind uses an in-place `UPDATE collection_entry_ref ... WHERE entry_id = ?`.
It must not DELETE then INSERT the ref: membership/local-intent foreign keys
would cascade. Verify the target before the transaction and recheck collision,
kind and currentness inside it, stamping the ref with the single new revision.
Update `source_ref_id`, `provider_id`, and `native_id` consistently in that
statement. Rebinding to another source is explicit even when the native ID is
unchanged; if another entry already owns the exact destination tuple, return
`TARGET_ALREADY_REFERENCED`. Never merge entries or treat the same thread ID in
another source as an automatic fallback.

### Transaction, retry, and publication protocol

For each mutation the existing infrastructure owner performs one bounded
transaction in **only the durable metadata database**:

1. Decode/bound the request, check metadata capability and lifecycle, and hash
   operation, normalized args (including the literal opaque target token, if
   any) and expected revision, excluding transport lifecycle/correlation data.
   Check for a committed receipt **before** resolving a target. A matching
   replay returns only its fixed metadata result after current redaction;
   differing payload with the same ID fails `IDEMPOTENCY_CONFLICT`.
2. If no receipt exists, resolve any target under current authorization outside
   the write transaction. `BEGIN IMMEDIATE`; check the receipt again to settle
   a concurrent same-ID winner, and recheck token/currentness and cancellation
   at this serialized effect boundary. No source I/O occurs while holding the
   transaction; callers cannot select an arbitrary source path.
3. Require current global revision to equal `expectedRevision`; otherwise
   `ROLLBACK` and `REVISION_CONFLICT`. A committed replay survives restart
   because its original request hashes identically even when the token can no
   longer authorize a new effect. An unknown/expired token with no receipt
   returns `TARGET_STALE`, requiring a new authorized target and request.
4. Apply the complete change, including entry/ref creation and all links. A
   changed operation advances global revision exactly once and stamps changed
   rows. A semantic no-op retains the current revision. Insert a fixed-schema
   successful receipt, then `COMMIT`. Constraint/lock/cancellation before commit
   rolls back rows, revision and receipt together.
5. After commit, publish one bounded metadata-scope invalidation containing
   the committed revision. Refresh upper collections and lower Sessions against
   that revision. Do not optimistically hide/show from an uncommitted command.
   Stage both readbacks before publishing their shared revision; discard older
   readbacks. Native TreeView and Webview have no shared frame-paint transaction:
   retain the prior visible row until its destination adapter acknowledges the
   new revision, so transfer cannot create a blank gap. A brief prior-row
   refresh state is permitted. If refresh fails, retain the last coherent
   display with a refresh-required state, rather than fabricate a successful
   new view. Runtime adapter acceptance must verify this handoff separately.

Receipts survive for this database's lifetime in v1; no TTL silently turns a
retry into a second create. A client retry after uncertain delivery reuses the
same request ID and canonical command, including its original opaque target
token. After restart the host first checks a receipt using request ID/hash,
and requires a new authorized selection if no receipt exists. A replay
returns its original committed revision, not permission to paint stale data;
the adapter then reads at the current revision. Uncommitted errors are not
success receipts. A new intended mutation after conflict uses a new request
ID and freshly read revision; never overwrite another user's/client's edit.

`STORE_BUSY` is retryable with bounded backoff and the same request ID. Other
fixed errors are `INVALID_ARGUMENT`, `NOT_FOUND`, `REVISION_CONFLICT`,
`IDEMPOTENCY_CONFLICT`, `MEMBERSHIP_NOT_FOUND`, `AUTHORIZATION_REQUIRED`,
`TARGET_STALE`, `TARGET_ALREADY_REFERENCED`, `IDENTITY_CONFLICT`,
`TEMPORARY_SOURCE`, `CURSOR_INVALID`, `CURSOR_EXPIRED`, `SNAPSHOT_CHANGED`,
`CANCELLED`, `METADATA_UNAVAILABLE` and `UNSUPPORTED_CAPABILITY`. Validation,
authorization, identity and unsupported errors require corrected input or an
explicit recovery action; do not automatically retry them. `NOT_FOUND` reveals
only the supplied opaque metadata ID. Runtime implementations must map SQLite
errors to these codes without raw SQL, source paths or provider data.

Cancellation before commit returns `CANCELLED` with unchanged metadata. Once
commit succeeds, cancellation cannot be reported as rollback; settle with the
committed receipt, or recover it after reconnect. An atomic Move never exposes
a persistent state with both the source link removed and no destination link.
Cross-database atomic writes are unnecessary: collection mutations do not write
the catalog or any source. Provider rescans may continue independently.

### Bounded queries and coherent pagination

The current catalog query infrastructure must apply the membership/local-intent
predicates and provider-observed archive filter before `ORDER BY`/keyset/`LIMIT`,
using the durable metadata read snapshot. It may attach the host-resolved
metadata database for this read; no path or SQL comes from IPC. Do not copy all
memberships into the Webview or filter only a fetched page. Catalog writes and
metadata writes retain their existing owners; a page's metadata snapshot is
revalidated against the current committed revision before delivery. A shared
host publication coordinator compares authorization, catalog generation,
provider-status epoch, and metadata revision; it is not a second database
engine.

The following executable reference shows one authorized source/parent scope
using current catalog column names. It intentionally fixes one existing
activity sort; production retains every existing selected sort/collation. The
host supplies source/generation/parent after effective authorization. Codex
archive status is a **per-entity** expression, not a page-level flag; unsupported
providers contribute false. A stale/unknown supported status is excluded from
active pages and reported as pending coverage, never inferred active. No
host-per-row filtering occurs after LIMIT.

The connection's host-owned TEMP table `trusted_authorized_source_scope` contains
only sources authorized for this read, with one row per exact `source_id` and
its current `provider_id` and `generation`. The table contains no roots,
authority hashes, or request-supplied identity and is discarded with the read.
Authorization and catalog-generation epochs are rechecked before delivery.
Truncated/partial discovery alone does not prove an absent row active or missing;
unobserved references remain pending under the existing coverage rules. A stale
or unknown supported status is excluded from active pages and reported as
pending coverage; it is never inferred active. A proven local archive intent
still suffices for Archived while native status is pending.

```sql
WITH candidates AS (
  SELECT e.source_id, e.native_id,
         COALESCE(ce.display_alias, el.product_title, e.label) AS display_name,
         COALESCE(e.activity_at, '') AS sort_activity,
         CASE WHEN s.provider = 'codex' THEN
                CASE WHEN e.status = 'archived' THEN 1
                     WHEN e.status = 'available' THEN 0
                     ELSE NULL END
              ELSE 0 END AS provider_archived,
         EXISTS (SELECT 1 FROM collection_metadata.collection_local_archive_intent a
                 WHERE a.entry_id = r.entry_id) AS local_archived,
         EXISTS (SELECT 1 FROM collection_metadata.collection_membership m
                 WHERE m.entry_id = r.entry_id) AS has_membership
  FROM temp.trusted_authorized_source_scope auth
  JOIN entities e ON e.source_id = auth.source_id AND e.generation = auth.generation
  JOIN sources s ON s.source_id = e.source_id AND s.provider = auth.provider_id
  LEFT JOIN collection_metadata.collection_source_ref sr
    ON sr.provider_id = s.provider AND sr.source_id = e.source_id
  LEFT JOIN collection_metadata.collection_entry_ref r
    ON r.source_ref_id = sr.source_ref_id AND r.provider_id = s.provider
   AND r.reference_kind = 'session' AND r.native_id = e.native_id
  LEFT JOIN collection_metadata.collection_entry ce ON ce.entry_id = r.entry_id
  LEFT JOIN entity_labels el
    ON el.source_id = e.source_id AND el.native_id = e.native_id
WHERE e.kind IN ('session', 'thread', 'subagent')
    AND (e.parent_native_id = :parent_id OR
         (e.parent_native_id IS NULL AND :parent_id IS NULL))
), filtered AS (
  SELECT * FROM candidates
  WHERE instr(lower(display_name), :normalized_search) > 0
    AND (
      (:projection = 'unfiled' AND provider_archived = 0
       AND local_archived = 0 AND has_membership = 0)
      OR (:projection = 'all-active' AND provider_archived = 0
          AND local_archived = 0)
      OR (:projection = 'archived' AND
          (provider_archived = 1 OR local_archived = 1))
    )
)
SELECT source_id, native_id, display_name, sort_activity
FROM filtered
WHERE :after_activity IS NULL OR sort_activity < :after_activity
   OR (sort_activity = :after_activity AND source_id > :after_source_id)
   OR (sort_activity = :after_activity AND source_id = :after_source_id
       AND native_id > :after_native_id)
ORDER BY sort_activity DESC, source_id ASC, native_id ASC
LIMIT :limit;
```

The same `filtered` CTE with `SELECT count(*) FROM filtered` gives the scoped
count **before keyset/limit**. Count and page must pass the same revision/epoch
validation; empty-page results still return that count. Each row remains scoped
to its exact authorized source. Whole-file references use the corresponding
exact-file candidate mapping and reserved `@file`.
Source/root references use `@source` and never match session IDs by prefix,
ancestry, or folder expansion. Product providers expose `subagent` entities
with parent identity, so the projection keeps them in the bounded child scope.
When a parent is filed or archived, its collection row must preserve the parent
identity needed to query its children; unfiled descendants remain reachable
there and are filtered by their own membership/archive state. Filing a parent
does not implicitly file its descendants.
The Archived predicate is the explicit parenthesized OR, not an inversion of
membership: native-only archived rows and locally archived rows are both
included, and all memberships remain available for display/recovery. A bounded
multi-source composition applies these predicates within the query owner before
its global keyset/count; it cannot union already paged unfiltered rows. Rows
from different source IDs remain distinct even when provider and native IDs
match. Authorization, native archive observation, membership, and local archive
intent are resolved independently for each exact source-qualified identity.

Collection pages sort `(display_name COLLATE BINARY ASC, collection_id ASC)`.
Collection entries sort `(linked_at_ms DESC, entry_id ASC)`; their keyset after
`(t,id)` is `linked_at_ms < t OR (linked_at_ms = t AND entry_id > id)`.
The filed union uses each entry's maximum link timestamp and the same tie-break.
Keep lower's existing selected sort and SQLite collation, with its existing
native-ID tie-break; add filing state/revision without substituting JavaScript
title comparison. Search/authorization/filing predicates run before keyset and
limit. A count uses exactly that filtered scope before limit, so page length
and unfiled count agree. Unknown provider coverage yields a known count plus
`exact:false`, never a fabricated global total.

Lists return 1–100 items (default 50). A host-issued opaque cursor is at most
4096 bytes, expires after five minutes or host restart, and binds contract
version, lifecycle epoch, metadata revision, authorization epoch, participating
source/generation set and catalog epoch, scope/parent, sort/collation,
normalized-search digest, and the final stable key tuple
`(activity, sourceId, nativeId)`. The host validates the complete binding on
every page. Representation can reuse existing continuation ownership; this
does not require a cursor service or expose raw locations in a token.
The catalog epoch includes each participating source generation. The stable
multi-source tie-break uses the exact source ID and native ID; a single-source
scope may retain its existing native-ID tie-break. No authority key or state
home path is a query or cursor identity.

Malformed or mismatched cursor structure returns `CURSOR_INVALID`; elapsed
lifetime returns `CURSOR_EXPIRED`; a changed metadata/auth/catalog snapshot
returns `SNAPSHOT_CHANGED`. Return no partial page in these cases. Restart the
same scope at the current revision rather than splice old/new pages. Any late
list result whose revision/epoch differs from the current view is discarded,
including a pre-delete list arriving after a rename/move/delete commit.
No offset pagination or silently reused stale count is permitted.
