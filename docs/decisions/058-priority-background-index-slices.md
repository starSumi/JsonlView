---
id: "058-priority-background-index-slices"
path: "docs/decisions/058-priority-background-index-slices.md"
title: "Priority Scheduling For Background Index Slices"
kind: "decision"
status: "accepted"
owner: "product"
tags: ["concurrency","engine","indexing","scheduler"]
evidence: []
revisit: "when foreground queue latency, indexing delay, or supported workloads change"
rollback: "restore FIFO dispatch while retaining serialized access and bounded index slices"
---
# ADR-058: Priority Scheduling for Background Index Slices

Status: accepted

The foreground classification of optional inspection and bulk query work is
extended by [ADR-065](065-opportunistic-session-work-and-read-diagnostics.md).
The serialized execution and non-preemption invariants below remain in force.

## Pressure

The engine serializes access to one file handle. Under FIFO scheduling, an
already queued background index slice can delay a later interactive query even
though indexing is incremental. The current slice cannot be interrupted, so
the scheduler can only choose which queued task starts next.

## Invariant

The engine executes one operation at a time. Source generation guards,
cancellation, queue capacity, query cursor behavior, and source bytes remain
unchanged. Priority affects dispatch order only; it does not preempt or mutate
an active operation.

## Decision

Keep two FIFO lanes. `index_more` is background work. Query, inspection,
schema, problem, detail, explicit index completion, and `classify_refresh`
remain foreground work. When the active operation completes, dispatch the next
foreground task if one is queued; otherwise dispatch the next background task.
`classify_refresh` stays foreground because it establishes source freshness
and lifecycle state. The background lane may wait while foreground work keeps
arriving; bulk indexing is opportunistic, while queries index the ordinals they
need and disposal cancels background loops.

`queue_wait_ms` and `engine_exec_ms` retain their existing boundaries.
`queue_blocked_by` records the last queued foreground predecessor, or the
currently active operation when no foreground predecessor is queued. It does
not claim which individual filesystem or runtime condition caused the delay.

Progress observers receive the first update, updates no more frequently than
once per 100 ms, and the completion update. Observer exceptions are isolated
from indexing.

Keep the configured `readChunkBytes` fixed for each background step. An
adaptive byte budget is deferred: total step duration includes asynchronous
file I/O and does not alone measure event-loop CPU occupancy or establish a
frame-rate guarantee. Reconsider it only with representative local and remote
storage workloads measuring read wait, CPU work, throughput, foreground queue
latency, cancellation, and memory together.

## Alternatives

- Keep strict FIFO: rejected because queued background slices can precede
  interactive work.
- Preempt an active index slice: rejected because the serial operation is
  already running; cancellation and byte budgets remain its interruption
  boundaries.
- Increase slice sizes from fixed 8/16 ms thresholds: deferred because those
  values do not separate filesystem wait from JavaScript CPU work and do not
  prove a 60 FPS outcome.
- Put `classify_refresh` in the background lane: rejected because a user or
  watcher-initiated source check participates in freshness and lifecycle
  decisions.

## Probe

Engine tests hold an active index read, queue a second background loop, then
queue `classify_refresh` and `get_rows`. They assert foreground FIFO order,
that the query runs before the queued background slice, and that timing reports
the foreground predecessor. Progress tests assert throttling, completion
delivery, and observer-failure isolation. The full engine and integrated-session
suites remain the correctness oracle.

Node.js 24 documents that `setImmediate()` runs callbacks at the end of an
event-loop turn and that immediate callbacks are processed in creation order.
It provides a yield boundary between background steps; it does not change this
engine's queue policy or interrupt an active operation. See the official
[Node.js timers documentation](https://nodejs.org/docs/latest-v24.x/api/timers.html#setimmediatecallback-args).

## Boundary

This decision changes only engine queue dispatch and background progress
delivery. It does not change the query protocol, returned DTOs, source file,
foreground operation order, or serialized file-handle ownership. It makes no
throughput, latency, or frame-rate claim.

## Revisit trigger

Revisit if an interactive workload shows queue delay from a running index
slice, if background indexing remains delayed after foreground demand ends, or
when a representative storage benchmark can compare fixed and adaptive
budgets.

## Rollback

Restore FIFO selection in `SerialExecutor` and remove the progress throttle if
it causes a correctness or observability regression. Keep the existing single
executor, bounded index steps, and timing callback.
