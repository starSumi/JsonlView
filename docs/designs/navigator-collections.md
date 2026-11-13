---
id: "navigator-collections"
path: "docs/designs/navigator-collections.md"
title: "Navigator Collections Overview"
kind: "design"
status: "accepted"
owner: "product"
tags: ["collections", "navigator", "overview", "persistence"]
evidence: ["decision:ADR-064", "source-contract:collections-tree-provider", "test-contract:collections-store"]
revisit: "when collection metadata ownership, source-qualified references, intake, or the independent Navigator view boundaries change"
rollback: "revert the implemented Collections slice while preserving source/provider data and retaining owned collection metadata for recovery"
x-priority: "P1"
x-freshness: "current"
x-review-cadence: "at each collection identity, persistence, intake, or Navigator ownership contract change"
x-last-reviewed: "2026-11-06"
x-supersedes: "docs/archive/navigator-collections-20261031/navigator-collections-pre-split.md"
---
# Navigator Collections Overview

## Accepted implementation boundary (2026-11-06)

This increment implements a native upper Collections board for user-owned
collection names and explicit many-to-many references. Lower Agent Sessions
retains its authorized read-only runtime catalog, queries, counts and sorting.
The two domains are independent: collection CRUD/membership/refresh never
writes source bytes, authorizes sources or starts scans. Archive intent does
not filter lower rows by default; the optional projection setting in
[ADR-082](../decisions/082-collection-archive-visibility.md) can hide linked
archived sessions without rescanning sources.
The proposal's lower Unfiled/Filed/Archived composition is superseded.

Collections uses a separate metadata database and provider. The upper view keeps
the compatibility ID jsonlView.sourceDrop, named Collections; the lower remains
jsonlView.sessionNavigator, named Agent Sessions. VS Code owns layout/visibility
and native view/title overflow. Collections is the first sidebar view. Its
title Import action opens the editor-area intake canvas before New Collection.
It offers Choose files, Choose folder and Paste JSONL above a wide external-file
drop target. The Activity Bar no longer reserves a sidebar intake card. Native
file/folder actions retain explicit source authorization; dropped or pasted
content creates only a bounded temporary preview and never silently adds
membership. See
[ADR-086](../decisions/086-import-canvas-and-toolbar-entrypoint.md).

Current types/port, metadata DDL and tests live in src/application/collections,
src/infrastructure/navigator/collections-{store,schema}.ts and
test/experimental/collections-store.test.ts. Lists use revision-bound pages;
reference titles resolve only from the current authorized, already loaded
catalog. Missing/revoked sources retain removable, redacted links. Explicit
session clicks reuse the existing safe JsonlView reveal chain.

While Agent Sessions is enabled, its root keeps the expandable `Detected
sources` branch and a `Connect local agent…` action alongside authorized
sources. Expanding the branch checks only provider-owned default roots and lists
un-authorized, non-excluded candidates; it does not authorize or scan them.
Selecting one candidate is the explicit authorization gesture. `Connect local
agent…` opens the provider picker on every invocation, so adding Codex first
does not hide later Pi, Kimi Code, or other provider choices. Existing source
rows stay intact and repeated additions of the same source do not duplicate
settings. This is separate from the `Add Source` title action, which continues
to offer JSONL file, folder, and paste intake. Keep these as short native
TreeView rows so they remain reachable in a narrow sidebar through standard
host truncation and vertical scrolling; discovery and authorization never
depend on title-bar overflow.

[ADR-064](../decisions/064-independent-collections-board.md) defines this
independent board. [ADR-073](../decisions/073-collections-entry-metadata.md) adds
entry aliases, session-local archive intent, explicit rebind and registered
exact-file references with verified legacy migration. Local archive intent
remains visible on upper references and only filters lower Sessions when the
optional ADR-082 projection setting is enabled; aliases
remain redacted while sources are unavailable. The original proposal below is
retained for design history: its upper Webview, move/reset, target-token/wire
envelopes and filing-aware lower predicates are not implemented contracts. Internal
accepted-command recovery and durable receipt replay follow ADR-064's amendment;
they do not expose the proposal's mutation wire protocol.

## Historical proposal (superseded; not a runtime or implementation contract)

The following material records the earlier broad design. ADR-064 and the
accepted implementation boundary above supersede its unimplemented features.
Treat it as design history only; it does not describe shipped behavior or
authorize implementation.

### Original overview

This proposal defines a source-preserving metadata layer for organizing sessions, files, and registered sources. Provider records and source bytes remain authoritative; collection rows, aliases, memberships, and local archive intents are product metadata. Metadata operations never delete or rewrite provider records, transcript content, or source files.

The default projection is mutually exclusive per currently authorized item:

1. `Archived`: provider archive observation or local archive intent is true.
2. `Filed`: the item is not archived and has at least one collection membership.
3. `Unfiled`: the item is not archived and has no collection membership.

Membership is many-to-many. Removing a link changes only the association. Restoring a local archive intent does not clear provider-native archive state. Unauthorized, incomplete, or conflicting provider observations remain unavailable or pending; they are never inferred as unfiled.

The v1 reference identity is the exact `(providerId, sourceId, nativeId)` tuple.
Equal provider/native IDs under different registered sources remain distinct;
cross-root deduplication and authority-key indexes are deferred to an optional
future provider-owned contract gated by authorization-bound identity proof and
lifecycle tests.

### Document layers

- [Domain model and DAG](navigator-collections-domain.md): entities, identity, projections, data flow, and state transitions.
- [SQLite DDL and WAL](navigator-collections-sqlite.md): tables, constraints, indexes, transaction and retry rules.
- [Domain types and Store API](navigator-collections-contracts.md): typed application contracts and repository ports.
- [VS Code actions and context menu](navigator-collections-actions.md): command applicability, state flow, and projection refresh.
- [Validation, migration, and rollback](navigator-collections-validation.md): acceptance matrix, migration boundaries, and evidence levels.
- [Archive migration record](../archive/navigator-collections-20261031/README.md): replacement mapping for the pre-split document.

### Historical authority and evidence

The original proposal was written against product revision `14f7bfcd75edf25232c932da0dddf58a3682896f`. Product source and tests define current runtime behavior. Public references describe interoperability patterns only and do not override product contracts:

- [VS Code contribution points](https://code.visualstudio.com/api/references/contribution-points#contributes.menus)
- [VS Code Tree View actions](https://code.visualstudio.com/api/extension-guides/tree-view#view-actions)
- [VS Code Webview context menus](https://code.visualstudio.com/api/extension-guides/webview#context-menus)
- [Google notebook help](https://support.google.com/gemini/answer/16972047?hl=en&co=GENIE.Platform%3DDesktop)
- [Node.js SQLite API](https://nodejs.org/docs/latest-v24.x/api/sqlite.html)

The proposal's deferred capabilities do not authorize runtime implementation,
provider mutation, migration execution, or release publication. Current
implementation authority comes from accepted ADR-064 and the source-backed
scope recorded at the top of this page.
