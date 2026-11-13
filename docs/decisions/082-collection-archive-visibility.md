---
id: "082-collection-archive-visibility"
path: "docs/decisions/082-collection-archive-visibility.md"
title: "Collection Archive Visibility"
kind: "decision"
status: "accepted"
owner: "product"
tags: ["collections", "session-navigator", "metadata"]
evidence: []
revisit: "when Collection archive ownership or Agent Sessions visibility policy changes"
rollback: "remove the default-off visibility setting and its metadata projection while retaining Collection archive metadata"
---
# ADR-082: Collection Archive Visibility

## Context and change class

Collection archive intent is a persisted product marker on a session reference.
Agent Sessions is a read-only projection of authorized source catalog entities.
Hiding a session by default would make a Collection action appear to alter a
separate source catalog and could obscure the original user-owned source entry.

This is a C2 cross-owner projection decision. The archive marker remains in
Collections metadata; the Session Navigator can optionally filter currently
linked archived session references without changing Catalog rows or source
files.

## Decision

- Archive and restore continue to write only `CollectionsStore` metadata.
- `jsonlView.sessionNavigator.hideArchivedCollectionSessions` is a boolean,
  defaulting to `false`.
- When enabled, Agent Sessions hides a matching archived session identity only
  while it has an active Collection membership. Identity matching includes
  provider, source ID, and native session ID.
- Removing the final Collection membership makes an archived orphan visible.
  Re-adding that globally unique reference retains its archive marker and hides
  it again while the option remains enabled. Restore clears the marker and
  immediately makes the session visible.
- The filter reads only a bounded set of identities on the current catalog
  page through the Collections owner. Missing, corrupt, or unavailable
  Collection metadata fails open for browsing. Catalog continuation cursors
  remain available even when every entity on a page is hidden.

## Alternatives

- **Hide by default:** rejected because archival is Collection-local metadata
  and should not silently change the independent Agent Sessions projection.
- **Write archive state into Catalog:** rejected because it would create a
  second owner for the same user intent and require a migration and recovery
  contract.
- **Hide archived rows with no current membership:** rejected because an
  orphaned metadata row is not a visible Collection reference and should not
  keep a source session hidden after its last link is removed.

## Validation and rollback

Tests cover the default-off setting, source-qualified identity matching,
active-membership filtering, unlinking the final membership, restore
reactivity, fail-open behavior for missing or corrupt metadata, and cursor
preservation for a page whose only entity is hidden. No schema migration or
source-file write is introduced.

Rollback removes the setting, projection query, and refresh subscription. The
persisted Collection archive marker remains readable and restorable.
