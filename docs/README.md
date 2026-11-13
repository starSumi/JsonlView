---
id: "docs-index"
path: "docs/README.md"
title: "Product Documentation"
kind: "index"
status: "active"
owner: "product"
tags: ["documentation","ownership","public-surface"]
evidence: []
revisit: "when the documentation topology changes"
rollback: "remove this catalog entry in a reviewed metadata migration"
---
# Product Documentation

This directory is the public documentation surface for JsonlView. It describes
the product contract, architecture decisions, format/profile behavior,
security boundaries, and reliability gates. It must remain readable from a
clean product checkout without access to a developer machine or an evidence
workspace.

## Ownership

The Detail Drawer Lineage view and its current-result-page coverage contract
are described in [ADR-075](decisions/075-detail-drawer-page-local-lineage.md).
The internal Graph Host protocol's physical-prefix and reveal safeguards remain
documented in [ADR-071](decisions/071-current-document-graph-hierarchy-and-reveal.md);
that record does not describe an active workspace Graph tab.

- `decisions/` contains durable product decisions and their rollback triggers.
 - `reliability/` contains local extension SLI/SLO and release-gate policy.
 - `security/` contains the threat model and security control map.
 - `operations/` contains the stable incident-response and postmortem policy;
   incident instances and raw evidence remain external.
- `assets/` contains reviewed public screenshots used by the README.
- Root documents cover format boundaries, the roadmap, and publication flow.

An external validation workspace owns synthetic fixtures, benchmark records,
host acceptance evidence, screenshots awaiting review, release readbacks, and
postmortem instances. Its state is never a product runtime dependency or a
release input.

## Diátaxis navigation

Use the documentation by intent before opening a decision record:

- **Tutorials** guide a new user through a first real JSONL/NDJSON workflow; start at
  [A Real Use Path](../README.md#a-real-use-path) in the repository README.
- **How-to guides** give steps for a concrete task: use the [Marketplace publication
  guide](marketplace-publishing.md) for a read-only plan or manual handoff, and the
  [promotion runbook](promotion-runbook.md) for the release sequence.
- **Reference** documents state stable formats, protocol fields, limits, and
  commands; begin with [format and profile boundaries](format-and-profile-boundaries.md),
  [metadata governance](metadata/README.md), or the applicable reference document.
- **Explanation** documents record why the architecture has its current shape; use
  [decision records](decisions/README.md) for durable trade-offs and invariants.

The four quadrants are navigation labels, not new document kinds.
`docs/index.json` remains the generated lookup projection, and Markdown remains
authoritative.

## Architecture domains

For architecture work, use these verified domain entry points before the chronological ADR list:

| Domain | Start with |
| --- | --- |
| Core engine and physical framing | [format and profile boundaries](format-and-profile-boundaries.md), [Rust engineering rules](rust-engineering-rules.md), [acceleration roadmap](acceleration-roadmap.md) |
| Presentation and Webview | [theme adaptation](designs/theme-adaptation.md), [Query Studio and Navigator](designs/query-studio-and-navigator.md) |
| Catalog, persistence, and storage | [Navigator collections (implemented subset)](designs/navigator-collections.md), [V2 architecture roadmap](architecture-v2-roadmap.md) |
| Protocols, distribution, and agent interfaces | [local MCP and audit plan (proposed)](mcp-local-plan.md), [marketplace publishing](marketplace-publishing.md), [promotion runbook](promotion-runbook.md) |

These domain links provide progressive disclosure; they do not reclassify or duplicate the underlying ADR files.

## Reading order

1. Start with the repository `README.md` for product scope and user flow.
2. Read `format-and-profile-boundaries.md` for source and projection rules.
3. Read `designs/theme-adaptation.md` for the accepted host-theme and Webview
   interaction baseline.
4. Read `decisions/README.md` before changing a shared boundary.
5. Read `metadata/README.md` for the per-file front matter contract and use
   `index.json` for generated lookup, summaries, and integrity checks.
6. Read `reliability/service-levels.md` and `security/threat-model.md` when a
   change affects performance, failure handling, paths, or data exposure.
7. Read `operations/postmortem-policy.md` when a failure needs corrective
   action or recurrence prevention.
8. Read `architecture-v2-roadmap.md`, `rust-engineering-rules.md`, and
   `mcp-local-plan.md` before changing a native, control-plane, projection,
   MCP, audit, or staged-mutation boundary.

## Design baselines

- [AppShell v0.3.0 milestone](designs/app-shell-milestone.md) plans the selected
  command rail, drawers, Import guidance and durable material history from the
  frozen studio baseline. Its [acceptance checklist](designs/app-shell-acceptance.md)
  tracks implementation and installed-host validation; both remain proposed.
- [Theme adaptation design](designs/theme-adaptation.md) records the accepted
  Neutral Contrast direction, Compact Focus density guidance for dark host
  themes, semantic VS Code token contract, and visual acceptance boundary.
  It is product documentation, not runtime configuration or harness evidence.
- [Navigator collections overview](designs/navigator-collections.md) describes
  the accepted native upper Collections board and its source-preserving
  metadata boundary, then labels the broader unimplemented proposal as history.
  ADR-064 is the implementation decision; the linked domain, storage,
  application, action, and validation documents retain their own proposal status.
- [Query Studio and Navigator contract](designs/query-studio-and-navigator.md)
  records the selected shared-anchor interactions, candidate/queued states,
  Host defaults, Curated/Runtime separation and owner-specific implementation
  gates; the newer Navigator composition remains pending visual review.

Claims about measured performance, installed-host behavior, or release output
must link to an immutable external evidence receipt containing an ID, source
revision, digest, boundary, and reproduction command. A receipt is an audit
pointer, not a build input or runtime dependency.
