# ADR-034: Opt-In OTLP Observability Boundary

Status: proposed

## Pressure

JsonlView already reads OpenTelemetry JSONL and exposes bounded local
diagnostics, but it has no outbound telemetry path. Adding one can make source
records, workspace identity, or credentials leave the machine and can add work
to the indexing path. The default viewer must keep its current read-only and
offline behavior.

## Invariant

- Telemetry is disabled and has no exporter, queue, startup I/O, or network
  side effect until the user explicitly enables it and confirms a destination.
- Export is extension-host owned. Webviews and the JSONL source never receive
  exporter credentials or raw telemetry payloads.
- Events use a fixed allowlist of names and scalar attributes. Record bodies,
  prompts, responses, file paths, URIs, workspace names, account identifiers,
  headers, tokens, and arbitrary JSON are rejected before enqueue.
- The queue, batch bytes, event count, age, export timeout, retry budget, and
  shutdown flush are finite and observable locally. Overflow drops are counted.
- Export is read-only and cannot change source generations, indexing, query
  results, or recovery behavior.

## Owner and change class

The future extension-host observability module owns consent, schema validation,
redaction, queueing, export, and shutdown. The engine remains the owner of
source identity and operation results. The harness owns endpoint fixtures and
installed-host evidence. This is a C3 security, dependency, and performance
boundary.

## Alternatives

- Exporting raw JSONL records or diagnostic messages was rejected because the
  viewer handles private logs and agent conversations.
- Enabling an exporter from environment variables or provider defaults was
  rejected because it can silently redirect data and bypass consent.
- Adding instrumentation to every engine byte or parser loop was rejected
  because the default path must retain its current bounded cost.
- Capturing OTLP protobuf or gRPC input in the JSONL adapter was rejected;
  transport decoding is a separate adapter with separate lifecycle gates.

## Probe and phased decision

1. **Contract first.** Add a pure event allowlist and redactor with negative
   tests for source content, paths, credentials, unbounded strings, and
   oversized attributes. Keep the default implementation a no-op.
2. **Explicit export.** Add one user-selected OTLP/HTTP destination. Permit
   HTTPS or loopback HTTP only, keep credentials in VS Code SecretStorage,
   send an explicit minimal resource, and avoid host/process detectors. Cap
   request bodies below the protocol's 64 MiB recommendation. Start with
   bounded metrics and diagnostic spans; defer logs until their schema is
   reviewed.
3. **Lifecycle and host evidence.** Test finite queue and batch limits,
   cancellation, retry handling, consent changes, endpoint changes, and
   deactivation. Flush and shut down under a hard deadline. Verify from a
   fresh installed host that disabled telemetry performs no network request and
   that enabled export never contains source content. Compare default-path
   first-page and indexing measurements before and after instrumentation.

Retry behavior must follow OTLP: retry only transient `429`, `502`, `503`, and
`504` responses with a capped backoff and `Retry-After` handling; treat bad
data and partial-success responses as terminal for that batch. Export calls
must not overlap.

## Evidence

- `src/extension/otlp-projection.ts` is the contract-only projection: it accepts
  revalidated `jsonlview.query.settled` events and emits a fixed duration metric
  with finite `outcome`, `delivery`, and `abort_observed` dimensions. It omits
  request sequence, row counts, timestamps, stale reasons, error names, source
  data, and identity. Its tests enumerate the 16 schema-valid combinations
  within a maximum 32-value Cartesian product. This
  module has no SDK, exporter, queue, setting, or network behavior; explicit
  export and shutdown remain gated by the revisit conditions below.
- `src/profiles/opentelemetry-profile.ts` is an input projection only; it keeps
  one OTLP File Exporter envelope as one physical row.
- `src/extension/diagnostic-context.ts` defines the existing bounded,
  path-redacted metadata envelope.
- ADR-016 keeps OTLP metrics work on the JSONL adapter and forbids transport
  capture; ADR-020 forbids default network telemetry; ADR-033 requires
  metadata-only Webview diagnostics.
