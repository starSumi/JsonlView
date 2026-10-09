# ADR-032: Bounded Session Pagination and Source-State Continuations

Status: experimental; accepted for the opt-in Session Navigator.

## Pressure

Codex state homes can contain more sessions than a single metadata scan should
materialize, while Claude projects can contain many transcript files. A fixed
first-load cap must not be presented as the archive size, and raising the cap
would move the cost into one unbounded UI refresh.

## Invariant

- The first scan remains bounded and newest-first according to each provider's
  native metadata order.
- A source reports a bounded opaque continuation only when more source rows or
  files remain. The continuation contains no path, transcript body, or secret.
- A continuation is bound to the provider fingerprint. If the source changes
  between pages, loading more fails closed and the user must refresh. This avoids
  silently skipping or duplicating records under an unstable OFFSET order.
- Pages are merged by native identity, location, and relation identity. Parent
  edges may arrive before or after either endpoint; the catalog resolves them
  when both entities are present.
- The provider store remains read-only. Explicit Load More is the only operation
  that grows the materialized catalog; there is no background unbounded scan.
- The catalog's view query has no arbitrary 2,000-row truncation after a page has
  been explicitly accepted. Provider pages and metadata budgets remain bounded.

## Decision

Providers implement an optional `scanPage(signal, budget, cursor)` contract.
Codex uses a deterministic SQL order and a raw-row offset cursor; Claude sorts
discovered transcript files by activity and uses a file offset cursor. Both
cursor forms are fingerprint-bound and versioned as opaque values. The catalog
persists `next_cursor`, appends a page in a new generation, and keeps the prior
page visible while the next page is loading. The TreeView exposes Load More on a
partial source context action and reports a partial index rather than a total
archive count.

The persistent source-drop view is the only empty-state intake surface. The
native TreeView no longer repeats an obsolete welcome action above that view.

## Alternatives rejected

- Increasing the first scan limit was rejected because it shifts latency and
  memory cost onto every open and still leaves a larger hard ceiling.
- A timer-driven automatic scan was rejected because it can surprise users and
  race active provider writes; continuation is explicit and cancellable.
- A cursor based only on OFFSET was rejected for persisted use because provider
  mutations can reorder rows. Fingerprint binding makes drift visible instead of
  guessing.
- Replacing the native TreeView with a custom virtualized Webview was rejected
  for this stage; only the source intake requires a custom surface.

## Evidence

- [VS Code Tree View API](https://code.visualstudio.com/api/extension-guides/tree-view)
  defines bounded `TreeDataProvider` children and view actions.
- [SQLite isolation](https://sqlite.org/isolation.html) defines coherent read
  snapshots; a later page is therefore a new read and must revalidate source
  identity.
- The provider adapters and synthetic page tests are the implementation
  evidence. Provider-specific state columns remain version-checked observations,
  not public producer APIs.

## Probe and rollback

Tests cover Codex and Claude first-page/continuation behavior, fingerprint drift,
shared rollout locations, cross-page parent resolution, partial status, and
catalog reopen. Disable the opt-in Navigator or revert this scoped change to
return to one bounded scan; source files and provider databases are never
modified.

## Incremental catalog evidence (2026-10-10)

`CatalogStore.appendSnapshot` now copies the active generation with bounded
SQLite `INSERT ... SELECT` statements, applies only the accepted page rows,
reconciles parent edges in the new generation, and removes the prior generation
before switching the source pointer. This avoids reading every prior page into
JavaScript maps and then rebuilding the entire projection for each continuation.
The append remains atomic: a page row that violates the catalog schema rolls
back without changing the previously committed generation, fingerprint, or
continuation cursor. The returned snapshot still carries the existing facade
shape and stable generation identity.
