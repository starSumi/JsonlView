---
id: "navigator-collections"
path: "docs/designs/navigator-collections.md"
title: "Navigator Collections Overview"
kind: "design"
status: "proposed"
owner: "product"
tags: ["collections", "navigator", "overview", "persistence"]
evidence: ["product-revision:14f7bfcd75edf25232c932da0dddf58a3682896f"]
revisit: "before implementation and when provider identity or persistence contracts change"
rollback: "withdraw the proposal and retain the source-preserving metadata boundary"
x-priority: "P1"
x-freshness: "current"
x-review-cadence: "before implementation and at each contract change"
x-last-reviewed: "2026-11-01"
x-supersedes: "docs/archive/navigator-collections-20261031/navigator-collections-pre-split.md"
---
# Navigator collections overview

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

## Document layers

- [Domain model and DAG](navigator-collections-domain.md): entities, identity, projections, data flow, and state transitions.
- [SQLite DDL and WAL](navigator-collections-sqlite.md): tables, constraints, indexes, transaction and retry rules.
- [Domain types and Store API](navigator-collections-contracts.md): typed application contracts and repository ports.
- [VS Code actions and context menu](navigator-collections-actions.md): command applicability, state flow, and projection refresh.
- [Validation, migration, and rollback](navigator-collections-validation.md): acceptance matrix, migration boundaries, and evidence levels.
- [Archive migration record](../archive/navigator-collections-20261031/README.md): replacement mapping for the pre-split document.

## Authority and evidence

The current proposal is pinned to product revision `14f7bfcd75edf25232c932da0dddf58a3682896f`. Product source and tests define existing runtime behavior. Public references describe interoperability patterns only and do not override product contracts:

- [VS Code contribution points](https://code.visualstudio.com/api/references/contribution-points#contributes.menus)
- [VS Code Tree View actions](https://code.visualstudio.com/api/extension-guides/tree-view#view-actions)
- [VS Code Webview context menus](https://code.visualstudio.com/api/extension-guides/webview#context-menus)
- [Google notebook help](https://support.google.com/gemini/answer/16972047?hl=en&co=GENIE.Platform%3DDesktop)
- [Node.js SQLite API](https://nodejs.org/docs/latest-v24.x/api/sqlite.html)

This document set is a design proposal. It does not authorize runtime implementation, provider mutation, migration execution, or release publication.
