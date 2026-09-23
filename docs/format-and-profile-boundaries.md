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
With Follow enabled, a verified append builds the next snapshot in the
background, keeps the existing tail page rendered but non-interactive during
the short handoff, and replaces it with the new tail page in one reducer update.
This avoids an empty-table flash while preserving generation-bound byte
references. An `unknown` result enters a bounded quiet-probe recovery: it can
publish only after the old generation proves growth and the candidate remains
stable. Same-size or identity-unverifiable changes stay on the old page and
show a Rebuild prompt. Truncate, replace, and delete remain explicit lifecycle
events.

The JSON Lines format describes UTF-8, one valid JSON value per line, LF/CRLF,
and an optional final terminator. It forbids BOMs; JsonlView's BOM behavior is
deliberately tolerant, emits `NON_STANDARD_BOM`, and is not a producer
recommendation.

## Bounded query semantics

Physical pagination is cursor-based, not a promise that every filtered page can
be found within a fixed number of lines. A text or structured filter receives a
bounded allowance for examined records, bytes, and wall-clock time. When that
allowance is reached, the response carries `scan.truncatedReason`, the last
examined physical cursor, and its scan direction. The table shows a partial
result banner; the matching-direction page control continues from that cursor,
including when the current page has no rows. The opposite control keeps using
the visible page anchor so users can return without skipping records.

Sorting is a separate bounded operation. It retains only a limited logical
window after scanning and labels an incomplete scan rather than presenting a
partial order as complete. A scan-limited sorted page only exposes a Next
control when the retained logical window proves that another page exists; it
does not pretend that a fresh request can resume a global order from a physical
cursor. Sorted candidates retain only their sort key and source reference, and
the visible window is hydrated after ordering. A page-hydration allowance may
stop before a boundary candidate and return a logical continuation offset, so
the next request cannot skip that candidate. These limits are observable result
metadata, not silent truncation.

The physical `#` ordinal is an exception to field sorting. Ascending pages use
the forward record cursor, while descending pages resolve the index to EOF and
page backward from the last ordinal. This makes “latest records first” exact
without retaining a global sort window. A predicate still applies its own
bounded inspection budget, and arbitrary record/profile fields remain subject to
the bounded sort contract above.

When a predicate is active, records that are oversized, blank, malformed, or
not valid UTF-8 cannot be evaluated as a value. They are skipped for matching
but set `scan.truncatedReason: "uninspectable_record"`; the result is therefore
shown as partial rather than reported as an exact empty match.

The per-record automatic hydration cap and the aggregate page hydration cap are
independent. They can be tuned with `jsonlView.hydration.maxBytes` and
`jsonlView.hydration.pageMaxBytes`; an explicit detail request uses
`jsonlView.hydration.fullMaxBytes`. Raising any cap increases memory and parse
work, so the resulting limit remains visible in the page banner.

Problem counts have the same bounded distinction: `DocumentSummary.problemRecords`
is the number of physical records observed with at least one parse/encoding/
size problem while records have been hydrated for the current generation,
while the Webview Problems tab lists individual problem entries in the current
visible page only. A record may expose more than one entry (for example an
oversized record with a BOM), and neither value is a complete-file problem
index. Reversing the row order does not change that ownership boundary.

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

### Source-backed discovery

The reliable way to find adjacent surfaces is to study the producer's write
terminal first, then treat that result as a versioned evidence record. For
example, the Codex Rust snapshot
`openai/codex@ac192cd7937b0d73edc6dffe009940ae53782dd4` defines and serializes `HistoryEntry` to
`~/.codex/history.jsonl` and `SessionIndexEntry` to
`~/.codex/session_index.jsonl`. The producer may write the literal
`updated_at: "unknown"` when it cannot recover a time; a trusted source path
accepts that value and preserves it as derived raw data rather than fabricating
a timestamp. That source study belongs in fixtures and
decision records; the extension host does not inspect arbitrary source trees or
execute their serializers.

At runtime, JsonlView combines four bounded signals: nested field paths and
kinds, validated scalar formats, cross-record quorum/coverage, and an
ephemeral path hint. A trusted `.codex/<surface>.jsonl` locator can lower the
quorum only after the bytes pass validation. A basename or copied/renamed file
is weak evidence. Detection starts with a small head sample; once the physical
index is complete it adds a bounded newest suffix with record, byte, and time
budgets, so a late schema change is not hidden forever behind the first page
without turning tail detection into a full scan. Every physical sample,
including blank, malformed, encoding-error, and oversized rows, counts toward
coverage. When evidence is insufficient or mixed, Generic JSONL still extracts likely timestamp/actor/type/identity/summary
fields and labels them as inferred; it never silently assigns a provider
profile. This makes newly added producer surfaces visible before a dedicated
adapter exists and gives a concrete review target for the next source-backed
profile.

After indexing completes, detection also probes three bounded ordinal strata
(25%, 50%, and 75%). The extra windows are deduplicated against the head/tail
sample and are included in the registry's bounded sample cap; they reduce the
chance that a middle-only schema transition is invisible without making the
first paint wait for a full hydration pass.

Claude has three observed JSONL surfaces: the regular session transcript with
repeated `type`/`message` envelopes (per-line session and record ids are
optional), the `.claude/jobs/<job>/timeline.jsonl` export with
`at`, `state`, `detail`, and `text`, and `history.jsonl` rows with command
`display`, numeric `timestamp`, `project`, `sessionId`, and `pastedContents`.
The specialized boundaries require a bounded quorum of records and the full
observed field shape; the ambiguous timeline shape is selected automatically
only when the extension host also supplies the validated `.claude/jobs/<id>/timeline.jsonl`
locator hint. These are compatibility observations, not claims about an
official stable schema. A timeline's non-empty `text` is an explicit
Markdown-capable agent message. History display remains ordinary text, and
arbitrary application fields named `text` are not promoted to rich content.

An OpenTelemetry Protocol File Exporter line can contain `resourceLogs`,
`resourceSpans`, or `resourceMetrics` with multiple nested signal records. In
v0.1 the profile recognizes non-empty `resourceLogs` and `resourceSpans`; a
`resourceMetrics`-only envelope remains Generic JSONL. Every envelope remains
one physical row and receives a bounded summary. The viewer does not pretend
nested signals have independent source offsets.

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
