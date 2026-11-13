---
id: "034-opt-in-otlp-observability"
path: "docs/decisions/034-opt-in-otlp-observability.md"
title: "Opt-In OTLP Observability Boundary"
kind: "decision"
status: "accepted"
owner: "product"
tags: ["observability", "opt-in", "otlp"]
evidence: ["src/extension/observability/composite-observability-sink.ts", "test/extension/observability/composite-observability-sink.test.ts", "test/extension/observability/otlp-settings-manifest.test.ts", "test/extension/observability/otlp-lazy-load.test.ts"]
revisit: "before widening signals, dimensions, transport, or destination policy"
rollback: "remove the OTLP settings, composite sink integration, and SDK dependencies; retain local query diagnostics"
---
# ADR-034: Opt-In OTLP Observability Boundary

Status: accepted for the narrow query-duration metric slice below. This
supersedes the proposed exporter phases in the earlier draft; the local
GET_ROWS diagnostic contract later in this record remains in force.

## Pressure

JsonlView handles private logs and agent conversations. Outbound observability
can disclose source data and add work to query handling, so the default viewer
must retain its local-only behavior. The product already has a validated local
query event and a pure projection that can reduce a settled event to a bounded
duration metric.

## Accepted OTLP contract (C3)

- Export is disabled by default. The canonical settings are
  `jsonlView.telemetry.otlp.enabled` (boolean, default `false`) and
  `jsonlView.telemetry.otlp.endpoint` (string, default empty). Both use VS Code
  `machine` scope. The prior all-lowercase keys remain declared with
  `deprecationMessage` pointers to their canonical counterparts. That notice
  does not rewrite user settings: each value falls back to its legacy key only
  when the canonical machine `globalValue` is undefined, so explicit canonical
  `false` and an empty endpoint take precedence. Workspace and folder values
  cannot enable export or redirect its destination.
  JsonlView declares `extensionKind: ["workspace"]`, so the endpoint is intended
  to be local to the extension host, including a remote host. VS Code documents
  machine settings as user- or remote-user-scoped and not synchronized; see the
  [configuration contribution contract](https://code.visualstudio.com/api/references/contribution-points#contributes.configuration)
  and [remote extension-host model](https://code.visualstudio.com/api/advanced-topics/extension-host).
  The exact `inspect().globalValue` mapping on each remote host is not verified
  by this local source/test suite.
- The endpoint must be one canonical absolute OTLP/HTTP metrics URL ending
  exactly in `/v1/metrics`. HTTPS is accepted. HTTP is accepted only for
  `localhost`, subdomains of `.localhost`, IPv4 `127.0.0.0/8`, or IPv6 `::1`.
  Credentials, query, fragment, non-canonical URL spelling, other schemes, and
  non-loopback HTTP hosts are rejected. The pinned HTTP exporter does not follow
  redirects: a 3xx is an export failure, not a new destination.
- The only exported signal is the existing `jsonlview.query.duration` histogram
  projected from a validated `jsonlview.query.settled` GET_ROWS event. It has
  unit `ms` and only `outcome`, `delivery`, and `abort_observed` attributes.
  Started events, spans, traces, logs, request identifiers, row counts,
  source/event timestamps, source content, error details, and arbitrary
  configuration are never sent. The OTLP transformer may add protocol
  datapoint timestamps at export time; those generated times are not source
  observations.
- The resource contains only `service.name=jsonlview`; there is no host,
  process, machine, workspace, or source detector. Each activation creates a
  standalone provider and a 10-second periodic reader with a one-second export
  timeout and concurrency limit one. SDK modules and the reader timer are
  created only after explicit enablement and endpoint validation. There is no
  environment/provider endpoint fallback, global provider registration,
  auto-instrumentation, default-path timer, or default-path network request.
- The exporter constructor masks ambient `OTEL_EXPORTER_OTLP(_METRICS)_HEADERS`,
  compression, certificate, client-certificate, and client-key variables for
  its synchronous setup, then restores the host environment. This prevents a
  host-wide OTEL setting from changing the payload framing or causing an
  ambient certificate/key file read. The private agent strips all
  caller-supplied transport headers, fixes the JSON content type, and derives a
  supplied `Host` value from the validated endpoint. Integration tests inject
  credentials, `Content-Length`, `Transfer-Encoding`, `Connection`,
  `User-Agent`, and `Host` values and verify a valid content-free payload still
  arrives locally; a separate construction test sets all six certificate/key
  variables to a nonexistent path and verifies exporter creation succeeds.
- Disable or endpoint change revokes the old sink synchronously before bounded
  shutdown. The pinned exporter is given a private Node HTTP(S) `Agent` per
  instance. Revocation destroys that agent's active sockets and permanently
  rejects subsequent `createConnection` attempts, including connections the
  SDK retry transport may schedule after a transient response. Tests cover a
  blocked in-flight request, a queued `503 Retry-After` retry, endpoint change,
  disable, and disposal; after revocation those cases produce no second POST to
  the old endpoint. Bytes already received by a collector before revocation
  cannot be retracted. Exporter and shutdown failures are contained. A failed
  optional module load or exporter initialization leaves the local sink active
  and can emit one fixed, bounded warning per composite instance through its
  injected OutputChannel callback; exception text and endpoint data are not
  included. Extension deactivation awaits provider shutdown with a 1.5-second
  bound; the VS Code synchronous disposable path also initiates the same
  bounded cleanup.
- The pinned transitive `@opentelemetry/otlp-exporter-base` 0.301.0 has an
  observed retry edge for a valid `Retry-After: 0`: its `parseRetryAfterToMills`
  returns `-1`, which `retrying-transport` passes to Node `setTimeout`. A
  separate local runtime probe on Node 24.15.0 emitted
  `TimeoutNegativeWarning` and normalized the delay to 1 ms. The bounded
  local-server test intercepts that retry callback and holds it until
  revocation, then invokes it against the destroyed agent and proves it cannot
  create a second POST. That test does not observe the Node warning; production
  does not suppress or rewrite it. This is an upstream pinned-version
  limitation; review it again when upgrading rather than patching the SDK.
- The settings-change listener is registered before awaiting lazy SDK setup,
  then settings are read again after activation settles. This closes the race
  where a disable or endpoint change during module loading could otherwise be
  missed. The query hot path snapshots the active sink and returns before
  metric projection when export is disabled.

## Dependency and runtime compatibility

The exact direct pins are `@opentelemetry/api` 1.10.0,
`@opentelemetry/exporter-metrics-otlp-http` 0.301.0,
`@opentelemetry/resources` 3.1.0, and `@opentelemetry/sdk-metrics` 3.1.0.
Current installed package metadata declares Node `>=22.15.0` for the HTTP
exporter, resources, and metrics SDK; the API package declares `>=8.0.0`. The
HTTP metrics exporter is published from the OpenTelemetry JS experimental
package tree and may introduce breaking changes; it is not treated as a stable
API. See the [upstream exporter package](https://github.com/open-telemetry/opentelemetry-js/tree/main/experimental/packages/exporter-metrics-otlp-http).

The product declares `engines.vscode: ^1.136.0`. Reviewed official version
metadata maps the minimum VS Code 1.136.0 host to Electron 42.10.0 and Node
24.18.1, which satisfies the pinned package's Node engine range. The relevant
sources are [VS Code 1.136.0 Electron target](https://github.com/microsoft/vscode/blob/1.136.0/.npmrc),
[Electron 42.10.0 release metadata](https://releases.electronjs.org/release/v42.10.0),
and [Node 24.18.1 API documentation](https://nodejs.org/download/release/v24.18.1/docs/api/).
This establishes the minimum local extension-host runtime only. Remote SSH,
WSL, container, and Codespaces extension-host Node versions and the runtime
settings mapping remain unverified; source tests do not establish complete
host compatibility. On 2026-11-12 the local toolchain reported Node 24.15.0
and VS Code client 1.143.1. Those observations do not identify the Node
runtime inside the VS Code extension host. VS Code documents that the local
extension host uses Electron's bundled Node and a remote extension host uses
the Node bundled with VS Code Server, rather than the system Node; see the
[extension-host runtime model](https://code.visualstudio.com/api/advanced-topics/extension-host).
The SDK and exporter imports happen only after explicit opt-in and endpoint
validation. Their Node `>=22.15.0` package floor therefore does not establish
the minimum runtime needed for ordinary extension activation while OTLP is
disabled. Keep `engines.vscode: ^1.136.0` provisionally until the minimum VS
Code API use and the `node22` production bundle are exercised on the proposed
oldest supported host; the former package-floor argument is not a reason to
retain or lower the engine floor by itself. The lower-bound and current-client
extension-host runtimes were not exercised by this lane, the caret range's
upper support ceiling is not measured, and no remote-host compatibility claim
follows from the local observations. On an unsupported host, lazy OTLP setup
failure must leave local observability active and report one fixed warning
through the injected OutputChannel callback.

The private revocation agent uses the `Agent.addRequest` prototype hook because
the exporter has already materialized `ClientRequest` headers by that point.
This hook is present in the tested Node 24.15.0/24.18.1 matrix but is not a
documented stable Node API. JsonlView checks for the hook before delegating and
fails closed when it is unavailable or has a changed shape; it never falls back
to an unsanitized request. Node upgrades, alternate extension-host runtimes,
remote SSH/WSL/container hosts, and transport-package changes must rerun the
header, revocation, and endpoint-change tests before support is claimed.

Before upgrading any OpenTelemetry pin, review the upstream experimental
package changelog and source, verify its declared engine and transport hooks,
rerun endpoint/privacy/revocation integration tests and mandatory product
gates, and record the exact new pin. If the review or host evidence fails,
restore these four exact pins and the matching lockfile, then remove the
exporter integration while retaining local diagnostics. Do not float versions.

## Owner and change class

The extension-host composite sink owns consent enforcement, endpoint
validation, metric projection, export, and shutdown. The engine remains the
owner of source identity and operation results. The five external
Collector/Prometheus design notes supplied during implementation are
contextual proposals, not product contracts or implementation authority. This
is a C3 security, dependency, and performance boundary.

## Alternatives and superseded proposal

- Exporting raw JSONL records or diagnostic messages is rejected because the
  viewer handles private logs and agent conversations.
- Enabling an exporter from environment variables or provider defaults is
  rejected because it can silently redirect data and bypass consent.
- Instrumenting every engine byte or parser loop is rejected because the
  default path must retain its bounded cost.
- Credentials in SecretStorage, diagnostic spans, general diagnostic export,
  OTLP protobuf/gRPC capture, and a custom bounded retry queue were proposals
  in the earlier draft, not accepted features in this slice. No endpoint
  credentials or headers are configurable.

## Deferred scope

These remain unimplemented and require separate review: Collector installation
or container lifecycle; Collector pipelines and tail sampling; Prometheus
scraping or OpenMetrics presentation; exemplars and trace-to-metric
correlation; traces, spans, propagation, and logs; additional metrics or
dimensions; environment-based endpoint selection; credentials/header
configuration; and installed-host or Collector interoperability claims. The
five Vault design notes about Collector routing, exemplars, exporters,
full-statistic collection, tail filtering, and reload behavior do not widen
this decision.

## Evidence and limits

- `src/extension/observability/otlp-projection.ts` revalidates local settled-query events and
  strips them to the bounded metric shape. The composite sink is implemented in
  `src/extension/observability/composite-observability-sink.ts`.
- `test/extension/observability/composite-observability-sink.test.ts` covers disabled and
  invalid destinations, machine-scope reads, loopback endpoint validation,
  local error containment, activation/configuration races, real OTLP/HTTP and
  HTTPS payloads, redirect non-following, blocked-request cancellation,
  `503 Retry-After` revocation, endpoint change, disable, and bounded disposal.
  The HTTPS test trusts only its test certificate through that test agent; it
  does not disable TLS certificate verification globally.
- Source and test evidence does not establish fresh installed-host default
  network behavior, remote extension-host compatibility, representative
  default-path performance, packaged bundle size, or ingestion by an actual
  supported Collector. These remain explicit gates, not completed claims.
- OTLP input-profile and format separation remain described by
  [ADR-016](016-otlp-metrics-and-columnar-format-gates.md). The bounded local
  diagnostics contract below is separate from the outbound metric projection.

## Boundary and rollback

### Local GET_ROWS operation diagnostics (C2)

The existing local Output channel may record `jsonlview.query.started` and
`jsonlview.query.settled` for validated, identity-accepted GET_ROWS requests.
Each controller assigns a positive safe-integer `request_seq`; the existing
host-generated `trace` and panel `startup` counters correlate these two lines.
These are local counters, not OpenTelemetry trace/span identifiers. The
[OpenTelemetry log data model](https://github.com/open-telemetry/opentelemetry-specification/blob/main/specification/logs/data-model.md#trace-context-fields)
makes trace context optional and associates it with actual traces and spans;
these local diagnostic records have no span context or direct export. The
separate OTLP metric slice does not export them.

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
the queued operation itself. At initial acceptance, `queue_blocked_by` named
the preceding FIFO operation. With the priority lanes in ADR-058, it now names
the last queued interactive predecessor, or the active operation when no such
predecessor exists (`none` when neither exists). A background task queued
between those operations is intentionally not reported as a blocker because a
later interactive request can pass it. This is an enqueue-time scheduling fact,
not a root-cause claim. `read_wait_ms` accumulates the time awaiting
`FileHandle.read()` calls and does not identify physical disk, antivirus, or
filesystem latency by itself. `parse_ms` includes UTF-8 decode and JSON parsing.
`projection_ms` includes profile projection, predicate matching, and returned-
row projection. `snapshot_check_ms` measures the query-level pre/post
`assertSnapshotUnchanged` checks; per-chunk metadata validation performed
during indexing is included in `index_work_ms`. Both may include time also
counted by `read_wait_ms`, so phase values overlap and must not be summed as a
wall-clock breakdown. `duration_ms` remains the host-side request duration
through the ROWS post; it is not interchangeable with `engine_exec_ms`.

Measurement is explicit at the engine operations and read boundary. Direct
engine callers pay no timing accumulation cost unless they provide the timing
callback. The existing observed GET_ROWS path provides that callback so the
local terminal receipt can identify where time was spent; this measurement
introduces no timer, queue, retained context, or persisted telemetry. The
independent OTLP sink projects only the settled duration and three bounded
attributes. A query that never settles still has only its start event and no
timing receipt.

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
non-settling operation has only its start: local diagnostics add no timeout,
timer, queue, retained identity map, or setting. Sink failures are contained
and cannot change results, cancellation, or protocol messages. Cost is constant
per request, not a global log-rate bound; installed-host and performance
acceptance remain separate. Roll back the local diagnostics slice separately
without a data migration.

## Rollback

To roll back outbound telemetry, remove the two OTLP settings, the composite
sink integration and module, and the four OpenTelemetry direct dependencies
plus their lockfile entries. Preserve the existing local Output diagnostics,
input profile, and pure metric projection unless a separate review finds them
no longer useful. Outbound telemetry remains disabled by default throughout
rollback.

## Revisit trigger

Reopen this decision before changing signal types, dimensions, endpoint policy,
export interval, revocation behavior, or resource attributes, and before
claiming installed-host performance, remote-host compatibility, or Collector
interoperability.
