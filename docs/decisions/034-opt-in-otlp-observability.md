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
