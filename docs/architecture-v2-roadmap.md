# JsonlView V2 Architecture Roadmap

Status: accepted planning boundary

This document translates the architecture notes reviewed by the team into
product-owned rules. The notes are design inputs, not runtime dependencies.
The source JSONL bytes remain authoritative, the shipped viewer remains
read-only by default, and every experimental capability must earn promotion
through a contract, failure, resource, and rollback gate.

## Four planes

| Plane | Product owner | Current contract | V2 direction |
| --- | --- | --- | --- |
| Physical fact | `src/engine/`, `native/jsonl-core/` | bounded byte reads, newline offsets, portable fallback | two-level sparse indexes only after measured end-to-end wins |
| Control | `src/extension/`, `src/application/`, navigator | generations, cancellation, typed RPC, source permissions | CQRS-shaped command/query ports; no second store or replay log |
| Projection | `src/profiles/`, `src/webview/` | one physical row to bounded semantic projection | common content blocks and virtualized views with stable physical anchors |
| Agentic boundary | `src/experimental/`, future MCP facade | opt-in read-only navigation and staged mutation contracts | read-only MCP first, then preview-only staging, then independent security review |

The planes are orthogonal. A profile may describe a row but cannot read files;
the Webview may render a projection but cannot mutate a source; an MCP caller
may request a bounded snapshot but cannot bypass the host coordinator.

## Delivery stages

1. **P0 contract freeze**: keep physical offsets, generation identity, bounded
   hydration, and unknown-record visibility stable. Add conformance fixtures for
   generic agent envelopes, malformed tails, tool correlation, and redaction.
2. **P1 sparse read acceleration**: evaluate two-level sparse segments and
   absolute cursors against the portable engine. A native candidate must prove
   offset equivalence, cancellation, memory bounds, and a repeatable
   end-to-end win before selection.
3. **P2 read-only control plane**: finish metadata-only provider adapters and
   bounded navigator queries. Keep provider databases read-only and discovery
   opt-in.
4. **P3 staged mutation experiment**: immutable base plus bounded delta
   intervals, diff preview, authority lock, idempotency, stale-generation
   rejection, and crash reconciliation. No original-file replacement is implied.
5. **P4 read-only MCP**: expose bounded list/get/read/search calls over the same
   snapshot and catalog contracts. Enforce source allowlists, output caps,
   cancellation, redaction, and opaque identifiers.
6. **P5 measured extensions**: consider Roaring-style indexes, PieceTree/LSM
   staging, DuckDB/ONNX sidecars, or source commits only with a separate ADR,
   benchmark corpus, threat review, and rollback receipt.

## Non-goals and hypotheses

Memory mapping, zero-copy IPC, lock-free scheduling, CSS Custom Highlight,
Roaring bitmaps, PieceTree, DuckDB, ONNX, and 120 FPS are hypotheses or
implementation options. They are not current product promises. A benchmark must
measure p50/p95 latency, peak RSS, cancellation latency, frame time, bytes
copied, malformed-input behavior, and recovery before any claim is promoted.

The current JSONL viewer does not become a microservice, BFF, event-sourced
database, or mandatory MCP host. CQRS is used as a responsibility vocabulary:
commands cross an explicit host boundary and queries read immutable snapshots.
It does not justify duplicating state or introducing a second event log.

## Input note register

The reviewed design inputs cover Rust taste and agent constraints, Webview and
TypeScript platform rules, CQRS context synchronization, perceptual SNR,
evaluation-driven development, audit/OTel separation, error degradation,
multimodal and dataset tooling, physical topology, MCP, staged PieceTree/bitmap
projection, and the architect notes on sparse indexes and V2 topology. Their
portable decisions are recorded here and in the linked ADRs; the original Vault
notes remain read-only research material.

## Acceptance and rollback

Every stage needs a clean candidate revision, focused tests, negative and
failure-injection cases, type/build checks, and an external receipt for host or
performance claims. A failed experiment is disabled and the portable read path
remains available. Rollback is a scoped revert or capability gate change; source
bytes and user-owned files are never silently rewritten.
