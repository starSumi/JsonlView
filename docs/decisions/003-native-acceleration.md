# ADR-003: Native Acceleration

Status: accepted, experimental

## Pressure

Line-boundary scanning can consume substantial CPU on large local files, while
the portable TypeScript implementation must remain available on every host.

## Invariant

Native code is an optional accelerator, never the source or lifecycle authority.
Its output must match the portable oracle and can be discarded without data
loss.

## Owner

`src/engine/newline-scanner.ts` owns selection, validation, and fallback.
`native/jsonl-core/` owns only the bounded scan primitive.

## Alternatives

- Make native mandatory: rejected because platform coverage and crash recovery
  are incomplete.
- Use WASM for the same hot path: deferred because startup and bridge costs are
  not yet shown to beat the synchronous native/Node candidates.
- Add a durable database: deferred because first-page work does not need one.

## Probe

Use synthetic corpora with sparse, dense, CRLF, split-chunk, malformed, and
boundary-heavy lines. Compare output digests, throughput, cancellation latency,
memory, and failure fallback against the Node oracle.

## Decision

Keep native loading lazy and opt-in/auto-calibrated. Validate ABI, capability,
bounds, ordering, and LF bytes; permanently fuse packaged/default scanner
instances in the process to Node after any load, call, or output failure.
Injected bindings remain instance-scoped so differential tests and embedders
can exercise independent candidates without contaminating the process latch.

## Evidence

`docs/acceleration-roadmap.md`, native Rust tests, scanner differential tests,
and harness benchmark artifacts.

## Boundary

The packaged native matrix is narrower than the portable engine. A native
process crash cannot be caught by JavaScript fallback, so the default remains
portable until packaged crash-loop evidence exists.

## Revisit Trigger

Revisit after cross-platform artifacts, crash-loop tests, or a measured end-to-
end regression makes the current scanner choice no longer adequate.

## Rollback

Set `jsonlView.native.newlineScanner` to `off` and ship the unchanged Node path.
