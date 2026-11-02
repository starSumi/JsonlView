---
id: "navigator-collections-validation"
path: "docs/designs/navigator-collections-validation.md"
title: "Navigator Collections Validation, Migration, and Rollback"
kind: "design"
status: "proposed"
owner: "product"
tags: ["collections", "migration", "rollback", "validation"]
evidence: ["product-revision:14f7bfcd75edf25232c932da0dddf58a3682896f"]
revisit: "before implementation and when provider identity or persistence contracts change"
rollback: "withdraw the proposal and retain the source-preserving metadata boundary"
x-priority: "P1"
x-freshness: "current"
x-review-cadence: "before implementation and at each contract change"
x-last-reviewed: "2026-11-01"
---
## Recovery, migration, and rollback boundaries

On restart, reopen durable metadata, read effective authorization without
granting it, and resolve references against current bounded catalog coverage.
Keep revoked references as redacted placeholders; reauthorization of the exact
same `(providerId, sourceId, nativeId)` restores resolution and its prior links
only after current identity verification. Source missing, provider failure, and
index rebuild retain entries/aliases/memberships. Never interpret a missing
partial page as user deletion. A root relocation is a different source identity
and requires the existing source registration/authorization flow followed by
explicit `rebindEntry` to move an existing entry. An old source returning later
does not silently rebind or resolve another source's entry. A different source
registration cannot act as a fallback, even when its native ID matches. With no
authorization for the exact reference, show a pending/restricted node and
preserve metadata. Rebinding to an already referenced target returns a conflict;
merge, bulk rebind and automatic duplicate reconciliation are queued.

Single-entry reset is explicit: selecting only `clearLocalArchiveIntent` retains
aliases/memberships; selecting `clearMemberships` removes every link for that
entry; `clearAlias` resets only its display overlay. All selected flags commit
at one revision or none do. Reset never deletes the identity bridge or changes
provider-native archive. Thus a still-native-archived item remains Archived;
otherwise remaining membership returns it upper, or no membership returns it
lower. Reset all metadata, reset by source/collection, bulk recovery and source
archive/unarchive adapters are queued separate scopes, not hidden side effects.

Future schema creation/migration must back up the owned metadata database,
validate its version, execute additive changes transactionally, verify foreign
keys/integrity, and reopen before publishing the new revision. There is no
migration execution in this change. Importing legacy `entity_labels` is queued:
those titles have a weaker source-cascade lifetime, so do not silently treat
them as accepted durable aliases or migrate them from an unauthorized cache.

If metadata cannot be read, return `METADATA_UNAVAILABLE`; retain the last
coherent view or show an unavailable state. Do not infer that every source is
unfiled, wipe the database, drop links, or disable source authorization checks.
Repair/export/retention policy needs a separate explicit design. Reverting a
future collections UI preserves its durable database and all sources. Removing
this proposal changes only documentation; it grants no apply/publish authority.

## Acceptance matrix and current evidence boundary

These are implementation acceptance requirements, not claims that the feature
passes. No document-mirroring unit suite is required for this proposal. A
disposable synthetic SQLite probe can verify the DDL's constraints, precise
membership-derived visibility, transaction rollback and durable reopen; it
cannot prove runtime authorization, transport, UI publication, or host opening.

