---
id: "063-bounded-mcp-stdio-work"
path: "docs/decisions/063-bounded-mcp-stdio-work.md"
title: "Bounded MCP Stdio Work and Cooperative Cancellation"
kind: "decision"
status: "accepted"
owner: "product"
tags: ["cancellation","concurrency","mcp","stdio"]
evidence: []
revisit: "when MCP stdio query transport, source reader, or default resource budget changes"
rollback: "restore the prior MCP adapter and keep stdio publication disabled until bounded query behavior is revalidated"
---
# ADR-063: Bounded MCP Stdio Work and Cooperative Cancellation

Status: accepted for the explicit read-only stdio query adapter. ADR-052 remains
the historical ownership and transport boundary; this decision narrows the
packaged stdio reader and adds bounded scheduling without changing that owner.

## Pressure

The stdio server previously admitted tool calls without a shared active-work
limit or total request deadline. Its native fast path is synchronous, so a
blocked native call prevents Node from processing `notifications/cancelled` or
running a JavaScript timeout callback.

## Invariant

The server admits at most eight active tool calls, configurable from one to
eight, and keeps at most eight more queued. The default is two active calls.
Every accepted call receives a monotonic arrival-to-finish deadline starting at
valid, allowlisted queue admission; the default is 3000 ms and the permitted
override is 1..60000 ms. Queue wait consumes that same budget. A cancelled or
expired queued call never starts query I/O. A request cancelled by the client
receives no later response. Expired work cannot return a result after its
deadline, even if synchronous work delayed the timer callback.

## Owner

`packages/mcp-server/src/mcp-read-only-server.ts` is the canonical owner of
admission, bounded queueing, request IDs, cancellation, deadlines, response
suppression, and protocol shutdown. The extension-side
`src/extension/mcp/read-only-server.ts` is a facade over the same implementation.
The package also owns the canonical stdio framing, environment limit parser,
and trajectory wire contracts; extension adapters keep source/query ownership
in JsonlView and delegate MCP protocol behavior. `src/mcp-server.ts` owns the
VSIX sidecar's source grants, product reader wiring and process entrypoint.
Native query acceleration remains available to other adapters.

## Alternatives

- Retain synchronous native reads in stdio and only drop a late result. This
  enforces the response deadline after the call returns but cannot process a
  cancellation notification or interrupt the blocked event loop.
- Add a native worker pool or subprocess protocol. That would introduce a new
  lifecycle and compatibility surface without being required for bounded
  portable scans.
- Run every call serially. The configured value of one remains available, while
  a default of two allows small bounded fan-out without unbounded I/O.

## Decision

Use a bounded server queue with `JSONLVIEW_MCP_MAX_CONCURRENCY` (default 2,
range 1..8; one serializes scans) and `JSONLVIEW_MCP_BUDGET_MS` (default 3000,
range 1..60000). Reject queue overflow before query I/O. Include queue waiting
in the total deadline, abort on timeout, recheck deadlines before query start
and result acceptance, and retain a work slot until timed-out or cancelled
underlying work actually settles. Duplicate IDs are rejected while pending.
Stopping cancels active and queued requests and permanently closes that server
instance, avoiding a restart race with old work.

The packaged stdio entrypoint opts into the asynchronous portable raw reader.
It checks cancellation at file-open and read boundaries; an individual OS read
already in flight is not forcibly interrupted. Other adapters may continue to
use synchronous native reads. The server marks cancellation as cooperative
only for a host that observes the signal. Existing JSONL scan and output caps
remain in force.

## Probe

Focused tests exercise maximum active work, bounded waiting, queue overflow,
arrival-to-finish deadline including queue wait, post-deadline native result
suppression, cancellation/timeout response handling, queued cancellation,
duplicate IDs, stop behavior, environment parsing, and service after cancelled
work. The Rust bridge tests verify that the portable option avoids the native
binding and that an already-aborted signal prevents portable file I/O. The
server test verifies signal forwarding and cancelled-response suppression; the
suite does not simulate cancellation while an operating-system read is in
progress. The portable reader's before/after-read signal checks are established
by source inspection, and observed cancellation latency within an in-flight OS
read remains unmeasured.

## Evidence

Focused Vitest results and the docs-index generator/check are recorded in the
task handoff. They establish source-level behavior for the named server and
adapter paths. They do not establish installed MCP client interoperability,
filesystem latency guarantees, or interruption inside an individual OS read.

## Boundary

This is a C2 concurrency and cancellation change for the explicitly launched
read-only stdio adapter. It does not make the Navigator MCP surface activate by
default, change the source authorization boundary, add remote access, introduce
a worker pool, or alter synchronous-native behavior for other consumers.
`docs/mcp-local-plan.md` records the current adapter behavior; ADR-052 is not
rewritten.

## Revisit trigger

Revisit the concurrency and budget defaults if measured portable scan latency,
memory use, filesystem behavior, or supported MCP client requirements change.
Revisit cancellation guarantees if the portable reader switches to a different
I/O primitive or gains an interruptible native path.

## Rollback

Revert the task-owned server, bridge, configuration, and tests together, restore
the prior MCP tool description and runbook wording, then rerun MCP focused
tests and the docs-index check. Keep the explicit stdio entrypoint disabled
until its queue and timeout boundary is restored.
