# Acceleration roadmap

Native code is an optional compute accelerator behind the portable TypeScript
engine. It does not own document generations, source identity, file watching,
or recovery. Every accelerated result must match the portable oracle and can be
discarded without affecting the source file.

## Ownership and fallback

| Layer | Truth owner | Native responsibility | Failure behavior |
| --- | --- | --- | --- |
| Document lifecycle | Extension TypeScript | none | rebuild a new generation |
| Snapshot identity | `JsonlFileEngine` | validate expected bounded inputs only | reject stale work |
| Record framing | `AdaptiveSegmentIndex` contract | find candidate LF positions | disable native and rescan with Node |
| JSON semantics | portable parser/profile contracts | optional selective extraction | exact portable validation or fallback |
| Query state | extension query owner | bounded scan/bitmap/sort kernels | cancel and discard candidate result |
| Webview | React state | none in the first native phase | request a bounded portable page |

The `.node` addon is optional. Missing binaries, ABI mismatch, unsupported CPU,
load failure, invalid output, or a native operation error must leave JSONL
browsing available through the Node implementation. A native process crash
cannot be caught inside the Extension Host, so the addon surface stays small,
safe Rust is preferred, buffers are bounded, and each capability can be
disabled independently.

## Phase A: newline scanning

The existing byte loop performs JavaScript work for every input byte. The first
comparison uses exactly the same chunks and segment state:

1. `Buffer.indexOf(0x0a)` as the portable native-code baseline;
2. napi-rs with `memchr` over a borrowed JavaScript buffer;
3. the previous byte loop as a correctness oracle on bounded fixtures only.

The synchronous native ABI borrows the input and returns an addon-owned
`Uint32Array` page:

```text
scanLf(input, start, limit) -> Uint32Array offsets
```

Positions are relative to one input chunk and strictly increasing. When the
fixed output page fills, TypeScript resumes at the last position plus one.
TypeScript validates the ABI version, typed-array result, page length,
monotonicity, bounds, and LF bytes before adopting staged results. The addon
owns the returned page, so the Extension Host never creates one JavaScript
object per offset and never exposes a mutable JS-owned output buffer to Rust.

The portable scanner first samples line density: sparse chunks use
`Buffer.indexOf(0x0a)`, while extremely dense short-line chunks use a number
byte loop. It never creates a `bigint` for every byte. The Extension Host still
performs bounded asynchronous reads and checks cancellation between chunks and
native output windows. A synchronous native call is accepted only while its
maximum window time remains below the cancellation budget.

Native loading is lazy and experimental in v0.1. `off` never loads a `.node`
file; unsupported platforms, ABI mismatch, load/call failures, and invalid
output permanently fuse that process back to the portable scanner. A process
crash is outside this fallback boundary, so native cannot become the default
until packaged Extension Host and crash-loop gates exist.

## Phase B: text and predicate scans

Algorithms are selected by query shape, not prestige:

| Query | Candidate algorithm | Correctness step |
| --- | --- | --- |
| one case-sensitive literal | `memmem`/Two-Way implementation | repair chunk overlap and confirm record boundary |
| a small or large literal set | Aho-Corasick with its available SIMD prefilters | map matches to records and apply requested semantics |
| regular expression | `regex-automata` with explicit size/time budgets | preserve leftmost/match options from the query AST |
| structured field predicate | byte candidate prefilter when possible | parse the complete bounded record and evaluate the typed AST |
| semantic profile predicate | optional selective JSON paths | run the versioned profile projection before accepting a match |

Candidate scans may create false positives but never false negatives. Exact
typed evaluation remains the result authority. Full secondary indexes are not
built on open; repeated-query telemetry is local and opt-in before an index can
be justified.

## Phase C: result sets, sort, and aggregate

Result ordinals use an adaptive, segmented representation:

- tiny or sparse: sorted `u64` ordinals with delta-varint serialization;
- dense within a segment: a bitmap;
- mixed large sets: segment table plus a per-segment list/bitmap choice;
- never truncate ordinals to 32 bits for a whole-file result.

Roaring bitmaps are a candidate, not a default. Their compressed-set benefit
must beat sorted deltas on the actual match densities and must retain a
portable serialization version.

Stable sort first generates bounded sorted runs with `(sortKey, ordinal)` and
performs a k-way heap merge. Ordinal is the deterministic final tie-breaker.
Temporary files live under extension-owned storage, carry generation/query IDs,
and are cleaned after cancellation, failure, and startup reconciliation.

Streaming statistics use exact bounded algorithms where possible: Welford for
variance, fixed counters for known enums/severity, and bounded Space-Saving for
top values. HyperLogLog, t-digest, or KLL sketches may be added only with an
explicit approximate label, error contract, deterministic seed, and a measured
need; approximation must never silently replace exact query results.

