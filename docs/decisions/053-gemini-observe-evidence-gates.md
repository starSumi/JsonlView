# ADR-053: Observation And Evidence Gates

Status: accepted

## Context

The Gemini observation notes propose Prometheus and Grafana dashboards,
adaptive Rust backpressure, child-process concurrency probes, packed storage,
Roaring bitmaps, SIMD, and checkpoint control loops. JsonlView currently has a
TypeScript host, a SQLite catalog projection, and a bounded native query crate.
It does not have an owned metrics exporter, a Grafana runtime, or a Rust catalog
writer. Adding those surfaces without a measured bottleneck would create a
second control plane and make rollback harder.

## Decision

Adopt the observation notes that map to existing contracts: bounded provider
work, single-flight probes, source epochs and cancellation, typed provider
policies, catalog generation/fingerprint CAS, transaction rollback, and a
rebuildable projection. The host remains the owner of source authorization,
epoch coordination, and user-visible status. SQLite remains the single catalog
publication boundary.

Treat adaptive checkpointing, Roaring or SIMD indexes, packed BLOB pages,
Prometheus or Grafana configuration, and Rust catalog persistence as
evidence-gated work. They may enter implementation only with all of the
following: a representative workload, a named runtime owner, a versioned
metric or protocol schema, differential correctness tests, a rollback path, and
an observed cost that dominates the current implementation. A dashboard file
without an exporter is not telemetry, and a benchmark proposal is not a
performance result.

## Measurement Contract

Before reopening a deferred lane, record provider inventory count, discovery
duration, metadata bytes read, first-page duration, continuation conflicts,
source cancellations, catalog commit failures, and retained-row counts. Keep
raw local audit records separate from any bounded trend projection. Do not add
high-cardinality paths, prompt text, source bodies, or credentials to metrics.

## Validation

The current regression suite proves the adopted host and catalog behavior. A
future native or telemetry implementation must add portable and fallback
fixtures, failure injection at the transaction boundary, and a measured
comparison against the TypeScript/SQLite baseline before it can change the
publication architecture.

## Rollback

Remove the experimental observer or native adapter and retain the existing
bounded host and SQLite projection. Because no deferred runtime is enabled by
this decision, rollback does not require data migration or dashboard cleanup.
