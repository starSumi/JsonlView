# ADR-050: Navigator Catalog Metadata Plane

Status: experimental

## Pressure

The opt-in Session Navigator needs durable source metadata and bounded scan
checkpoints, while the JSONL file remains the only content authority. The
existing catalog tables predate that split and cannot describe an authorized
exact personal file separately from an entity scan.

## Invariant

SQLite is a rebuildable projection. A source registry row contains only
authorization and file metadata; entity rows and checkpoints describe a
separate, explicitly enabled scan. No source record body is stored in the
catalog, and a disabled Navigator never triggers an entity scan.

## Owner

`src/application/catalog/` owns the database-free model and port. The
compatibility adapter remains in `src/experimental/session-navigator/` until
the source lifecycle and protocol lanes promote the boundary. A future SQLite
adapter belongs under `src/infrastructure/navigator/`.

## Alternatives

- Replace the existing `sources`/`entities` tables in one migration: rejected
  because the current tree provider and continuation tests require their
  generation semantics.
- Create a second database: rejected because it would split source identity and
  complicate recovery.
- Cache JSONL bodies in SQLite: rejected because it creates stale content and a
  privacy boundary the product does not need.

## Probe

Open a new and a legacy catalog, reconcile an exact `.jsonl` source while the
Navigator is disabled, reopen the database, and verify metadata/checkpoint
readback without the source body. Then run the existing generation, paging,
stale-cursor, cancellation and lifecycle tests.

## Decision

Add `source_registry` and `index_checkpoint` as an additive migration. The
legacy tables and `CatalogStore` API remain intact. `CatalogStore` implements
the application catalog port for metadata reconciliation and checkpoint
readback. `reconcileSourceMetadata` can register an exact personal file with
`entity_scan_state=disabled`; enabling the Navigator changes only the scan
state and does not widen an exact file to its parent directory. A committed
snapshot updates the entity checkpoint and source fingerprint in the same
SQLite transaction as the legacy generation switch.

## Evidence

The focused Session Navigator test suite and metadata-plane test pass at the
candidate revision. Full host behavior, provider discovery and Save As source
registration remain owned by the source lifecycle integration task.

## Boundary

This migration does not make the Navigator enabled by default, scan configured
sources, infer provider content, or expose a catalog path to the Webview. It
does not replace the source lifecycle coordinator or claim real-host evidence.

## Revisit Trigger

Revisit when Save As registration, configuration revision propagation, or a
second catalog consumer is promoted; then move the adapter to
`src/infrastructure/navigator/` and retire the compatibility tables only after
readback and rollback evidence.

## Rollback

Disable metadata-plane callers and retain the additive tables for inspection,
or restore the prior product revision. The original JSONL files and legacy
catalog rows remain untouched; dropping the new tables is a reviewed migration
only after dependent checkpoints are retired.
