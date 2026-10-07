# ADR-027: Synthetic Staged-Mutation Benchmark and Failure Replay

Status: experimental

## Pressure

The staged mutation proposal needs measurable evidence before any PieceTree,
LSM, export, or original-file replacement work is considered. Real agent logs,
private stores, and user files would make a benchmark irreproducible and blur
the read-only source boundary.

## Invariant

- The benchmark uses deterministic in-memory bytes only; it does not open,
  write, watch, or replace a source file and it does not start VS Code, MCP, or
  a provider process. The optional `--out` argument is report output only and
  is guarded to `JsonlView-harness/state/runs`; it cannot target product source
  or an arbitrary filesystem location.
- The source snapshot remains unchanged after every stage or rejected replay.
- Candidate materialization is checked against an independent byte oracle.
- Required corpus sizes are exactly 64 KiB and 1 MiB. Each case reports sample
  count, p50, p95, max, source/candidate digests, oracle agreement, accounted
  bytes copied, and a plain-copy baseline.
- Synthetic newline fixtures cover CRLF, mixed newline, and a partial tail; the
  detected mode and partial-tail flag are report evidence, not parser claims.
- Failure receipts are deterministic and include expected/observed error,
  source digest before/after, staging generation, cancellation latency for the
  pre-aborted signal, and unknown-commit receipt provenance/timing. A wrong
  failure or changed source digest fails the replay gate.
- RSS is sampled only before and after the cases and is therefore marked
  partial; cancellation is measured only for a pre-aborted signal and is also
  marked partial.

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
case is valid only when coordinator and oracle digests match. The candidate
copy count is an explicit accounting of the current coordinator's stage and
materialize copies, while the plain baseline copies the immutable bytes once;
neither is a claim about hardware memory traffic.

The report includes a plain-copy baseline because small in-memory cases can be
dominated by V8 warmup, allocator or garbage-collection state, scheduler
contention, and timer resolution. An apparent inversion where 64 KiB is slower
than 1 MiB is therefore retained as a partial machine observation; it is not a
performance ranking or a release threshold. Controlled repetitions and an
asynchronous adapter are required before making such a claim.

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
to roll back; no source file or published artifact is changed. Report output is
optional harness evidence under `JsonlView-harness/state/runs` and is not a
product artifact.
