# ADR-027: Synthetic Staged-Mutation Benchmark and Failure Replay

Status: experimental

## Pressure

The staged mutation proposal needs measurable evidence before any PieceTree,
LSM, export, or original-file replacement work is considered. Real agent logs,
private stores, and user files would make a benchmark irreproducible and blur
the read-only source boundary.

## Invariant

- The benchmark uses deterministic in-memory bytes only; it does not open,
  write, watch, or replace a real file and it does not start VS Code, MCP, or a
  provider process.
- The source snapshot remains unchanged after every stage or rejected replay.
- Candidate materialization is checked against an independent byte oracle.
- Required corpus sizes are exactly 64 KiB and 1 MiB. Each case reports sample
  count, p50, p95, max, source/candidate digests, and oracle agreement.
- Failure receipts are deterministic and include expected/observed error,
  source digest before/after, and staging generation. A wrong failure fails the
  replay gate.

## Owner

scripts/benchmark-staged-mutation-runner.ts owns the synthetic corpus,
independent oracle, benchmark aggregation, and failure replay. It imports the
actual experimental/staged-mutation/index.ts coordinator. The wrapper only
bundles this runner into a temporary process; it does not change source bytes.
Product mutation coordination, provider adapters, harness acceptance, and any
future transport have separate owners.

## Decision

Use the real phase 2 coordinator over an immutable base byte snapshot with
ordered, non-overlapping base-coordinate delta intervals. The benchmark warms
up five iterations and records 31 measured iterations by default. Percentiles
use linear interpolation over sorted samples. Machine timings are observations,
not performance promises; reports are gate inputs for a later implementation
choice.

The independent oracle walks the base bytes and applies the same requested
intervals without sharing the coordinator's materialization path. A benchmark
case is valid only when coordinator and oracle digests match.

## Failure replay

Synthetic replay covers stale source generation, base digest mismatch,
overlapping ranges, idempotency mismatch, cancellation, and an authority fence
held after an unknown-commit simulation. Each case must be rejected with its
declared code. The source digest must remain unchanged; an unknown commit is
represented by sourceUnchanged: "unknown" in the coordinator receipt and is
not silently treated as a successful write. Crash-after-replacement behavior
remains a separate recovery experiment under ADR-025.

## Evidence

- ADR-025 experimental staged mutation and local agent navigation
- https://nodejs.org/api/buffer.html
- https://nodejs.org/api/crypto.html

## Boundary and rollback

This decision adds benchmark code and synthetic tests only. It does not add a
runtime mutation path, a source adapter, a database, an MCP server, a VS Code
contribution, or release permission. Remove this wrapper, runner, test, and ADR
to roll back; no source file or published artifact is changed.
