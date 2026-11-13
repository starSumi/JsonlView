---
id: "085-collections-reference-entrypoint"
path: "docs/decisions/085-collections-reference-entrypoint.md"
title: "Collections Reference Entrypoint and Intake Separation"
kind: "decision"
status: "accepted"
owner: "product"
tags: ["collections", "navigator", "native-ui", "authorization"]
evidence: ["source:src/experimental/session-navigator/collections-tree-provider.ts", "source:src/experimental/session-navigator/tree-provider.ts", "source:test/experimental/collections-metadata.test.ts", "source:test/experimental/session-navigator-lifecycle.test.ts"]
revisit: "when adding another reference kind or changing the intake and Collections boundary"
rollback: "revert the native actions and view wiring without changing SQLite metadata, source authorization or preview ownership"
---
# ADR-085: Collections Reference Entrypoint and Intake Separation

## Pressure and invariant

The sidebar intake-card placement described in this decision was superseded
by [ADR-086](086-import-canvas-and-toolbar-entrypoint.md). Its separation
between source intake and Collections metadata, authorization checks, and
explicit reference membership remain in force.

An empty collection previously displayed a passive instruction directing users
to a different tree. Its view also accepted external file drops through the
source-intake controller and offered Add Source in its title menu. These routes
made the target's meaning ambiguous: a drop over a collection previewed a file
but did not file it.

Collections owns organization metadata. Source registration, authorization,
preview and scanning remain independent explicit actions. Adding a reference
must preserve source bytes, lower Agent Sessions results and its polling owner.

## Owner and decision

The native Collections provider owns an `add-reference` leaf under an empty
collection and an Add Existing Reference action on every collection. Both call
`collections.addReference` with an issued node, its collection ID and metadata
revision. The collection action also remains available after it has members.

The existing Session Navigator resolver supplies a purpose-labelled picker
over its currently authorized catalog. A user chooses a source, a registered
exact file (`@file`), an indexed session or an exact ID already in that catalog.
The picker may open the existing catalog owner before Sessions is expanded,
with source synchronization disabled. Selection does not open a file dialog,
enable Navigator, register or authorize
a source, probe a provider or start a scan. When no authorized targets exist,
show an explanation directing the user to the separate Add Source route.
Importing a new file and filing its registered reference are two explicit
actions; a temporary preview never becomes a collection entry implicitly.

Remove source-file and URI intake from `jsonlView.sourceDrop` and remove Add
Source from its title menu. Keep its versioned in-app session-reference
controller for explicit collection membership. The editor-area Import canvas
owns file drops, file/folder pickers and paste; lower Agent Sessions retains its
existing Add Source entry. This supersedes only the upper native intake-drop
placement in [ADR-064](064-independent-collections-board.md) and the old
native-tree intake route in [ADR-076](076-source-intake-stage.md). Compatibility
view IDs stay unchanged.

The command rechecks the issued node, candidate generation/root and authorized
label after selection and store awaits. It sends the original node revision
through the existing shared journal and CAS path from
[ADR-074](074-collections-shared-journal.md). It creates no schema, command log,
authorization cache or second store. A changed revision is a conflict, never
an implicit rebase. A command accepted before interruption retains its exact
UUID, revision and identity for the existing recovery/receipt path. Recovery
does not read source content; unavailable references remain redacted.

## Alternatives

Direct import from a collection was rejected because enabling Navigator,
authorizing a chosen path and scanning it would give a metadata command a
second source-intake owner. Automatic filing after a drop or Save As would
also imply membership without a separate user choice. Keeping only the lower
item menu would preserve the passive empty-state dead end. A custom Webview
tree is unnecessary for a native command row and inline collection action.

## Probe, evidence and boundary

Tests exercise the real metadata SQLite store and native command registration:
adding authorized sessions and registered files, adding to a nonempty
collection, unchanged lower-tree results, and absence of source-intake effects.
Persisted references remain selectable before Sessions is expanded, without
synchronizing configured sources.
Cancellation, refresh, stale candidates, revoked labels, collection deletion
and disposal before acceptance leave no new pending command. Revocation during
acceptance retains the original pending command; recovery and receipt replay
produce one link. View registration keeps the versioned session-reference drop
controller while excluding files and URI intake. Existing intake tests own
canvas file-drop behavior.

These checks establish source, command and storage behavior. They do not
establish real OS drag routing, native picker appearance, installed-package
identity, performance or user acceptance.

## Revisit and rollback

Revisit if registered-reference selection needs a new reference kind, a changed
authorization owner or measured catalog paging changes. Roll back the scoped
command, manifest and view wiring together. Keep the existing metadata database,
pending commands, receipts, source settings and preview files under their
current owners; rollback requires no data migration or source rewrite.
