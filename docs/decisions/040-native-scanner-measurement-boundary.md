# ADR-040: Native Scanner Measurement Boundary

Status: accepted

## Pressure

The optional napi-rs newline scanner is a cross-runtime optimization. It must
earn additional runtime, ownership, or distribution complexity with measured
end-to-end benefit. Scanner microbenchmarks alone do not establish a product
latency or memory win.

## Invariant

- JSONL bytes and the TypeScript engine remain the source and state authority.
- The native addon performs bounded, synchronous newline scanning only.
- The portable Node scanner remains a supported fallback for missing,
  incompatible, failing, or unsupported native addons.
- ABI version, capability bits, declaration shape, offset validation, and the
  process fuse remain mandatory at the native boundary.
- No native pointer or borrowed buffer may outlive the synchronous scan call.

## Probe

On 2026-10-11, the fixed synthetic `mixed-100k-384.jsonl` corpus contained
100,000 records and 47,167,597 bytes. The bounded engine benchmark ran on
Node 24.15.0, Windows x64, with the same boundary digest for both modes:

| Mode | First page | Full index | Peak RSS |
| --- | ---: | ---: | ---: |
| Node scanner | 24.363 ms | 115.471 ms | 98,598,912 bytes |
| Native auto | 93.148 ms | 120.862 ms | 88,109,056 bytes |

Native calibration selected the native scanner for its bounded scan samples,
but the end-to-end first page was slower and the full index was not faster.
The measurement is a single-host synthetic baseline; it is not a cross-platform
or customer workload claim. The immutable benchmark record belongs in the
JsonlView harness, not in the release surface.

## Decision

Keep the optional native scanner and portable fallback. Do not introduce
zero-copy buffers, mmap, Tokio/Rayon, ThreadsafeFunction, or a new native worker
topology on the basis of this result. Maintain the current bounded scan quantum
and validate native parity before accepting any native result.

Before expanding the native boundary, capture repeatable first-page, full-index,
RSS, GC, cancellation, and fallback measurements on the target host. A new
topology needs a demonstrated event-loop stall, copy/GC bottleneck, long-lived
native task, or an independently owned second consumer.

## Boundary and rollback

This decision does not authorize a package split, cross-platform VSIX matrix,
Rust workspace, or public performance claim. Revert an optimization by
disabling the native setting or removing the native candidate; the Node scanner
and engine contract remain the rollback path.

## Revisit trigger

Revisit when a stable multi-host corpus shows a material end-to-end win after
including calibration, projection, memory, and fallback costs, or when a second
native consumer creates a real pure-core/N-API ownership boundary.
