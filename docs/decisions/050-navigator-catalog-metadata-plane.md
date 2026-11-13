---
id: "050-navigator-catalog-metadata-plane"
path: "docs/decisions/050-navigator-catalog-metadata-plane.md"
title: "Navigator Catalog Metadata Plane"
kind: "decision"
status: "experimental"
owner: "product"
tags: ["checkpoints","metadata","session-navigator","sqlite"]
evidence: []
revisit: "when Save As registration or a second catalog consumer is promoted"
rollback: "disable metadata-plane callers and retain the additive migration"
---
# ADR-050: Navigator Catalog Metadata Plane

Status: accepted

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

`src/application/catalog/` owns the database-free model, complete
`SessionCatalogPort`, and stable source identity vocabulary. The SQLite adapter
belongs in `src/infrastructure/navigator/`; the old experimental import path
is a compatibility re-export. Provider discovery, scan strategy, and tree
projection remain in `src/experimental/session-navigator/`.

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
readback without the source body. Verify bounded child pages, generation and
fingerprint compare-and-swap for appends and cursor invalidation, cancellation,
and transaction rollback. The compatibility re-export must keep the existing
Navigator call sites buildable during migration.

## Decision

Add `source_registry` and `index_checkpoint` as an additive migration. The
legacy tables and `CatalogStore` API remain intact. The infrastructure adapter
implements the complete application port for source metadata, bounded entity
queries, location lookup, snapshot publication, update hints, and catalog
lifecycle. `reconcileSourceMetadata` can register an exact personal file with
`entity_scan_state=disabled`; enabling the Navigator changes only the scan
state and does not widen an exact file to its parent directory. A committed
snapshot updates the entity checkpoint and source fingerprint in the same
SQLite transaction as the legacy generation switch. Continuation invalidation
uses a generation, cursor, and fingerprint compare-and-swap and only clears the
matching cursor, preserving the committed generation and rows.
`syncSources` publishes the metadata registry and legacy source projection in
one `BEGIN IMMEDIATE` transaction, so a restart cannot observe a half-applied
source configuration.

## Evidence

The adapter migration keeps the same SQLite schema and public call surface. The
legacy database fixture proves the additive migration preserves readable rows;
the focused catalog suite covers paging, guarded invalidation and rollback.
The SQLite transaction remains the single publication boundary for replace
and append. Moving this projection to Rust is deferred until a representative
benchmark establishes catalog materiality and a Rust persistence contract can
preserve that transaction boundary. Full host behavior, provider discovery and
Save As source registration remain owned by the source lifecycle integration
task.

## Boundary

This migration does not make the Navigator enabled by default, scan configured
sources, infer provider content, or expose a catalog path to the Webview. It
does not replace the source lifecycle coordinator or claim real-host evidence.

## Revisit Trigger

Revisit Rust projection only when representative source inventories and
concurrent Navigator workloads show material CPU, memory, or latency cost, and
the proposed implementation has differential tests plus transaction-failure
and rollback evidence. Retire legacy tables only after readback and rollback
evidence.

## Rollback

Disable metadata-plane callers and retain the additive tables for inspection,
or restore the prior product revision. The legacy import path remains a thin
re-export, so callers can be redirected without changing the on-disk schema.
The original JSONL files and catalog rows remain untouched; dropping metadata
tables is a reviewed migration only after dependent checkpoints are retired.
