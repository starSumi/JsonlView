---
id: "078-lineage-rail-and-explicit-bounded-lookup"
path: "docs/decisions/078-lineage-rail-and-explicit-bounded-lookup.md"
title: "Lineage Rail and Explicit Bounded Lookup"
kind: "decision"
status: "accepted"
owner: "product"
tags: ["lineage", "webview", "identity", "bounded-work", "cancellation"]
evidence: []
revisit: "before adding automatic lookup, global identity indexes, cross-source links or native lookup acceleration"
rollback: "remove explicit lookup and rail controls; restore ADR-075 page-only rendering without changing source bytes, query predicates or user settings"
---
# ADR-078: Lineage Rail and Explicit Bounded Lookup

The Detail Drawer needs a readable relationship spine and a deliberate way to
inspect an unresolved parent. This C2 interaction and C3 bounded-read change
extends ADR-075. Ordinary Lineage activation remains a pure projection of the
accepted result page, with no additional reads or IPC. This decision does not
establish whole-source completeness or a measured latency target.

## Ownership and evidence

The shared lineage evidence module owns supported exact field paths. The
Webview owns rail projection, previews, branch expansion and local navigation.
App owns the protocol client and query/detail actions. The Host owns current
page reference issuance, cancellation, lifecycle and delivery. The application
use case owns lookup-window selection and outcomes. The session adapts the
existing engine's observed background row reader; the engine owns the index,
source metadata checks and actual content-read allowance.

| Surface | Supported relation | Required identity/context |
| --- | --- | --- |
| Claude transcript | `uuid` to `parentUuid` | Same generation/profile and nonempty session; compatible explicit turn |
| Pi records | `id` to `parentId` | Same constraints; missing per-record session stays unresolved |
| Codex rollout | `payload.call_id` call/result | Same generation/profile, nonempty session and turn; unique opposite kind |
| Flat OpenTelemetry spans | `spanId` / `SpanId` to `parentSpanId` / `ParentSpanId` | Exact trace field evidence plus trace ID and span ID; each span's own turn ID is not shared turn context |
| Flat OpenTelemetry logs | `spanId` / `SpanId` to a span | Trace and span context; explicitly non-causal; logs are never span identity candidates |

All evidence must have source confidence. Zero span/trace identities are not
linked. Nested OTLP envelopes remain envelope records, not invented physical
span records. No generic correlation ID creates a causal edge. Multiple IDs
or physical references produce ambiguity; timestamps and neighboring ordinals
do not establish causality or concurrency.

## Explicit lookup contract

`LOOKUP_LINEAGE_RECORD` uses the existing protocol envelope: document ID,
generation, optional monotonic epoch, and request ID. Its payload contains only
`sourceRef` (all seven physical reference fields) and `relation` (`parent`,
`tool-partner`, or `span-context`). The Host accepts only an exact reference
from a currently delivered page or an accepted lookup result for that page.
Rejected page posts issue no lookup authority. New pages revoke that authority.
The Host derives the identifier and context from its row projection; request
payloads cannot select a file, field path, substring needle, byte offset or quota.

For parent/span context and tool results, search the preceding 500 physical
records, excluding the source. For a tool call, search the next 500 records.
The preceding range starts at zero for an earlier source. A physical forward
cursor reads that range through the existing index. The range is independent
of current table predicates. Ordering can place a parent outside this range;
the UI describes exactly the range it checked and provides no global absence
claim or automatic continuation.

| Host limit | Enforcement |
| --- | --- |
| 500 records | Pre-hydration examined-record allowance; no lookahead record hydration |
| 1 MiB content-read requests | Precharge and shorten every read across cold indexing, ref reconstruction and hydration; failed/short reads are not refunded |
| 1 MiB examined/returned source bytes | Check the next record before hydration; no unbounded line buffer |
| 1.5 s absolute deadline | Includes queue wait; checked at dispatch, between records and before content reads |
| One latest request | Request registry aborts superseded work; publication checks page revision, source identity, profile revision and epoch |
| 16 retained lookup rows | Webview and Host keep the most recent sixteen results independently of page size; older lookup references expire together |

Active filesystem I/O and synchronous work are cooperative, not preemptible.
There is no Promise-race success receipt that leaves a native scan publishing
later. The portable engine reader is the implementation; optional native code
is not required. Microsecond lookup and millisecond cancellation latency have
not been measured or promised.

`LINEAGE_LOOKUP_RESULT` echoes the source reference, relation and profile
revision. It reports a physical `[startOrdinal, endOrdinalExclusive)` window,
examined record/content-byte counters, precharged requested bytes and whether
the window was fully inspected. Its statuses are:

- `found`: exactly one supported candidate in the fully checked window;
  carries its Host-issued `RowProjection` and exact `RecordRef`.
- `not-observed`: no candidate in that fully checked window; other source
  regions remain unchecked.
- `ambiguous`: multiple supported candidates; no match is published.
- `budget-exceeded` / `timed-out`: incomplete window; no candidate or absence
  result is published, even if a candidate appeared before the stop.
- `stale` / `unavailable`: source observation or capability/read failure;
  no match is published. An absent adapter is unavailable, never not-observed.

Malformed, oversized or otherwise uninspectable records leave the window
incomplete. User cancellation sends existing `CANCEL`; cancelled/superseded
requests publish neither a match nor a fabricated zero-work result. Switching
detail tab, selecting another record, closing the drawer or replacing the page
cancels the UI's pending request. Source/profile changes clear retained results.
Both Host and Webview reject late replies.

## Rail and navigation

The selected record remains a full card on the vertical rail. Exact Claude
attachment/source-subtype evidence allows unbranched metadata to become badges
on the observed chain. A badge retains its own reference and opens a bounded
preview; selected metadata and branch junctions remain cards. OTLP log context
may be a span badge, with error logs kept visible. Collapsing the presentation
does not remove the underlying edges or coverage evidence.

Tool siblings with an observed shared parent can expand in place in a vertical
list capped at 280 px. The UI never calls this proof of parallel execution.
Single click previews locally. Enter/double-click or Locate explicitly requests
table positioning. Full detail uses the existing exact-reference request.
Off-page table positioning retains predicates and visibly uses existing
physical ascending reveal order; a filtered-out target stays unobserved in the
table. Focus acknowledgement is described as focus, not renderer acceptance.
Return history is bounded to sixteen physical refs and invalidates with source
or profile changes. The topology dialog shows the same at-most-fifteen observed
nodes without additional reads or asynchronous layout.

## Validation and rollback

Focused tests cover source evidence, metadata selection/forks, duplicate IDs,
trace isolation, log context, exact reference validation, rejected delivery,
quota/incomplete scans, source edits, cancellation, supersession and late
profile results. Engine tests verify real precharged read requests, including
failed reads. Session integration uses synthetic JSONL and verifies unchanged
source hashes. Product type, architecture, contract, docs, lint, full test and
build checks remain mandatory. A browser fixture cannot stand in for real VS
Code Webview acceptance; record those evidence levels separately.

Rollback removes the lookup controls/contracts/use case and restores the
page-only view. It never rewrites source bytes, installs a daemon, changes user
settings, or depends on validation artifacts at runtime.
