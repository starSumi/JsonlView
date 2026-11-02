---
id: "metadata-index"
path: "docs/metadata/README.md"
title: "Documentation Metadata Contract"
kind: "policy"
status: "active"
owner: "product"
tags: ["documentation", "governance", "metadata", "lifecycle"]
evidence: []
revisit: "when the document schema or lifecycle operations change"
rollback: "restore the previous validator and regenerate the index from the last accepted revision"
---
# Documentation Metadata Contract

Each product document is one Markdown or MDX file with a YAML front matter
block followed by the human-readable body. The file name is the identity: the
basename without its extension is the `id`. Directory README files are the
only navigation exception and use a path-scoped `*-index` id.

`docs/index.json` is a generated read-only projection. It exists for fast
search, metadata filtering, summaries, and integrity checks; it is never an
independent source of truth. Regenerate it from front matter after a document
change and keep its ordering deterministic.

## Required front matter

Every document has `id`, `path`, `title`, `kind`, `status`, `owner`, `tags`,
`evidence`, `revisit`, and `rollback`. Tags are unique strings and should carry
domain, phase, and lifecycle information such as `p2` or `completed`. Evidence
contains only bounded receipt identifiers or public URLs; private paths and raw
transcripts stay in the external harness.

Documents that need maintenance ranking may use the approved `x-` extensions
`x-priority` (`P0` through `P3`), `x-freshness` (`current`, `watch`, or
`stale`), `x-review-cadence`, and `x-last-reviewed`. `x-last-reviewed` records
the last substantive content review; it must not be populated from a file move
or migration timestamp. A replacement relationship uses `x-supersedes` on the
new document or `x-superseded-by` on the archived document. These fields guide
maintenance only and do not increase evidence strength or change runtime
authority.

## Lifecycle operations

- `create`: create a unique file with valid front matter and a non-empty body.
- `read`: resolve by `id` through `docs/index.json`, then read the source file.
- `update`: change body or allowed metadata without changing `id` or `path`.
- `search`: filter the generated projection by id, title, tags, kind, status, or
  summary without opening every document.
- `list`: enumerate documents in stable id/path order with their lifecycle state.
- `summary`: return bounded counts and summaries from the projection.
- `delete`: use a reviewed removal or archive operation; regenerate the index,
  preserve Git history, and reject dangling links or missing replacement notes.

Resolved blockers become `conclusion` or `completed` through metadata and tags;
stale actions are updated or archived. A document that no longer carries a
current contract must not remain `active` merely because it is old.

Run `pnpm check:docs-index` to validate front matter, filename identity, index
coverage, deterministic digests, and the ADR link index.
