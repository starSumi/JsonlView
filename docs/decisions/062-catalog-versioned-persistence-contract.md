---
id: "062-catalog-versioned-persistence-contract"
path: "docs/decisions/062-catalog-versioned-persistence-contract.md"
title: "Catalog Versioned Persistence Contract"
kind: "decision"
status: "accepted"
owner: "product"
tags: ["catalog", "migration", "persistence", "validation"]
evidence: []
revisit: "when the catalog schema, storage medium, or validation boundary changes"
rollback: "stop the new catalog write path, retain the previous snapshot, and use the last validated schema version"
---
# ADR-062: Catalog Versioned Persistence Contract

Status: accepted for the metadata-only catalog snapshot boundary.

## Pressure

Catalog snapshots need an explicit evolution path and a durable write boundary.
Directly changing a persisted shape or replacing its target in place can leave
old readers, partial files, or unvalidated data with no recoverable decision.

## Contract

`CatalogSnapshot.schemaVersion` is a positive safe integer. Migrations advance
one version at a time and must validate their output before the next migration
is selected. Unknown input, downgrade requests, missing links, duplicate links,
non-contiguous links, migration failures, and rejected postconditions are
explicit errors; the migration function never silently casts unknown data.

Catalog persistence serializes a canonical key order, writes to an exclusive
same-directory temporary file, computes SHA-256 over the bytes written, reads
the temporary bytes back for verification by default, and atomically renames
the verified file into place. A failed atomic operation leaves the prior target
untouched and removes only its owned temporary file. Direct writes are opt-in
through `atomicWrite: false` and retain their documented partial-write risk.

Runtime boundary validation uses `ValidationResult<T>` and the existing
128-character diagnostic-code limit. The shared guard is intentionally small;
domain-specific snapshot validation remains owned by the catalog migration
module.

## Ownership

- `src/application/catalog/migrations.ts` owns schema transitions and
  post-migration validation.
- `src/application/catalog/catalog-persistence.ts` owns serialization,
  checksums, temporary files, rename, and failure cleanup.
- `src/shared/validation.ts` owns reusable runtime guards and discriminated
  validation results.
- `src/application/index.ts` is the public application entry point for the two
  catalog modules. Shared validation remains directly imported from its module
  because the repository has no shared barrel.

## Failure and rollback

Migration errors stop before an unvalidated snapshot is returned. Persistence
errors return a typed `CatalogPersistenceError`; atomic failures do not replace
the previous target. Rollback is operational: stop the new write path, retain
the last verified target, and select a reader/migration chain that understands
that version. The optional migration `rollback` hook is a recovery extension,
not a substitute for retaining the previous file.

## Evidence

Focused migration tests cover version-1 to version-2, multi-step chains,
invalid input, gaps, downgrade, validator rejection, and migration failure.
Focused persistence tests cover canonical output, read-back mismatch, write,
read, rename, collision, cleanup, direct-write, and atomic success paths.
Shared validation tests cover success, the 128-character boundary, overlong and
non-string values, and type-guard narrowing. Product-wide gates remain the
acceptance boundary for the merged candidate.
