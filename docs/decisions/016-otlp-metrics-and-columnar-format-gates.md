# ADR-016: OTLP Metrics Semantics and Columnar Format Gates

Status: accepted

## Pressure

The OpenTelemetry Protocol File Exporter writes JSON Lines envelopes that may
carry logs, spans, or metrics. The current semantic profile recognizes logs and
spans but leaves a metrics-only envelope in Generic JSONL. Parquet is also
proposed as a future input, although it is a columnar container with different
access and source-location semantics from line-oriented JSONL.

## Invariant

Physical framing and semantic interpretation stay separate. One file-exporter
JSON object remains one physical row even when it contains many nested metric
points. A semantic profile may project those points but cannot invent byte
offsets. A new physical adapter must preserve bounded queries, cancellation,
record identity, raw access, and malformed-input behavior without weakening
the JSONL contract.

## Owner

The JSONL engine owns physical rows, bytes, offsets, indexing, and hydration.
The OpenTelemetry profile owns bounded detection and metric projection. A future
columnar adapter owns Parquet metadata, row-group access, and stable references;
it does not own OpenTelemetry meaning.

## Alternatives

- Treat `resourceMetrics` as a separate file format: rejected because OTLP File
  Exporter already frames it as JSON Lines.
- Add a general dynamic plugin registry now: rejected because there is one
  physical adapter and no demonstrated extension ecosystem to govern.
- Decode OTLP protobuf/gRPC through the JSONL path: rejected because binary
  transport framing and versioned protobuf schemas require a separate adapter.
- Add Parquet immediately: deferred because no representative corpus or
  workload measurements establish the need and its random-access contract.

## Probe

1. Add synthetic OTLP File Exporter fixtures for resource-level, scope-level,
   gauge, sum, histogram, exponential-histogram, and summary data; include
   multiple points, missing optional fields, malformed values, and large
   attributes.
2. Recognize `resourceMetrics` with bounded quorum and project useful metric
   identity, unit, aggregation, and summary fields without flattening nested
   points into false physical rows.
3. Validate that metrics, logs, spans, mixed envelopes, and unknown signals
   retain Generic JSONL fallback and byte/row identity.
4. Revisit Parquet only with an anonymized representative corpus, concrete
   query workload, licensing/dependency review, and benchmark of first-row
   latency, projection, memory, cancellation, and random access.

## Decision

The next OpenTelemetry slice is metrics semantics on the existing JSONL
adapter; it does not add a parser dependency or alter the physical row model.
Parquet remains a separate, evidence-gated future adapter. Do not implement it
until a representative workload demonstrates that JSONL cannot meet the
product's latency or memory budget and a reader can satisfy the immutable
record contract. Keep adapter dispatch as a small typed static boundary; add no
runtime plugin loader until at least two independently maintained physical
adapters create real registration pressure.

## Evidence

- The [OpenTelemetry Protocol File Exporter specification](https://opentelemetry.io/docs/specs/otel/protocol/file-exporter/)
  defines JSON Lines records and includes the `resourceMetrics` signal.
- The [OTLP specification](https://opentelemetry.io/docs/specs/otlp/)
  distinguishes JSON/protobuf encodings and transport protocol concerns from
  file-exporter line framing.
- The [Parquet file format](https://parquet.apache.org/docs/file-format/)
  defines row groups and column chunks rather than line-oriented records.
- `docs/format-and-profile-boundaries.md` defines the immutable physical-row
  contract; `docs/acceleration-roadmap.md` defines benchmark and cancellation
  gates.
- `unknown`: real user demand, representative Parquet workloads, and whether
  those workloads outperform a purpose-built JSONL path.

## Boundary

This decision authorizes fixtures, metrics-profile work, and architecture
probes. It does not authorize OTLP protobuf/gRPC capture, Parquet dependencies,
dynamic plugins, large-file claims, or public release. The `inventory` crate,
JavaScript package export maps, and VS Code contribution manifests are not
format-adapter registries; choose a registry contract only when concrete
adapter count and discovery needs justify one.

## Revisit Trigger

Implement the metrics slice when the fixture matrix and profile tests are
ready. Reopen the Parquet decision only when an anonymized corpus, query
workload, projected API, resource budget, dependency/license review, and
measurable acceptance target are available. Revisit static registry shape
when at least two physical adapters require the same dispatch contract.

## Rollback

Metrics detection is additive and must fall back to Generic JSONL for unknown or
malformed envelopes; revert only the profile projection if it changes physical
row identity or exceeds bounded work. Keep any future Parquet adapter behind
its own feature boundary and remove it independently if conformance, memory,
cancellation, or benchmark gates fail.
