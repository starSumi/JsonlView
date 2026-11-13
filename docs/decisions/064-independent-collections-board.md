---
id: "064-independent-collections-board"
path: "docs/decisions/064-independent-collections-board.md"
title: "Independent Collections Metadata Board"
kind: "decision"
status: "accepted"
owner: "product"
tags: ["collections", "navigator", "sqlite", "native-ui"]
evidence: ["source:src/experimental/session-navigator/collections-tree-provider.ts", "source:test/experimental/collections-store.test.ts"]
revisit: "when adding a collection reference kind or changing native view/source authorization boundaries"
rollback: "revert the scoped feature while retaining collection metadata and all source/provider data"
---
# ADR-064: Independent Collections Metadata Board

## Pressure

Users need mutable organization without acquiring ownership of provider files
or changing the read-only runtime projection. The prior proposal coupled filing
to lower Unfiled/Filed filters and assumed an upper Webview; both conflict with
the independent-domain requirement.

## Invariant

Upper Collections changes only names and source-qualified reference links.
Lower Agent Sessions keeps existing authorization, scan, generation, count,
sort and query semantics. Membership never grants permission, scans or writes
provider data. Intake never silently creates membership.

## Owner

Application owns collection types/port; infrastructure owns a separate metadata
SQLite connection; the native Collections provider owns its commands/events.
The existing Session Navigator owns source intake and the read-only resolver.

## Alternatives

Rejected: filing anti-joins in lower queries, collection rows in the runtime
catalog, an upper Webview, a third Add Source view and custom More UI. They add
coupling or duplicate native behavior. The separate database is durable user
metadata, unlike ADR-050's disposable source-catalog metadata; it does not
split or replace source identity/authorization ownership.

## Probe

Exercise durable many-to-many CRUD, qualified references, revision-bound pages,
writer contention/rollback/schema rejection, current authorization after
prompts, original native Uri identity and unchanged lower projections.

## Decision

The upper native drop placement below is superseded by
[ADR-085](085-collections-reference-entrypoint.md), and the sidebar-card
placement is superseded by
[ADR-086](086-import-canvas-and-toolbar-entrypoint.md). Intake now uses the
editor-area Import canvas; Collections exposes only explicit metadata-reference
actions.

Use a native upper Collections TreeView, retaining jsonlView.sourceDrop as its
compatibility ID; retain the lower jsonlView.sessionNavigator ID. VS Code owns
layout/visibility and view/title overflow. The Collections controller accepts
only versioned in-app session-reference drops onto a collection; file and URI
intake belongs to the editor-area Import canvas. Collection actions never
silently file a dropped file. The Import command opens the bounded preview and
authorization actions described by ADR-086.

Keep reference labels transient. Add an exact current-generation catalog read
method instead of reading full snapshots. Explicit session opens reuse the
existing reveal safety chain. Collection writes never invalidate lower queries.
Initialize the independent WAL metadata database lazily after accepted actions.
Before journal changes, require the exact owned versioned table/index DDL,
including columns, PK/unique/FK/cascade constraints, and reject extra objects.
Equivalent third-party schemas are not an import format; retain rejected data.
Existing stores must also pass foreign_key_check before journal changes.
The private database has one supported writer, CollectionsStore: it validates
the provider allowlist, source/native UTF-16 length bounds, control characters
and reference kind before writes. External row edits are unsupported: same-user
database access is not a separate authorization boundary, and reopening is not
a full validator/importer for arbitrary externally authored identity rows.
Recheck issued nodes/epochs after the last store await before metadata writes.
An unauthorized file launches the separate Add Source QuickPick; the existing
focus-add-source bridge action never targets the Collections view.

### Accepted-command recovery amendment

The storage mechanism in this historical amendment is superseded by
[ADR-074](074-collections-shared-journal.md). Pending commands now live in the
same owned SQLite database as metadata, in a separate acceptance transaction.
Memento remains only a read-only legacy import input; no per-key Memento update
can promise preservation against a different window's stale object snapshot.
The original identity, receipt-before-CAS and fail-closed recovery rules remain.

