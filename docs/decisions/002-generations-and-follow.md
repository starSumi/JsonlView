# ADR-002: Generations And Follow Handoff

Status: accepted

## Pressure

Codex, Claude, and application logs may be written while they are being read.
In-place mutation would make byte references and Webview rows disagree.

## Invariant

Every public reference, request, and response belongs to one source identity and
generation. An old usable page remains visible until a verified new generation
is ready.

## Owner

`src/extension/` owns lifecycle and message delivery. `src/engine/` owns
snapshot identity and bounded refresh classification. The Webview owns only
rendered state.

## Alternatives

- Clear and reload on every file event: rejected because it causes flicker and
  exposes empty intermediate state.
- Extend old references in place: rejected because offsets become ambiguous
  after append, truncate, or rewrite.

## Probe

Exercise pure append, partial-tail append, truncate, same-size rewrite, replace,
delete, cancellation, and stale response delivery. Verify old references are
either retained for the old snapshot or rejected explicitly.

## Decision

Debounce filesystem hints, classify the current source, build a new snapshot
in the background, and atomically publish it. Truncate, replace, and delete
advance lifecycle state instead of inheriting append semantics. Append
classification is a proof, not a watcher guess: the engine keeps a full
SHA-256 digest of the original byte range. Small files establish that digest
before the engine is returned; large files defer the O(n) digest until an exact
refresh or snapshot guard needs it, so first-page work is not gated by a cold
full-file read. If a write overlaps that baseline, the result is `unknown` and
bounded Follow recovery waits for two quiet, same-identity, growing probes.
When the old generation has an exact baseline, recovery additionally proves
append/unchanged before adoption. When a large generation never obtained that
baseline, recovery does not claim append semantics: it opens a new generation
as a full stable resync, checks that candidate for a quiet unchanged snapshot,
and publishes it atomically only after those checks pass. Same-size or
non-growing changes stop with a Rebuild prompt. The old engine is latched after
a confirmed content mismatch so staged offsets cannot be reused.

The versioned IPC envelope also carries an optional monotonic lifecycle epoch.
Epoch-bearing `OPENED` messages are accepted only when they are newer than the
current epoch (or the same epoch and generation); other responses must match the
active epoch. Legacy envelopes without an epoch remain generation-bound for
backward compatibility.

## Evidence

`src/engine/jsonl-engine.ts`, `src/extension/` controllers, follow policy tests,
and the harness operations report. The full-range proof is deliberately
conservative: a positional file handle is not an immutable filesystem
snapshot, so a moving writer is never silently treated as append-only. The
large-file stable-resync path is explicitly a replacement snapshot, not an
append claim; metadata races that cannot be reconciled remain `unknown`.

## Boundary

An active writer can leave a syntactically incomplete final line. The viewer
reports the observed snapshot and does not join arbitrary physical lines.
When the baseline proof overlaps that writer, Follow pauses at `unknown` and
retains the last rendered generation until a bounded stable resync (or an
explicit Rebuild) is available; the coordinator is bounded by a retry/time
budget. It does not claim continuous append tracking during an unbounded write
burst or silently reinterpret a same-size rewrite as append.

## Revisit Trigger

Revisit when a new storage backend, multi-panel coordinator, or durable index
changes the owner of generations or pending work.

## Rollback

Turn Follow off and rebuild explicitly. The previous generation remains a valid
read-only fallback until the lifecycle owner disposes it.