DuckDB or DataFusion remains a separate query adapter for workloads dominated
by blocking grouping, sorting, windows, or joins. Adoption requires measured
benefit over the bounded executor, controlled temp storage, cancellation,
prepared/typed input rather than concatenated SQL, dependency and binary size
review, and agreement with the query oracle. Their ability to spill does not
mean every operator is bounded under every plan.

## Phase D: JSON parsing and I/O

`sonic-rs` is considered for repeated selective field extraction and typed
projection, where its API can skip unrelated values. It is not needed to find
line boundaries, and parser-project benchmarks from other corpora are not an
end-to-end result for this extension. Portable builds cannot use
`target-cpu=native`; any SIMD path must runtime-dispatch or retain a compatible
fallback.

Memory mapping is evaluated only after buffered/native scanning. It is never
the default for a file in Follow mode. The experiment must cover append,
truncate, same-path replacement, Windows sharing modes, remote files, mapping
window lifetime, page-fault latency, RSS accounting, cancellation, and cleanup.
A mapping is virtual address ownership, not proof of zero-copy end to end.

Apache Arrow is evaluated only if measured extension-to-Webview serialization
dominates bounded page latency. VS Code's extension `postMessage` surface does
not expose the browser transfer-list contract assumed by ordinary Worker APIs,
and Electron cannot always externalize Rust-owned buffers without copying.
The first protocol therefore continues to send small structured projection
pages.

## Phase E: rendering and format adapters

DOM virtualization remains the primary text renderer because selection,
copying, accessibility, font fallback, and theme integration are product
requirements. Canvas/WebGL/WebGPU may render a minimap, event-density strip, or
large aggregate heatmap after frame-time evidence. They do not replace the main
text table without a measured failure of the virtual DOM and an accessible DOM
fallback.

New physical formats implement the immutable record contract described in
[Format and profile boundaries](format-and-profile-boundaries.md). They do not
weaken JSONL framing. OTLP protobuf, regular trace JSON, compressed JSONL, and
multiline text logs each need their own adapter and conformance corpus.

## Adoption benchmark

Every candidate records:

- repository commit, dependency lock, Rust/Node/VS Code versions;
- Windows version, CPU model/features, RAM, storage, filesystem, free space;
- corpus generator seed/hash, bytes, records, line-size distribution, newline
  mode, malformed/oversized rate, and stable versus active-writer state;
- cold and warm cache separately, warmup policy, sample count, median, p95, max;
- first-page latency, full-index throughput, query throughput, cancellation
  latency, Extension Host/native/Webview RSS, CPU time, and output digest;
- append/truncate/replace, cancellation, invalid native output, missing addon,
  unsupported binary, and process-restart cases.

The first real corpus is the private 280,605,706-byte Codex rollout already
used for acceptance. Generated public corpora add high-record-count short lines,
long-line skew, LF/CRLF boundary splits, invalid UTF-8, no final newline, and
partial-tail append. Claims about 1 GiB, 10 GiB, or 50 GB remain unverified until
those exact sizes complete the same gate.

The 2026-08-30 win32-x64 gate used Node 24.15.0, the same stable 280,605,706-byte
snapshot, five independent processes per mode after the OS cache was warm, and
verified 27,404 records plus an identical first/last-page boundary digest on
every run. Median full-index time was 548.063 ms with native disabled, 472.353
ms in `auto` (which selected native), and 457.513 ms with native preferred.
This is a measured 13.8% to 16.5% median improvement for this corpus, not a
claim about cold storage, other CPUs, dense short-line logs, or larger files.
The standalone dense-newline benchmark is deliberately retained because the
adaptive Number loop beats the current N-API implementation on that shape.

An accelerator is enabled by `auto` only when it is faster end to end on the
representative gate, remains inside the memory/cancellation budgets, and passes
all conformance/failure tests. Otherwise it stays opt-in or is removed.

## Evidence sources

- napi-rs typed arrays and Electron copy boundary: <https://napi.rs/docs/concepts/typed-array>
- napi-rs async tasks and cancellation: <https://napi.rs/docs/concepts/async-task>
- `memchr`: <https://docs.rs/memchr/>
- Aho-Corasick implementation and design: <https://github.com/BurntSushi/aho-corasick>
- Roaring bitmap Rust implementation: <https://github.com/RoaringBitmap/roaring-rs>
- DuckDB larger-than-memory behavior: <https://duckdb.org/docs/current/guides/performance/how_to_tune_workloads>
- DataFusion memory-limited execution: <https://datafusion.apache.org/user-guide/configs.html>
- Windows file mappings: <https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-createfilemappinga>
- VS Code Webview messaging: <https://code.visualstudio.com/api/extension-guides/webview>
