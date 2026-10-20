# ADR-054: Bounded Forward-Page Read Window

Status: accepted

## Pressure

After indexing, an unsorted forward page hydrates adjacent physical records
through one positional file read per record. For pages with many small records,
repeated asynchronous reads can dominate the query path. Reading a whole page
would trade that overhead for unbounded or poorly bounded read-ahead and could
change cancellation, hydration, and schema-observation behavior.

## Invariant

JSONL bytes, physical ordinals, generation identity, row parsing, and page
cursor semantics remain authoritative. Prefetched bytes are not records: they
must not advance the query, update schema observations, or cross the opened
snapshot boundary.

## Decision

Use a query-local 16 KiB positional read window only for indexed forward pages
with a limit of at least 100, when `readChunkBytes` is at least 16 KiB and the
query has no sort, predicate, enricher, hydration callback, or scan budget. A
physical record may use the window only when its content and delimiter span is
no more than half the window, so a fill can cover at least two adjacent rows.
Other pages and rows keep the existing direct-read path. Oversized-record
previews remain bounded and never use read-ahead.

The window clamps reads to the opened `fileSize`, checks the query guard before
and after cache fills and hits, and treats short reads as partial cache data.
If a requested row is not fully covered, the existing `readExactly` path
completes that row. Parsing, hydration accounting, schema observation,
lookahead, and cursor construction remain in their original order.

## Alternatives

- Buffer the entire page: rejected because it raises memory use with page size
  and complicates hydration-budget and cancellation boundaries.
- Apply read-ahead to sorted, filtered, backward, or callback-observed scans:
  rejected because those paths have different ordering, scan, or side-effect
  semantics.
- Keep a persistent cache: rejected because the benefit is local to one
  sequential query and a durable cache would add invalidation state.

## Probe

Tests compare complete `RowPage` values against forced direct hydration across
multiple window fills, and cover short reads, oversized records, configured
small read chunks, cancellation, truncation, snapshot append bounds, callback
observation, and hydration limits.

An exploratory paired run used the same benchmark runner and generated inputs
for baseline `1b1a64706b7013568f790a203700142bda7242ae` and candidate
`fcd591f9b3d8f2de3c77e3ba28330e92dc067f83`. It measured an indexed forward
page after full indexing, with five warmups and 30 timing samples; read-call
and byte counts came from a separate instrumented pass. All paired page digests
matched. The mixed-size case read more bytes even though it made fewer calls,
so read amplification remains workload-dependent.

The retained receipt is `run-jsonlview-windowed-read-20261020`,
`forward-page-read-window`, attempt 1 in the external harness. Its SHA-256 is
`a744d7f89259597cb93c4990ce194299dcc58ec6358915b2f0d8172bf94187e2`. It binds
the candidate revision and source-manifest hash, baseline revision, benchmark
runner, input hashes, commands, and aggregate results. This is synthetic
warm-cache exploration only. It does not establish representative, cold-cache,
after-append, concurrent-panel, resource-budget, or L4 acceptance. The full
preregistered workload gate remains open.

The positional-read implementation follows the Node.js v24
[FileHandle.read contract](https://nodejs.org/docs/latest-v24.x/api/fs.html#filehandlereadbuffer-offset-length-position):
non-negative positions do not mutate the current file position, bigint
positions are supported, and callers must use `bytesRead` because a read can
return fewer bytes than requested.

## Boundary

This optimization changes only eligible indexed forward-page reads. It does
not change indexing, profiles, source lifecycle, IPC, persistent storage,
reverse or sorted queries, predicates, enrichment, or user-visible page
semantics.

## Revisit trigger

Revisit when the real page-size or record-span distribution is available, when
the window changes, or when a harness run shows read amplification or a latency
regression on a supported workload. Promote performance acceptance only after
the named workload matrix, parity and failure checks, and resource limits pass.

## Rollback

Remove the `ForwardPageReadWindow` argument from page hydration and keep
`readExactly` on its existing direct-read path. No data migration or source-file
change is required.
