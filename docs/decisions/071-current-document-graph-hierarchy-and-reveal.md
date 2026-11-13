---
id: "071-current-document-graph-hierarchy-and-reveal"
path: "docs/decisions/071-current-document-graph-hierarchy-and-reveal.md"
title: "Current Document Graph Hierarchy and Reveal"
kind: "decision"
status: "accepted"
owner: "product"
tags: ["graph","webview","identity","profiles","security","performance"]
evidence: []
revisit: "before multi-source graph access, additional relationship semantics or asynchronous layouts"
rollback: "remove the Graph tab and internal messages, then revert this caller and tests; preserve the bounded pure model and source bytes"
---
# ADR-071: Current Document Graph Hierarchy and Reveal

## Pressure and boundary

The accepted hierarchy A interaction needs a real current-document caller for
the bounded Graph v2 model. The Host owns source access, current engine record
references, provider evidence and publication. The internal protocol/lifecycle
is C2; its source-read and scheduling boundary is C3. This does not enable an
external Graph API or cross-source access.
The hierarchy is a bounded projection of physical JSONL records, not a complete
session/subagent catalog graph. Model tests and static UI tests are separate
from installed VS Code rendering and joint user acceptance.

## Source, relationship and budget contract

`IntegratedJsonlSession.getGraphRows` dispatches `getObservedBackgroundRows`
through the same engine background FIFO as other physical pages. It reads
physical ordinals 0–99 in ascending order without table filters, with at most
100 examined records, 4 MiB examined/returned content and a 500 ms deadline
established before queueing. This opt-in port also caps total content I/O:
the sum of requested `FileHandle.read` lengths is at most 4 MiB across index
scanning, evicted exact-reference reconstruction, hydration and any read-ahead.
It precharges each request, shortens the length before issuing it, and never
refunds failed or short reads. This allowance works without timing collection;
stat calls do not count as content bytes. A cold oversized first record cannot
force a whole-source scan merely to discover its ending.

The dispatch guard checks cancellation and the absolute deadline before any
source validation, after pending stat/read calls settle, and before every
content read. It does not preempt an already active operation or filesystem
call. Consequently 500 ms is a cooperative work deadline, not a wall-clock
completion SLA. Before and after the page, the engine checks both current path
and open handle using only regular-file identity, size and nanosecond mtime/
ctime observations. Any mismatch or unobservable identity rejects with the
exported `JsonlEngineError` code `SOURCE_CHANGED`, without boundary or whole-file
fingerprint reads. `ABORTED` reports cancellation/deadline expiry;
`READ_BUDGET_EXCEEDED` reports exhausted content-read allowance. The Host maps
these into explicit unavailable/stale outcomes and publishes no nodes for an
unavailable reply; exhaustion must never become complete empty coverage.

Observed rows require a physical forward page, a positive byte allowance and an
absolute deadline. Backward pages, global sorts and sorted offsets are refused.
Ordinary `getRows`, `getBackgroundRows` and inspection snapshot-consistency
behavior is unchanged: their append/equal-length checks may still use content
fingerprints. Stat equality does not prove immutable middle bytes on a filesystem
that reports unchanged identity/timestamps, and Graph claims no stronger content
snapshot. Current source/profile identities must still match before publication.
Invalidation cancels pending Graph work and clears issued references. It never
reads a whole source into the Webview.

