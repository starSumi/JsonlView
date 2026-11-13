---
id: "073-collections-entry-metadata"
path: "docs/decisions/073-collections-entry-metadata.md"
title: "Collections Aliases, Local Archive Intent and Explicit Rebind"
kind: "decision"
status: "accepted"
owner: "product"
tags: ["collections", "sqlite", "native-ui", "migration"]
evidence: ["source:src/infrastructure/navigator/collections-store.ts", "source:test/experimental/collections-metadata.test.ts"]
revisit: "before authorizing non-catalog file references or changing provider archive observation"
rollback: "retain v3 metadata, verified pre-v3 backup and pending journal; restore the matching pair only through reviewed reconciliation"
---
# ADR-073: Collections Aliases, Local Archive Intent and Explicit Rebind

## Pressure

The independent Collections board needs durable reference display metadata and
explicit recovery when a user selects a replacement source identity. ADR-064
remains authoritative for independence from the lower Agent Sessions domain.
This decision accepts the metadata portion of the older Collections proposal;
its membership-driven Filed/Unfiled projections remain superseded.

## Invariant and owner

The application owns typed metadata commands. CollectionsStore owns the private
SQLite database, receipts and CAS. The native Collections tree owns prompts
and journal recovery; the existing Navigator owns current authorization and
target resolution. No operation writes, moves or archives a provider file.
Collection membership never authorizes a source, starts scans, changes lower
counts or invalidates the lower projection. This is a C4 migration change.

## Decision and interaction contract

| Operation | Durable effect | Native entry and unavailable behavior |
| --- | --- | --- |
| Rename reference alias | Set a bounded entry alias; blank clears it | Authorized entry context menu and InputBox; unavailable rows redact both alias and source title |
| Set local archive intent | Set a session entry timestamp; retain all links | Session context menu; explicit label on the same upper reference, direct open retained |
| Clear local archive intent | Clear only that timestamp | Archived session context menu, including unavailable references; never claims to restore provider state |
| Rebind reference | Replace exact provider/source/native/kind on the same entry ID | Context menu, authorized source/target QuickPick, confirmation; unavailable old references may select a currently authorized replacement |
| File reference | Reserved @file identity under an already registered exact-file source | Existing Add to Collection entry; direct open uses the existing source-open chain |

Aliases take precedence over the current catalog title only while authorized.
Local intent is independent of provider archive observation; no effective
provider archive boolean is invented, and unknown provider state stays unknown.
Archived references remain visible in their existing collections. They do not
create an Archived collection or a lower Sessions classification.

Rebind preserves every membership, alias and session archive timestamp. The
target must still be the exact currently selected source/entity after each
prompt, after pending-command storage and immediately before the transaction
effect. An existing target identity on another entry yields IDENTITY_CONFLICT;
there is no merge or title/fingerprint matching. A locally archived session
cannot rebind to a non-session reference until its local intent is cleared.
The target picker reads bounded current catalog pages, supports an explicit
native session ID, and does not scan or authorize sources. Cancellation leaves
the entry unchanged. A selected file must remain a regular file before open.
Generic file references do not imply Markdown intake or new parser support.

The durable entry survives its final unlink and collection deletion. Refiling
the exact identity therefore restores its alias/intent. Such orphan anchors are
retained metadata, not a global-history or discovery view. Rebinding that anchor
changes its identity for all links; a later add of the old identity creates a
distinct anchor. There is no unbounded bulk operation or source mutation.

## Storage, migration and recovery

Schema4 journal storage and migration now follow
[ADR-074](074-collections-shared-journal.md); the entry metadata contract below
remains unchanged.

Schema v3 adds nullable display_alias/local_archived_at_ms on collection_entry,
the file reference kind and the three receipt operation names. The timestamp
CHECK permits session entries only. Mutation, metadata revision and receipt
remain one BEGIN IMMEDIATE transaction. No-op commands still receive receipts.
The process-restart pending journal retains the original UUID, revision and
payload; no new public wire contract is introduced.

Only exact owned schema v1/v2 DDL, including the known former ALTER/RENAME v2
layout, may migrate. A same-directory exclusive backup name is reserved first;
online backup is validated for owned DDL, foreign keys, integrity, version and
revision before DDL changes. SQL copies retain entries/memberships and receipt
hashes/result JSON verbatim, without materializing whole tables in JavaScript.
The transaction recreates canonical v3 DDL and checks it before COMMIT. Reopen
must pass the same schema check. Invalid input or backup is retained; no reset,
cleanup, silent receipt normalization or fallback empty database is allowed.

A synchronous host guard runs inside a new mutation transaction after receipt
lookup and CAS. Recovered uncommitted rebinds require a currently authorized
target; a committed receipt can still return after authorization is revoked,
because it creates no effect. Failure retains pending state and readable
metadata; Refresh Collections retries recovery. The guard adds no provider I/O
to the SQLite transaction. Accepted alias/archive recovery changes metadata
only and grants no read authority; rendering and open always recheck authority.
Before pending persistence, a read-only store preflight rejects known stale
revisions, missing entries, identity collisions and incompatible local archive
transitions. These remain transaction checks as well. A normal input conflict
therefore leaves no accepted pending command and the user can select another
target or clear local intent. An independent write after acceptance still
fails CAS and retains the original command for explicit reconciliation.

## Alternatives and standards

Rejected: provider title edits, provider-native archive commands, guessed path
recovery, automatic identity merge, membership-based lower filtering, separate
Webview state and a new file authorization flow. Existing VS Code TreeItem
contextValue/viewItem menus and native pickers supply the interaction surface.
The official [VS Code Tree View](https://code.visualstudio.com/api/extension-guides/tree-view)
and [Memento API](https://code.visualstudio.com/api/references/vscode-api#Memento)
define dispatch/storage; [Node 24 SQLite backup](https://nodejs.org/docs/latest-v24.x/api/sqlite.html#sqlitebackupsourceDb-path-options)
defines online backup. The writer lock holds the metadata revision fixed while
the separate read-only connection backs it up; the backup owner overwrites only
its exclusively reserved empty artifact.
The [SQLite schema-change FAQ](https://www.sqlite.org/faq.html#q11) permits saving
data in temporary tables, recreating the owned table and copying it back. This
keeps canonical DDL stable under exact-schema verification. All dependent
membership rows are retained and the membership table is dropped before its
entry parent; foreign keys remain enabled and are checked before commit.

## Probe, evidence and boundary

Focused real SQLite tests cover cross-link alias/intent, final-unlink retention,
identity collision/CAS, invalid file/archive kinds, lost COMMIT response for all
new operations, strict migration backup and reopen, and original v2 journal
replay with unchanged receipt JSON. Mocked native tests cover redaction, direct
open, explicit confirmation, authorization loss during prompts/storage, retained
pending recovery and readable metadata. Existing Navigator tests cover lower
independence and current source-open safety. These establish L2 behavior only;
real VS Code acceptance and independent C4 review are separate gates.

## Revisit trigger and rollback

Revisit before source authorization expansion, provider archive integration,
public mutation transport or orphan-management UI. To roll back code, retain
the v3 database/WAL, backup and original pending state; old code refuses future
DDL. Do not replay the journal against an independently restored database.
Any restoration of a backup and its matching journal is an explicit reviewed
reconciliation, never an automatic downgrade. Provider sources are unaffected.
