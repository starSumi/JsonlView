---
id: "074-collections-shared-journal"
path: "docs/decisions/074-collections-shared-journal.md"
title: "Shared SQLite Journal for Accepted Collections Commands"
kind: "decision"
status: "accepted"
owner: "product"
tags: ["collections", "sqlite", "recovery", "migration"]
evidence: ["source:src/infrastructure/navigator/collections-journal.ts", "source:test/experimental/collections-journal.test.ts", "source:test/experimental/collections-recovery.test.ts"]
revisit: "before adding reconciliation UI, journal pruning or remote metadata storage"
rollback: "retain schema4 database with pending commands and verified pre-v4 backup; restore only through reviewed reconciliation"
---
# ADR-074: Shared SQLite Journal for Accepted Collections Commands

## Pressure and boundary

The former ADR-064 journal stored each pending UUID through VS Code globalState.
Independent ExtensionMemento instances persist their cached whole extension
object. A completed command's cleanup can therefore replace another window's
new pending key with an older object snapshot. SQLite CAS rejects the second
effect but cannot recover an accepted command already erased from that journal.
Separate keys do not provide a cross-window compare-and-swap contract.

CollectionsStore owns the local metadata database and its lifecycle. Reuse its
SQLite transactions rather than adding a file-lock or cross-host coordinator.
Lower Agent Sessions, source authorization and provider files remain independent
as required by ADR-064 and ADR-073. This is a C4 persistence migration.

## Decision and transaction boundaries

Schema4 adds collections_pending_command with request_id as its primary key,
command_hash and the complete original command_json. A command retains its UUID,
expected revision, action and payload. The same canonical hash remains shared
with mutation receipts; existing receipt hashes and result JSON are unchanged.

1. Before acceptance, validate the command, current revision, known input
   conflicts and current authorization using the existing preflight.
2. Accept under BEGIN IMMEDIATE. Validate existing bounded pending records,
   check the UUID/hash against pending and receipts, and enforce the shared
   64-command cap before inserting. COMMIT acceptance before applying an effect.
3. In a separate BEGIN IMMEDIATE transaction, return a matching receipt before
   CAS; otherwise recheck CAS, current authorization and mutation constraints,
   apply the effect, advance revision if changed, insert its receipt and COMMIT.
4. In a third immediate transaction, require the matching committed receipt and
   delete only that exact pending UUID/hash. A repeated cleanup is harmless.

An unknown acceptance or effect COMMIT result retains recovery evidence. Effect
and receipt remain atomic, while acceptance survives a lost effect response.
Once the effect returns its durable receipt, cleanup failure cannot turn that
known success into a failed mutation. Return that same receipt even if cleanup
fails before COMMIT or its COMMIT response is lost. Any remaining pending row is
cleaned on the next recovery pass. The native command must not show a mutation
failure/retry warning; if shared pending state remains, expose only the fixed
metadata recovery notice. Unknown acceptance/effect outcomes keep their existing
fail-closed behavior, and recovery cleanup failures still pause new mutations.
All connections use verified WAL, foreign keys and synchronous FULL. SQLite
serializes writers; lock contention produces STORE_BUSY. The 10,000-receipt cap
still refuses new effects without evicting prior replay evidence.
[SQLite transactions](https://www.sqlite.org/lang_transaction.html),
[SQLite synchronous](https://www.sqlite.org/pragma.html#pragma_synchronous).

Recovery queries the shared database on every pass. It validates all pending
commands before replay, with at most 65 rows fetched to detect overflow. SQL
checks UTF-8 byte length before returning command TEXT to JavaScript; decoding
and the command validator reject malformed or oversized input. This bounds host
materialization, not arbitrary filesystem corruption or SQLite's internal work
when examining unsupported externally modified records. No corrupt record is
silently deleted and metadata list reads remain available.

## Legacy import and migration

Memento is read only: recovery reads the currently visible legacy v1 keys,
validates the entire bounded snapshot and imports it in one acceptance
transaction using each exact original UUID and command. A matching committed
receipt skips import, including when receipt capacity is already reached. An
existing differing hash fails MUTATION_CONFLICT and rolls back the entire import.
Original Memento keys remain unchanged; no cleanup update, tombstone or settings
sync key is added. Commands historically erased by another window before this
upgrade cannot be reconstructed from the remaining snapshot.

Only exact owned schema1/2/3 DDL, including the formerly emitted known v2
ALTER/RENAME spelling, migrates. Under the writer lock, reserve a same-directory
pre-v4 UUID backup, take an online backup and verify owned DDL, foreign keys,
integrity, schema version and revision before changing tables. Schema3 entry
attributes, orphan anchors, memberships and receipt rows are untouched. Earlier
entry tables receive nullable attributes; all legacy receipt hashes/result JSON
are copied verbatim. Create canonical schema4 state and pending tables, verify,
then COMMIT. Reopen must pass the same strict check. Invalid source or backup is
retained, never replaced by an empty database.

The schema4 database now contains both pending and effect evidence. Copying or
restoring an older backup alone can omit accepted commands; this requires
explicit reconciliation. Remaining legacy keys are never automatically removed,
even if a future receipt-retention policy makes their outcome uncertain.

## Recovery limits and verification

An independent write can still make an accepted command's original revision
stale. Preserve that command and return REVISION_CONFLICT without rebasing its
expectedRevision. Each host pauses new writes when its next shared recovery
check observes unknown, corrupt, unauthorized or conflicting pending state,
while readable metadata remains visible. This check and a later acceptance are
separate transactions: another host may accept after the current pending
snapshot, so this is not a global barrier. Receipt identity and CAS still apply,
and later recovery checks observe that pending state without silently rebasing.
Refresh Collections retries recovery; it does not guarantee reconciliation or
offer an automatic discard path. Correcting authorization may permit recovery;
a persistent CAS conflict requires reviewed reconciliation. No new UI is added.

Focused tests reproduce the old whole-object overwrite, interleave two live
SQLite owners, reopen conflicting and corrupted pending state, verify writer
contention/capacity/exact cleanup, lose acceptance/effect COMMIT responses,
lose cleanup COMMIT responses without reporting a successful command as failed,
retire hosts across asynchronous boundaries, and check atomic legacy import and
schema1/2/3 backup/reopen preservation. These establish local persistence behavior;
host UI acceptance and independent review remain separate gates.