Moving only the deadline check ahead of ordinary snapshot validation was
rejected: a not-yet-expired queued request could still fingerprint the entire
old range after an append. Restricting only examined/returned bytes was also
insufficient: cold indexing may scan a huge no-LF record before examining its
first ref. Reusing the existing read helper's optional pre-read allowance keeps
one accounting point without changing default query semantics or the index API.
The supported Node 24.15.0 contract documents length-bounded positional reads
and has no per-read AbortSignal option; checks remain between settled calls.
See the pinned [Node FileHandle read/stat API](https://nodejs.org/download/release/v24.15.0/docs/api/fs.html).

Nodes preserve each actual engine `RecordRef`. `byteEndExclusive` is the content
end: `end-start === contentByteLength`; LF/CRLF delimiter bytes are separate.
The first production integration test exposed a delimiter-inclusive assumption
in the pure-model reference helper; it is corrected against real LF, CRLF and
no-final-ending engine output. An absent/stale reference is explicit metadata
without a reveal action. Host-generated physical node IDs are opaque and never
parsed to reconstruct a source or ordinal.

Observed parent edges require source-confidence profile evidence and the exact
known provider path pair: Claude `uuid`/`parentUuid`, or Pi `id`/`parentId`.
The target identity must be unique in the bounded prefix with matching provider,
session and turn context where supplied. Codex parent aliases can denote
different entities and are omitted. Tool-result edges currently require the
Codex `payload.call_id` projection and one call/one result in the same context.
First-tool-only projections cannot prove multi-tool uniqueness and are omitted.
Missing, ambiguous or unsupported relationship evidence increments the omitted
count; source nodes remain available. No inferred or fabricated edge is emitted.
The separately supplied Host graph context denies all cross-source edges.

## Internal wire and reveal sequence

| Direction | Type | Payload and settlement |
| --- | --- | --- |
| Webview → Host | `GET_GRAPH` | Empty closed payload; latest background page wins. |
| Host → Webview | `GRAPH` | v1 current profile identity, fixed physical-prefix scope, ready/empty/partial/stale/unauthorized/unavailable status, bounded Graph v2 model and omission counts. |
| Webview → Host | `REVEAL_GRAPH_RECORD` | Exact seven-field `ref` plus the `graphRequestId` that issued it; no path, source/native ID or authorization input. |
| Host → Webview | `GRAPH_REVEAL_RESULT` | Same graph request/ref and the existing reveal outcome, including filtered-out/not-found/stale/unauthorized/timeout. |

Every envelope retains document/generation/epoch and request correlation. The
Host retains at most 100 exact references only after its current Graph reply is
accepted by the message channel. A reveal must match that issued request,
coordinates and current source/profile grant. It reobserves the source before
calling the existing internal `revealRow` path. A Host guard rechecks the same
issued grant/profile again at the matching DOM acknowledgement. A sent message
does not mean `shown`; only the existing visible physical-row DOM acknowledgement
can produce that outcome. Cancellation or supersession cannot complete another
request. The Webview validates the bounded model and exact receipt identity.

Table activation commits before a queued reveal begins, and automatic column
and projection refreshes defer while that reveal is pending. The existing row
controller requests the physical ordinal in ascending order while retaining
current predicates, so a filtered target remains an explicit failed outcome.
This prevents a Graph-to-Table view refresh from clearing the pending locator.

## UI and evidence

The Graph tab and its left action rail expose Graph refresh, Query, Source and
Reveal. Native buttons support keyboard activation; focus selects a node for
inspection, and activation requests its real physical record. All source labels
and evidence paths use text sinks. The synchronous hierarchy pass is bounded
to 100 nodes/200 edges, terminates cycles, permits collapse, and never publishes
a delayed layout from another identity. The canvas owns horizontal scrolling;
the inspection panel moves below it in narrow windows. Missing references,
partial coverage, loading, empty, stale, unauthorized and unavailable states
are visible without rendering stale source labels.

Focused tests cover real profile evidence/indexed references, actual background
dispatch, exact source spans, source/profile/revocation publication barriers,
forged refs, closed messages, receipt identity, cycle/collapse bounds and text
escaping. These are application, transport and render-contract evidence. Real
VS Code clicks, keyboard/focus geometry, narrow-window rendering and joint user
acceptance remain separate checks. No browser library or dependency was added.

The deterministic held-queue baseline at the pre-fix source requested
12,805,688 content bytes after an append, and 12,442,144 bytes even with an
expired Graph deadline, on a 6,090,000-byte synthetic source. The regression
tests now require zero Graph content reads for both cases. Tests also hold real
FileHandle stat/read calls to check cancellation/deadline settlement, detect an
append after hydration, and preserve ordinary append-query behavior. Real-engine
read spies cover a 6 MiB no-LF first record, dense tiny records with timing off,
cross-chunk request truncation, shared index/ref-reload/hydration accounting,
short/failed reservations, and foreground FIFO/recovery after exhaustion. These
prove requested-byte and ordering bounds for the named cases, not filesystem
latency, installed UI acceptance or preemption. Revisit if any content-read path
bypasses the shared helper, new sort/direction support is added to observed rows,
or a stronger snapshot guarantee is required.

## Rollback

Remove the Graph tab and its four internal message types before reverting its
Host/UI adapters and tests. The pure model remains independently useful; source
bytes, authorization settings and Collections metadata require no migration.
