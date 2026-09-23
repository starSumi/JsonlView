# ADR-007: Source-Backed Format Discovery

Status: accepted

## Pressure

Provider logs keep gaining adjacent JSONL surfaces. A hand-written list of
filenames or one-field aliases will either miss a surface (`history.jsonl`,
`session_index.jsonl`) or promote an unrelated application record with the same
field names. Producer source is useful evidence, but the viewer cannot safely
read arbitrary producer repositories at runtime.

## Invariant

Automatic profile selection is evidence-based and reversible. A source locator
is only an ephemeral hint; the record bytes must satisfy the corresponding
shape contract. Unknown or mixed input stays visible through Generic JSONL,
which may expose bounded inferred signals but never claims a provider schema.

## Owner

`src/profiles/shape-discovery.ts` owns bounded structural discovery and source
surface hints. Provider profiles own their validated contracts and projections.
`src/extension/integrated-session.ts` owns the bounded sample window. Producer
source studies and redacted fixtures live outside the product checkout.

## Alternatives

- Match only filenames: rejected because copied/renamed files and collisions
  make names weak identity evidence.
- Inspect producer source or execute serializers from the extension host:
  rejected because it adds an unsafe, unavailable, and version-coupled runtime
  dependency.
- Keep adding aliases to each profile: rejected because nested envelopes and
  adjacent surfaces would continue to drift.
- Force every unknown record into a guessed profile: rejected because a false
  semantic label is harder to recover from than an explicit Generic row.

## Probe

Use source-confirmed redacted fixtures and adversarial lookalikes. Verify path
strength, structural quorum, timestamp units, mixed-file rejection, generic
fallback, bounded traversal, and evidence paths. A focused profile test must
pass with the same records under a renamed path before a path hint is considered
non-essential evidence.

## Decision

Use a two-stage discovery chain:

1. A maintained source-evidence catalog records serializer facts, path shapes,
   and required fields from pinned producer source. It is development evidence,
   not a runtime dependency.
2. Runtime detection computes a bounded structural fingerprint (nested paths,
   kinds, and scalar candidates), then combines validated profile contracts with
   a quorum and coverage rule. The sample is physical: blank, malformed,
   encoding-error, and oversized rows remain in its denominator. Trusted
   producer locators lower the quorum only after content validation; basenames
   remain weak. Generic projection uses the same signal extractor to show likely
   timestamp, actor, type, identity, and summary fields without changing
   physical records.

For the Codex source snapshot `ac192cd7937b0d73edc6dffe009940ae53782dd4`,
`history.jsonl` is the serialized
`HistoryEntry { session_id: String, ts: u64, text: String }` surface and
`session_index.jsonl` is the serialized `SessionIndexEntry { id: ThreadId,
thread_name: String, updated_at: String }` surface. Their profiles require
strict Unix-second/RFC3339 validation; the source-backed session-index path also
accepts the producer's literal `updated_at: "unknown"` fallback and preserves
it as raw derived data. Without a trusted `.codex` path they
require four consistent, UUID-like records and high coverage. This is a local
source-compatible observation, not an official promise about future versions.

## Evidence

- Codex source snapshot `openai/codex@ac192cd7937b0d73edc6dffe009940ae53782dd4`:
  `codex-rs/message-history/src/lib.rs` schema and `serde_json::to_string`
  write path; `codex-rs/rollout/src/session_index.rs` schema/write path; rollout
  line serialization at `codex-rs/rollout/src/recorder.rs:JsonlWriter::write_rollout_item`.
- `src/profiles/codex-auxiliary-profile.ts` and its negative/positive fixtures.
- `src/profiles/shape-discovery.ts` bounded traversal and path evidence tests.

The same pinned source review also records adjacent Codex terminals:

- `codex exec --json` writes exact `ThreadEvent` tags to stdout as one JSON
  value per line. It is content-profiled because the caller can redirect it to
  any filename (`codex-rs/exec/src/exec_events.rs:ThreadEvent`,
  `event_processor_with_jsonl_output.rs:emit`).
- Rollout trace bundles write `trace.jsonl` with a `RawTraceEvent` envelope and
  keep `manifest.json`, `payloads/`, and `state.json` beside it. The basename is
  only a weak companion hint; the envelope must validate and payload files are
  never opened implicitly (`codex-rs/rollout-trace/src/raw_event.rs`,
  `writer.rs`, `bundle.rs`). These records may contain prompts, paths, and tool
  output, so their sensitivity remains visible to the host.
- The opt-in TUI session logger and analytics capture are catalogued as
  generic-compatible telemetry, not rollout profiles. App-server stdio is also
  newline-delimited JSON, but its untagged JSON-RPC request/response contract
  is currently left generic rather than guessed as a Codex session. The
  separate `LOG_FORMAT=json` stderr stream is catalogued as a structured
  application-log surface because its `timestamp`/`level`/`fields.message`/
  `target` shape is distinct from JSON-RPC.

Run the bounded offline producer inventory against a pinned checkout with
`pnpm discover:producers -- --root <checkout> --out <external-report>`. It
records path literals, serializer/writer terminals, and `CODEX_*` controls as
candidate evidence only. A reviewer must assign each candidate a disposition
and fixture before adding runtime profile logic; the extension never scans a
producer repository.

## Boundary

This decision does not make arbitrary source checkout access, network lookup,
machine learning, or a new physical format adapter. JSONL framing remains one
physical line per record candidate. Head, stratified-middle, and tail probes
have explicit record, byte, and time budgets; a budget hit leaves the result
Generic rather than turning detection into an unbounded scan. Source catalog
updates require a new review round and fixtures; they must not silently alter
historical byte references.

## Revisit Trigger

Revisit when a producer publishes a versioned schema, a corpus shows material
false positives/negatives, or a new adjacent surface has a stable serializer
and recovery contract. Revisit the no-path quorum with measured corpus data,
not intuition.

## Rollback

Disable a specialized profile or its source hint while retaining Generic
projection and raw bytes. Removing a catalog entry must not remove an adapter or
change existing record coordinates.