The native provider gives each confirmed mutation a fresh random UUID. It awaits
VS Code globalState storage of the complete original command (UUID, expected
revision, action and payload) under a separate owned pending key before calling
the store. A new action has a new UUID, including an intentional second creation
with the same name. Deriving an ID from the latest revision and label cannot
recover a command whose successful COMMIT response was lost.

On opening metadata and before accepting another mutation, replay the bounded
pending journal with its original commands. SQLite returns matching durable
receipts before checking the current revision; changed commands reusing an ID
fail with MUTATION_CONFLICT. Mutation, revision advance and receipt insertion
share one immediate transaction. Receipt capacity is 10,000; exhaustion refuses
new writes rather than evicting replay evidence. Delete a pending key only after
the store returns its receipt. Storage, replay, CAS or cleanup failure retains
pending state. A missing metadata database with pending commands is unavailable,
never an implicit new database. Corrupt or conflicting journals fail closed and
require reconciliation; recovery does not rebase an unapplied command silently.
Existing metadata remains readable while recovery blocks new mutations. The
upper tree explains the fixed error code and its native Refresh Collections
action retries recovery. Source references retain their existing authorization
checks. No pending failure may hide otherwise readable organization metadata.

An accepted action becomes recoverable once its pending storage completes.
Disposal closes the metadata connection, so a delayed storage completion cannot
write through that retired connection. Its retained accepted command may replay
on the next activation; closing the view does not discard a confirmed mutation.

The provider serializes commands within one host. The pending journal accepts at
most 64 entries, each subject to the existing bounded command validator. It
contains organization metadata only and is not enabled for Settings Sync.
Memento is the native storage owner: its update promise resolves when stored,
and globalState restores on activation. This is a process-restart recovery
contract, not a power-loss fsync guarantee or a cross-window distributed
transaction. Independent hosts remain governed by SQLite receipt identity and
revision CAS. Copying/replacing only one side of the metadata/journal pair is
not a supported migration or import operation.

Only exact owned v1 DDL may migrate. Retain a verified same-directory online
backup before changing it. Create the v2 state and receipt tables from the same
DDL used for fresh databases, and verify them before committing. Avoid ALTER
RENAME spelling differences under exact-schema validation. The exact former
owned ALTER/RENAME result remains recognized; this does not accept arbitrary
equivalent third-party schemas. Migration validation closes and reopens the
database and replays a persisted receipt after a second reopen.

## Evidence

The focused tests under test/experimental cover the discriminating boundaries.
They establish store/mocked-host behavior only. Native platform contracts were
checked against [VS Code Tree View](https://code.visualstudio.com/api/extension-guides/tree-view),
[VS Code API](https://code.visualstudio.com/api/references/vscode-api),
[Node 24 SQLite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html) and
[SQLite WAL](https://www.sqlite.org/wal.html).
The recovery amendment uses the official
[Memento update](https://code.visualstudio.com/api/references/vscode-api#Memento)
and [extension data storage](https://code.visualstudio.com/api/extension-capabilities/common-capabilities#data-storage)
contracts. Tests inject lost COMMIT results, failed pending persistence and
cleanup, host recreation, stale CAS, invalid journal data and migration reopen.

## Boundary

No new dependencies, provider schema migration, source writes, transport/IPC
messages or MCP/ACP mutation surface. Alias/archive/rebind/reset remain deferred.
The accepted-command journal and receipt replay are internal host behavior.
No real-host or performance acceptance is inferred.

## Revisit Trigger

Add a new reference kind, authorize non-catalog files, introduce a public
mutation wire contract or change lower query semantics.

## Rollback

Revert the feature commits and retain the owned metadata database/WAL files,
verified pre-migration backup and pending globalState keys. Do not replay a
pending key against a manually replaced metadata database or delete it as cleanup.
No reset, source move, provider migration or source deletion is permitted as
an incidental rollback.
