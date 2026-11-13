---
id: "075-detail-drawer-page-local-lineage"
path: "docs/decisions/075-detail-drawer-page-local-lineage.md"
title: "Detail Drawer Page-Local Lineage"
kind: "decision"
status: "accepted"
owner: "product"
tags: ["webview", "lineage", "identity", "bounded-work"]
evidence: []
revisit: "before lineage reads outside the accepted page, new provider relationship semantics, cross-source edges or asynchronous layout"
rollback: "remove the Detail Drawer Lineage tab and its pure projection/tests; restore the Table fallback for the retired Graph tab without changing source bytes or Host authorization"
---
# ADR-075: Detail Drawer Page-Local Lineage

ADR-078 extends this decision with explicit bounded lookup, the causal rail,
and source-evidenced OpenTelemetry span/context relationships. Its default
page-only, zero-automatic-read boundary remains in force.

## Pressure and boundary

The document Graph workspace tab presents a fixed physical prefix independently
of the accepted table query. The selected design moves record-level causal
inspection beside the selected record in the Detail Drawer, while the native
Navigator remains the surface for macro session navigation. This is a C2
Webview interaction and state change. It does not establish measured rendering
or latency improvements, source-wide lineage completeness, or a new provider
contract.

This ADR supersedes ADR-071 only for Graph UI placement and the scope of the
interactive lineage projection. ADR-070's authorization and snapshot-identity
rules, and ADR-071's Host read, budget, evidence, publication and reveal
safeguards, remain binding for any Graph Host API or caller that remains. This
decision does not weaken those safeguards or authorize a broader read.

## Accepted scope and invariants

The Lineage view is a pure projection of the rows in the currently accepted
result page, after its query predicates and sort have been applied. The page is
bounded to at most 500 rows. It performs no additional source scan, page
request, IPC, or Graph API request. Its scope is the current result page, not
the entire filtered result, source file, session, or provider history.

Relations whose target is outside that page are unobserved. They must not be
reported as absent, broken, or complete. A relationship indicated by evidence
that cannot be resolved uniquely within the page produces an explicit partial
or ambiguous state. A missing relationship means only that no supported
relationship was observed in this bounded projection; UI copy and status must
not imply global absence. The selected row and all displayed nodes must retain
their exact current-page `RecordRef` values.

Only existing source-backed profile evidence and exact identities in the
current row projections may create edges. Preserve the current known identity
contracts: Claude `uuid`/`parentUuid`, Pi `id`/`parentId`, and Codex
`payload.call_id` only when the call/result pair is unique in the same
supported context. Claude and Pi parent links require the same explicit,
non-empty `sessionId` on both rows. If either row has a non-empty `turnId`,
both must have the same one. Codex call/result links require matching,
non-empty `sessionId` and `turnId` on both rows. The current profile projection
does not always provide these fields; a missing value therefore leaves the
relationship unlinked and coverage partial, even when the identifier is unique
within this page. Do not infer a session from document generation, a missing
value, or an unprojected header. Do not infer aliases, coerce IDs, or create
cross-source edges. Duplicate, missing, unsupported, or context-mismatched
evidence remains unlinked and is represented as partial or ambiguous where
relevant. No raw source text is needed to construct this page-local view.

The current Pi adapter projects `sessionId` only on its session header, so Pi
message-parent links are unavailable in this iteration. Its `id`/`parentId`
recognition remains conditional on a future source-backed row context contract;
the view reports missing context rather than attributing a header to messages.

Selecting a lineage node may inspect it only through the existing exact-record
detail path using that node's current-page `RecordRef`. It must not issue a
Graph reveal request or use a projected identity as a source locator. If the
selected row, accepted page, profile, or generation changes while detail state
is pending, lineage derived from the retired identity is cleared or shown
unavailable until the matching current result is accepted.

## Alternatives and rationale

Keeping the independent Graph tab was rejected because it remains disconnected
from the accepted query page. Moving lineage into the native Navigator was
rejected because that singleton is the macro session-navigation surface,
whereas this inspection belongs to one selected record in one document.
Issuing a Host request for neighbors was also rejected for this iteration: the
user-selected scope is the already accepted page, which avoids additional
source work and transport lifecycle while making incomplete page coverage
explicit.

The supplied design's proposed node counts, frame rates, weighted score, and
claims of optimality are hypotheses, not measured evidence. This decision
accepts the placement and page-local boundary without claiming that those
targets have been achieved. Any future performance claim requires a
representative workload and a reproducible measurement separate from this
interaction decision.

## Probe and evidence

The implementation probe is that opening or changing the Lineage tab on an
unchanged accepted page causes zero source reads and zero lineage-specific IPC;
the projection examines no more than the accepted page's 500 rows. Tests must
cover exact supported IDs, same-context matching, required context missing on
either side, duplicates, unsupported evidence even when its candidate parent
is selected, relations outside the page, generation/profile/page replacement,
and inspection through the existing exact-record detail path. Expected
behavior is a bounded page-local result with explicit partial or ambiguous
coverage, never a false claim of source completeness.

These checks establish pure projection and interaction contracts only. A real
VS Code Webview render and user review are separate acceptance evidence.
Representative performance evidence is required before publishing any
latency, frame-rate, heap, or comparative improvement claim. No such measured
evidence is asserted by this ADR.

## Revisit and rollback

Revisit before reading outside the accepted page, adding provider relationship
semantics, enabling cross-source lineage, adding asynchronous layout, or making
performance claims. Any such change needs a new scope decision, bounded-work
and authorization review, and evidence appropriate to the claim.

Rollback removes the Detail Drawer Lineage tab and its page-only projection
with its focused tests. The obsolete persisted Graph workspace selection must
fall back to Table. Do not remove or relax Host Graph safeguards as part of
this UI rollback. Source bytes and authorization state require no migration.