- [OTLP specification](https://opentelemetry.io/docs/specs/otlp/) defines
  signal endpoints, request limits, retries, and partial-success behavior.
- [Sensitive-data guidance](https://opentelemetry.io/docs/security/handling-sensitive-data/index.md)
  requires consent, minimization, and scrubbing.
- [Collector security guidance](https://opentelemetry.io/docs/security/config-best-practices/index.md)
  covers authentication, encryption, least privilege, and bounded queues.
- [Trace API no-SDK behavior](https://opentelemetry.io/docs/specs/otel/trace/api/index.md#behavior-of-the-api-in-the-absence-of-an-installed-sdk)
  supports a no-op default with no telemetry side effects.
- [Opt-in semantic attributes](https://opentelemetry.io/docs/specs/semconv/general/attribute-requirement-level/#opt-in)
  must not be populated by default.

## Boundary and rollback

### Local GET_ROWS operation diagnostics (C2)

The existing local Output channel may record `jsonlview.query.started` and
`jsonlview.query.settled` for validated, identity-accepted GET_ROWS requests.
Each controller assigns a positive safe-integer `request_seq`; the existing
host-generated `trace` and panel `startup` counters correlate these two lines.
These are local counters, not OpenTelemetry trace/span identifiers. The
[OpenTelemetry log data model](https://github.com/open-telemetry/opentelemetry-specification/blob/main/specification/logs/data-model.md#trace-context-fields)
makes trace context optional and associates it with actual traces and spans;
this slice has no SDK, span, propagation, or outbound telemetry.

The event attributes are limited to `stage=get_rows`, `request_seq`, and, for
the terminal, `outcome`, `delivery`, `abort_observed`, `duration_ms`, optional
`rows`, `stale_reason`, a fixed `error_name`, and the all-or-none timing bundle
`queue_wait_ms`, `engine_exec_ms`, `queue_blocked_by`, `index_work_ms`,
`read_wait_ms`, `parse_ms`, `projection_ms`, and `snapshot_check_ms`. Raw
request/document/generation identifiers, epochs, query terms, values, paths,
error messages, stacks and causes never enter these events. Error
classification reuses the descriptor-only lifecycle classifier and its fixed
name allowlist.

The timing bundle is supplied through an in-process callback on the record-page
request; it is not added to the versioned query DTO or ROWS payload. Values are
non-negative integer milliseconds from Node's monotonic high-resolution clock.
`queue_wait_ms` spans engine enqueue to task start, and `engine_exec_ms` spans
the queued operation itself. `queue_blocked_by` names the immediate prior FIFO
operation observed when this query entered the queue (`none` when no predecessor
was pending); it is a scheduling fact, not a root-cause claim. `read_wait_ms`
accumulates the time awaiting `FileHandle.read()` calls and does not identify
physical disk, antivirus, or filesystem latency by itself. `parse_ms` includes
UTF-8 decode and JSON parsing. `projection_ms` includes profile projection,
predicate matching, and returned-row projection. `snapshot_check_ms` measures
the query-level pre/post `assertSnapshotUnchanged` checks; per-chunk metadata
validation performed during indexing is included in `index_work_ms`. Both may
include time also counted by `read_wait_ms`, so phase values overlap and must
not be summed as a wall-clock breakdown. `duration_ms` remains the host-side request
duration through the ROWS post; it is not interchangeable with
`engine_exec_ms`.

Measurement is explicit at the engine operations and read boundary. Direct
engine callers pay no timing accumulation cost unless they provide the timing
callback. The existing observed GET_ROWS path provides that callback so the
local terminal receipt can identify where time was spent; no timer, exporter,
queue, retained context, or persisted telemetry is introduced. A query that
never settles still has only its existing start event and no timing receipt.

`outcome` is `completed`, `stale`, `cancelled`, or `failed`. Independently,
`delivery` describes the ROWS host post: `accepted`, `rejected`, `skipped`, or
`failed` (the post threw/rejected). Host acceptance does not prove rendering.
Cancellation or staleness after a failed post keeps `delivery=failed`.
The original identity gate records `stale_reason=document|generation|epoch`;
this is a reason, not full cross-generation trace identity. The original
aborted catch branch records cancellation; its registry does not distinguish
user cancellation, supersession, and disposal. A non-cooperative reader can
still resolve and deliver after abort under the existing controller behavior:
that remains `completed` with `abort_observed=true`. A later abort never
rewrites a delivered operation into cancellation.

There are at most two new lines per accepted request and exactly one terminal
when its existing handler settles, including late resolution/rejection. A
non-settling operation has only its start: this slice adds no timeout, timer,
queue, retained identity map, dependency, setting, or exporter. Sink failures
are contained and cannot change results, cancellation, or protocol messages.
Cost is constant per request, not a global log-rate bound; installed-host and
performance acceptance remain separate. Rollback this local slice as one
commit without a data migration.

This ADR authorizes a contract, redaction tests, and bounded host probes. It
does not authorize an exporter dependency, a persisted setting, network access,
OTLP protobuf/gRPC capture, automatic configuration, raw-log export, or public
release. Remove the future observability module and its setting to roll back;
the viewer, input profile, and local diagnostics remain usable.

## Revisit trigger

Revisit when a concrete user-owned diagnostic or performance question requires
export, an anonymized endpoint fixture exists, and default-path measurements,
privacy review, dependency review, consent UX, and shutdown evidence are
available.