| Case | Required observable result |
| --- | --- |
| Duplicate Add / same request replay | One durable entry and one pair; semantic no-op does not advance revision; replay cannot duplicate a collection or link. Conflicting reuse of request ID fails. |
| Multiple collections | Linking A and B hides the exact lower leaf once; unlink/delete A retains B and hiding; unlink/delete last link restores eligible Unfiled. |
| Rename and local archive | Collection/entry display changes and item archive intent survive restart without changing source/native identity or filesystem/vendor bytes. Collection membership remains intact while an item is archived. |
| Source/folder group reference | Current and future unfiled child sessions remain lower-visible; group expand is bounded; no ancestry-based implicit filing or selection. |
| Parent/subagent hierarchy | Filing a parent preserves unfiled child reachability through a context branch; child identity and provider parent are unchanged. |
| Authorization revoke/restore | Durable metadata remains; clear rendered restricted details; no path/title/alias/content leaks; open/analysis blocked; verified reauthorization recovers links. |
| Same Codex thread ID under separate registered roots | Each exact `(providerId, sourceId, nativeId)` creates or resolves a distinct entry. Memberships, aliases, local archive intent, provider status, and lower visibility are source-local. No unique index or query merges the roots; revoking one source does not change or authorize the other. |
| Revoke and reauthorize one source | Revocation redacts that source's reference and blocks open/analysis without deleting metadata. Reauthorization restores it only after verifying the same source-qualified identity; another authorized source with the same native ID cannot restore it. |
| Provider identity conflict, replacement, or native-ID reuse | If current source readback cannot establish the same provider-stable identity, retain metadata in a pending/conflict state. Do not attach a reused/replaced ID to an existing alias, membership, or archive intent by guess; require explicit recovery/rebind and preserve conflict evidence. |
| Future optional cross-root dedup gate | No v1 behavior is enabled. Evaluation requires a provider-owned, reproducible identity proof bound to each current authorization and tests for equivalent roots, authority/key conflicts and changes, state-database replacement, source revoke/reauthorize, native-ID reuse/replacement, and proof that identity equality never transfers authorization. Conflicting alias/membership/archive/status behavior must also be specified before adding an index or merge path. |
| Missing, partial and rebind | Partial coverage is pending; verified missing retains metadata; explicit authorized rebind preserves links/alias/local intent; occupied destination conflicts without merging. |
| Index rebuild and restart | User organization and local archive intent survive disposable catalog removal/replacement/reopen. Temporary preview content is not promised; explicit save/register is required. |
| Async stale list | Old revisions/authorization epochs never repaint either projection after a commit, revoke, restart, or rebind. |
| Native archive and local restore/reset | Read-only native archived status hides a native-only row without creating metadata; local intent OR native archive keeps it Archived. Clearing only local intent preserves alias/memberships; native archive remains until Codex changes it. A path relocation that produces a new source ID remains a separate identity unless the user explicitly rebinds. |
| Partial native observation | Truncation, revoked authorization, absent page, absent archive column, NULL status, or unrecognized status never clears observed archive or local intent; report unavailable/pending and retain associations. |
| Codex archive schema compatibility | Recognized native values map to active/archived; a missing `threads.archived` column, NULL, or unrecognized value maps to unknown and cannot appear as Unfiled. |
| Local reset combinations | Each explicit flag affects only its named metadata; all flags transact together. Remaining links return upper only if provider/local archive false; no links returns lower only if unarchived. Global/source/collection reset is unavailable in v1. |
| Concurrent rename/delete/move/archive/reset | Expected revision admits one serialized winner; loser gets conflict/no effect. Move to deleted destination rolls back all link/revision writes. |
| High membership cardinality | Reset/delete works for hundreds of links without returning full affected-ID arrays; receipt and IPC stay bounded, relationships/counts remain accurate and paginated. |
| Cancel, constraint, busy and delivery failure | Before-commit cancellation/failure rolls back; lock retry reuses request ID; after-commit uncertain delivery retrieves receipt and refreshes coherently. |
| Filtering, ordering, counts and pages | Authorization/search/unfiled anti-join precede ordering/keyset/limit; no short-page filtering gaps; stable ties use SQLite collation; exact/partial counts match scope. |
| Selection and mixed files | Checking/unchecking changes only analysis selection; file/Markdown/session capabilities are explicit; unlink/rename never alters source bytes or vendor rows. |
| Intake and direct open | Paste/drop/local/agent-connect remain discoverable; all selected URI batches are validated; sessions/JSONL direct-open through the existing gate; unsupported analysis does not masquerade as success. |
| Corrupt/unavailable metadata | Unavailable state preserves source and organization; no false Unfiled reset, auto-delete, or authorization bypass. |

The contract keeps source authority separate from product metadata, filters before pagination, and uses one metadata transaction for coupled changes. Unsupported assumptions about provider behavior, file locking, distributed audit, and model-training workflows are excluded.

Before implementation: review this proposed many-to-many/archive policy,
concurrency/cursor limits, Markdown attachment capability, storage lifecycle and
read-coordination approach. Before runtime acceptance: extend the existing
Navigator store/lifecycle/intake fixtures with the matrix above, exercise both
native and upper adapters, and observe real-host open/revoke/restart behavior.
Documentation validation or a SQLite-only probe does not reach that acceptance
level, performance evidence, installation, or release readiness.
