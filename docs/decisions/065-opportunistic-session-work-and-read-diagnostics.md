---
id: "065-opportunistic-session-work-and-read-diagnostics"
path: "docs/decisions/065-opportunistic-session-work-and-read-diagnostics.md"
title: "Opportunistic Session Work and Read Diagnostics"
kind: "decision"
status: "accepted"
owner: "product"
tags: ["concurrency","engine","performance","observability","profiles"]
evidence: []
revisit: "when measured foreground queue delay, optional-work completion, or storage workloads change"
rollback: "restore the prior session routing and Insights loop, revert read diagnostic plumbing together, and rerun the focused suites"
---
# ADR-065: Opportunistic Session Work and Read Diagnostics

Status: accepted. This extends ADR-058's task classification and ADR-034's local
query diagnostics. It does not supersede their serialized ownership or timing
boundaries.

## Pressure

The engine already has interactive and background FIFO queues, but optional
profile inspection and Insights pages previously used interactive dispatch.
Profile detection may inspect 32 head records, 32 tail records and three
eight-record strata. Successful head-only detection could be repeated after
each visible page while indexing remained incomplete. Insights requests 500
matching rows per page; a sparse predicate could consume the whole query scan
budget in one non-preemptive operation before finding those matches.

The default Insights budget remains 100,000 examined records, 64 MiB and five
seconds, with the existing validated overrides. These are query budgets, not a
foreground response-time guarantee. A slow filesystem call can keep any active
serialized operation pending.

## Invariant and owner

`JsonlFileEngine` owns admission, queue bounds and dispatch. It runs one
operation at a time on its file handle. Foreground FIFO order, source snapshot
guards, cancellation checks and operation names remain intact. Priority selects
the next queued operation; it never preempts an active operation.

`IntegratedJsonlSession` owns task classification and current profile
publication. `runInsightQuery` owns whole-query accounting and continuations.
The common `readFileHandle` helper owns optional per-read measurement. The
application timing port, controller and observability contract own metadata
delivery; none of these values enters the ROWS protocol payload.

## Decision

Provide explicit background row-query and inspection entry points over the
existing executor. Route optional profile probes and each Insights page through
them. Keep ordinary rows, details, problems, schema and source refresh work in
the interactive queue. Background work can wait while interactive work keeps
arriving and resumes when that queue drains; it has no completion-time SLA.
Each profile sample is a separate operation and retains its abort and source
generation checks.

Remember a successful head detection only after the existing current-source
and current-profile publication gates pass. Repeated visible pages on that
unchanged generation do not repeat it. Index completion still permits the
tail/strata pass, stale results still request a current retry, and a rebuild's
new generation remains eligible. Preserve terminal detection handling.

Cap an Insights slice at 500 examined physical records, rather than only 500
matches. Continue from its physical cursor after an internal record-limit
boundary while the global record budget remains. Keep the original absolute
deadline and remaining byte budget across slices. Byte, deadline, hydration,
uninspectable-record and global-record truncation remain terminal. Preserve
unknown-record coverage when a slice boundary and an uninspectable record
coincide. Carry uninspectable provenance across internal slices, keep scanning
later in-budget records for useful matches, and mark coverage bounded when the
scan reaches a real terminal boundary. A smaller slice must never turn bounded
evidence into complete coverage. Reject a continuation that makes no physical
progress.

Add an optional all-or-none local diagnostic group alongside existing complete
timing receipts:

| Attribute | Meaning |
| --- | --- |
| `read_calls` | Number of completed read attempts, including EOF and rejected attempts |
| `read_bytes` | Sum of bytes returned successfully by those reads; a rejected attempt adds zero |
| `read_max_wait_ms` | Longest individual read-Promise wait, including a rejected attempt |

Collect these counters only when timing is requested, at the common I/O helper,
and saturate numeric results to nonnegative safe integers. Fingerprint, index
and record reads count once per attempt; repeated reads count again. Bytes do
not mean unique source coverage. Older complete timing receipts remain valid.
The query-only attribute cap accommodates 19 fixed attributes, and query logs
preserve complete validated fields within their own bounded formatter. Generic
log limits remain unchanged. CDP continues excluding engine timing; OTLP keeps
its duration and existing finite labels.

## Alternatives

- A second session counter, 200 ms quiet timer and `setImmediate` polling loop
  duplicate the scheduler's queued-work knowledge and add disposal/accounting
  failure paths. A waiter inside an active serialized operation could prevent
  the foreground task it is waiting for from running.
- Parallel handles or worker pools change resource ownership and I/O contention
  without evidence that they address the observed phase. Keep the existing
  serialized baseline until a representative workload justifies that change.
- Forcing every first page to read exactly 16 KiB would violate existing
  hydration, enrichment and record-boundary requirements. ADR-054 remains the
  authority for the narrowly eligible read window.
- Replacing parsed profile samples with regex changes semantic correctness and
  malformed-record handling. No measured evidence justifies that trade-off.

## Probe and evidence boundary

Deterministic tests hold an active read, queue bulk and interactive operations,
and assert dispatch order, foreground FIFO, progress after demand drains,
cancellation and disposal. Session tests cover head invocation counts, the
index-complete pass and retired publications. Insights tests cover sparse
predicates, whole-query caps, cursor progress and uninspectable records.
I/O and observation tests cover short reads, EOF, failures, observer exceptions,
optional-group validation, complete worst-case query logging, and unchanged
CDP/OTLP projections.

Use the same synthetic corpus and source manifests for a baseline and candidate
ordinary-engine benchmark and a controlled contention probe. Injected read
delays establish scheduler behavior under that injection; they do not reproduce
a Windows filesystem incident. Host UI acceptance and representative storage
latency require separate evidence. No 16 ms, 60 FPS, zero-inversion or specific
incident-duration claim follows from these checks.

Node.js documents that `fs/promises` operations use its thread pool off the
event-loop thread and that `FileHandle.read()` returns a Promise; this API has
no per-call abort option. A cancellation guard can stop subsequent work after
the read settles. See the official [Node.js 24 filesystem documentation](https://nodejs.org/docs/latest-v24.x/api/fs.html#promises-api).
`setImmediate` supplies an event-loop boundary, not priority or active-I/O
preemption; see the [timers documentation](https://nodejs.org/docs/latest-v24.x/api/timers.html#setimmediatecallback-args).

`read_wait_ms` remains the accumulated awaited read latency. The new counters
distinguish one concentrated wait from repeated read work; they do not identify
Defender, a filesystem lock, storage latency or thread-pool pressure. Timing
phases still overlap and must not be summed as disjoint latency buckets. The
two startup watchdogs remain lifecycle observations, separate from query read
measurements and their local correlation counters.

## Boundary and revisit trigger

This is a C3 performance/concurrency change to local scheduling and metadata.
It does not change source bytes, public format semantics, query DTOs, profile
selection authority, native acceleration or follow-recovery policy. Revisit
slice sizes or fairness only with measured foreground queue delay, read
latency, optional-work starvation, CPU, throughput and memory together. Obtain
correlated query/startup/execution-identity receipts and OS I/O evidence before
assigning a filesystem-specific cause to a reported stall.

## Rollback

Restore session calls to the ordinary engine methods, remove the head marker,
and revert the Insights slicing/continuation change together. Revert the read
observer, timing ports and observation validation/formatting as one unit. Keep
ADR-058's original background-index scheduler and source guards. Rerun engine,
session, Insights, observation and mandatory repository gates before accepting
the rollback.
