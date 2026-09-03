# JsonlView

JsonlView is a read-only VS Code event data studio. Its first format adapter is
a bounded JSONL/NDJSON engine; semantic profiles turn records into useful views
for traditional software logs, telemetry and traces, and Agent trajectories.

It opens `.jsonl` and `.ndjson` as an optional read-only custom editor with:

- bounded byte indexing and lazy record hydration;
- virtualized table, event timeline, schema, problems, and record detail views;
- typed filtering, full-text search, forward/backward cursor pagination, and cancellation;
- direct physical-page input for large files, with BigInt-safe ordinal anchors;
- automatic semantic profile detection without changing the source record;
- collapsible JSON Tree, highlighted Pretty JSON, exact Source, on-demand full event text,
  derived semantics, and Agent content containers with Auto/Text/Markdown/JSON modes,
  and byte-boundary detail views;
- source generation tracking, stale-message rejection, manual rebuild, and follow mode;
- flicker-free tail follow that keeps the prior page visible until the verified
  append generation can replace it atomically;
- on-demand category and time-bucket Insights with cancellation and hard scan limits.

The source file remains authoritative. JsonlView never edits it, executes its
contents, or sends records over the network. File-backed resources are required
in this release.

## Product boundary

JSONL is the current physical format, not the product's semantic ceiling. A
profile may interpret one JSONL record as an application log, OTel log/span,
request event, Codex/Claude event, or software-engineering Agent step. Profiles
do not own file I/O and cannot rewrite, drop, or split the authoritative record.

Formats that are not line-delimited JSON need separate adapters. Plain or
multiline text logs, a regular JSON array/object, Chrome/Jaeger trace JSON,
OTLP protobuf, and compressed `.jsonl.gz` are not claimed as supported in
v0.1. See `docs/format-and-profile-boundaries.md` and the measured
`docs/acceleration-roadmap.md`.

Built-in semantic profiles currently cover Codex rollout, Claude Code,
vendor-neutral Agent events, software-engineering trajectories, OpenTelemetry,
traditional structured application logs, and Generic JSONL fallback. Domain
events keep their identity in the timeline (`log`, `span`, `task`, `action`,
`observation`, `patch`, `test`, and `result`); severity remains a separate
dimension.

Follow mode is opt-in. It opens the current tail page, keeps the visible rows
stable while an appended snapshot is rebuilt, and swaps to the new tail page in
one state update. Replacements, truncation, and invalid prefix changes still
advance the source generation rather than mutating old record references.

Insights is also opt-in: no aggregate scan runs during open. Entering the tab or
pressing its refresh button examines at most 100,000 physical records, 64 MiB of
logical record content, or 5 seconds per request, whichever comes first. Bounded
category/time accumulators receive only matching rows; requests are cancellable
and report examined versus matched records, truncation reason, and group overflow.

Agent message, reasoning, and tool-result text keeps its original value for
copying and can be viewed as plain text, conservative Markdown, or embedded
object/array JSON. Known Codex `item_completed -> AgentMessage -> Text` content
selects Markdown by default; tool output and ordinary log text retain Auto mode.
Auto recognizes complete JSON, parseable JSON embedded in prose,
headings/lists/quotes/tables, and fenced code; malformed or ambiguous content
stays text. Markdown HTML is never executed. Fenced Python, Shell, JS/TS, Rust,
and SQL snippets receive bounded lexical highlighting, plus per-block copy and
Wrap controls; unknown languages stay exact source. Rich parsing is bounded to
64 KiB and displays its boundary; the Text mode remains available for the full
hydrated field after an explicit `Show full` action.

## Experimental native scanner

`jsonlView.native.newlineScanner` defaults to `off`. `auto` probes the packaged
win32-x64 Rust/napi-rs scanner and keeps it only when a bounded calibration is at
least 10% faster than the adaptive Node scanner; missing, incompatible, or
invalid native output fuses back to Node. `on` prefers native but retains the
same validation and fallback. A native process crash cannot be caught by a
JavaScript fallback, which is why native is not the default in v0.1.

```powershell
pnpm benchmark:engine --file <stable.jsonl> --scanner off --no-query
pnpm benchmark:engine --file <stable.jsonl> --scanner auto --no-query
pnpm benchmark:engine --file <stable.jsonl> --scanner on --no-query
```

## Development

Generated benchmark and CDP acceptance artifacts are kept outside the source
workspace by default, under the operating system temporary directory. Set
`JSONLVIEW_ARTIFACT_DIR` to retain them in a specific external directory.

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm native:verify
pnpm package:vsix
```

The architecture and format boundary notes live in
[`docs/format-and-profile-boundaries.md`](docs/format-and-profile-boundaries.md)
and [`docs/acceleration-roadmap.md`](docs/acceleration-roadmap.md).

## Package distribution

The VSIX is the normal installation path for VS Code. The same runtime can be
prepared as `@sumi-lab/jsonl-view` for the Sumi Lab package namespace with
`pnpm package:npm`. The generated npm package is source-available under
`LICENSE.txt` and is not an open-source license grant.
