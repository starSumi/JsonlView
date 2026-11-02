---
id: "navigator-collections-20261031-index"
path: "docs/archive/navigator-collections-20261031/README.md"
title: "Navigator Collections Documentation Migration Record"
kind: "index"
status: "archived"
owner: "product"
tags: ["archive", "collections", "documentation", "migration"]
evidence: ["product-revision:14f7bfcd75edf25232c932da0dddf58a3682896f"]
revisit: "when the replacement document set changes or historical traceability is audited"
rollback: "restore the prior document path through a reviewed documentation migration and regenerate docs/index.json"
x-priority: "P2"
x-freshness: "current"
x-review-cadence: "review when replacement links or archive policy changes"
x-last-reviewed: "2026-11-01"
---
# Navigator collections documentation migration

The former monolithic design was moved to `navigator-collections-pre-split.md` and retained as an archive snapshot for traceability. The active replacement is `docs/designs/navigator-collections.md`, which routes to focused documents by function: domain model, SQLite/WAL, contracts, actions, and validation.

The archive copy is superseded historical design input, not a current runtime or schema authority. In particular, its Codex cross-root authority-key and deduplication proposal is not part of v1; use the source-qualified identity and future-evidence gate in the active replacement. New decisions must update the focused replacement document and its generated index entry; the archived snapshot records the pre-split content and explains the split.
