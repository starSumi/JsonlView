# Format and profile boundaries

JsonlView is an event data studio. JSONL/NDJSON is its first physical format
adapter, while semantic profiles describe what a record means. These layers
must remain independent.

```text
bytes -> format adapter -> immutable records -> semantic profile -> queries and UI
```

The format adapter owns framing, encoding, byte locations, malformed input,
append/rotation detection, and hydration. A semantic profile owns bounded
detection, columns, event projection, and relations. A profile never changes
record framing or hides an unrecognized record.

## Current JSONL contract

The current engine accepts `.jsonl` and `.ndjson` files backed by the local
filesystem. It recognizes LF and CRLF, tolerates a UTF-8 BOM for recovery, and
accepts a final record without a trailing newline. Every physical line is one
record candidate.

- Every non-blank line should contain one valid JSON value. Objects and arrays
  are common, but strings, numbers, booleans, and `null` are also valid values.
- A literal newline inside a JSON string must be escaped. Pretty-printed
  multi-line JSON is not JSONL because its physical lines are not independent
  JSON values.
- Blank lines, malformed JSON, malformed UTF-8, and oversized records remain
  visible as problems. They are not silently dropped.
- Byte offsets, record ordinals, and file sizes cross the extension boundary as
  decimal strings, so files beyond JavaScript's safe-integer range retain exact
  positions.
- JSON numbers inside hydrated values still follow JavaScript number semantics.
  Producers must encode integers beyond `2^53 - 1` as strings when exact value
  preservation matters. OTLP/JSON already requires 64-bit integer values to use
  decimal strings.
- Duplicate object keys remain present in the raw source, but JSON hydration
  follows `JSON.parse` behavior and retains only the last value. The Raw Source
  view is authoritative when duplicate-key evidence matters.
- A no-final-newline record may be a complete JSON value or an active writer's
  partial value. The viewer reports the snapshot it observed, then rebuilds a
  new generation after a verified append; it does not join arbitrary lines.

## Active writers and Follow

The engine never extends an already published record reference in place. A
filesystem event is debounced, then the current snapshot classifies the source
as unchanged, append, truncate, replacement, deletion, or unknown. A pure
append must retain the previous prefix/tail fingerprints; other mutations do
not inherit append semantics.

With Follow disabled, any change is reported and the user controls rebuild.
With Follow enabled, JsonlView builds the appended snapshot in the background,
keeps the existing tail page rendered but non-interactive during the short
handoff, and replaces it with the new tail page in one reducer update. This
avoids an empty-table flash while preserving generation-bound byte references.
Truncate, replace, and delete remain explicit lifecycle events.

The JSON Lines format describes UTF-8, one valid JSON value per line, LF/CRLF,
and an optional final terminator. It forbids BOMs; JsonlView's BOM behavior is
deliberately tolerant, emits `NON_STANDARD_BOM`, and is not a producer
recommendation.

## Semantic profiles

A profile can identify and project records from these semantic families when
they are physically stored as JSONL:

| Family | Representative semantics | Current record boundary |
| --- | --- | --- |
| Traditional software | timestamp, level, message, logger, service, request, exception | one structured log object |
| OpenTelemetry | log record, span record, trace/span IDs, severity, resource, attributes | one record or one file-exporter envelope |
| Agent sessions | session, turn, message, reasoning, tool call/result, usage | one provider event envelope |
| SWE trajectories | task, step, action, observation, patch, test, result | one trajectory event |

Detection requires multiple content signals and is bounded to a sample window.
Ambiguous data falls back to Generic JSONL. Projection preserves unknown events
as `other`; correlation is derived evidence, never source truth.

An OpenTelemetry Protocol File Exporter line can contain `resourceLogs`,
`resourceSpans`, or `resourceMetrics` with multiple nested signal records. In
v0.1 that envelope remains one physical row and receives a bounded summary. The
viewer does not pretend nested signals have independent source offsets.

## Not supported by the current adapter

| Input | Why it is different | Required adapter work |
| --- | --- | --- |
| Plain or multiline text logs | record boundaries depend on parser rules and stack-trace continuation | text-log framer with explicit dialect and recovery |
| Regular JSON object/array | records are structural children, not physical lines | streaming JSON document parser and virtual child offsets |
| Chrome Trace Event or Jaeger JSON | container schemas and event expansion differ | trace format adapter plus span/event projection |
| OTLP protobuf/gRPC capture | binary protobuf and transport framing | OTLP decoder with versioned protobuf schemas |
| `.jsonl.gz` / `.jsonl.bz2` | compressed offsets are not random-access record offsets | decompression/index layer with separate compressed and logical coordinates |
| CSV, Parquet, SQLite | different schemas and access models | dedicated mature reader per format |

Adding one of these formats must not be implemented by weakening the JSONL
framing rules. It should provide the same immutable record contract to the
query, profile, and Webview layers.

## Standards basis

- JSON Lines: <https://jsonlines.org/>
- OpenTelemetry Logs Data Model: <https://opentelemetry.io/docs/specs/otel/logs/data-model/>
- OTLP specification: <https://opentelemetry.io/docs/specs/otlp/>
- OpenTelemetry Protocol File Exporter: <https://opentelemetry.io/docs/specs/otel/protocol/file-exporter/>
