---
id: "044-data-format-ecosystem-boundary"
path: "docs/decisions/044-data-format-ecosystem-boundary.md"
title: "Data Format Ecosystem Boundary"
kind: "decision"
status: "planned"
owner: "product"
tags: ["conversion","datasets","formats","streaming"]
evidence: []
revisit: "when a format contract gains conformance evidence"
rollback: "keep JSONL authoritative and disable the adapter"
---
---
adr: "044"
status: planned
owner: product-format-boundary
scope: jsonl-dataset-ecosystem
source_of_truth: physical-jsonl-bytes
write_mode: read-only-until-explicit-staged-export
deferred_tags:
  - format-adapter
  - semantic-conversion
  - staged-write
  - benchmark-gate
  - remote-integration
---

# ADR-044: Data Format Ecosystem and Conversion Boundary

Status: planned

## Pressure

JSONL is useful both as an agent-history format and as a transport for model
training and inference examples. The surrounding ecosystem uses several
provider-specific dataset conventions and binary or columnar containers. JsonlView
needs a growth path that can inspect these shapes and eventually export useful
artifacts without turning an observed convention into a false universal schema,
or weakening the source-file contract.

## Invariant

- The source JSONL/NDJSON bytes, physical line boundaries, byte offsets, and
  malformed/oversized records remain authoritative. Indexes and conversions are
  disposable projections.
- A physical adapter emits one immutable record per source row. A nested chat,
  tool, preference, or multimodal payload may be projected, but it never receives
  invented source offsets.
- A dataset profile is a versioned logical shape (`chat`, `instruction`,
  `preference`, `tool`, or another reviewed shape), not a claim that vLLM,
  SGLang, Ollama, LLaMA-Factory, or another producer shares one stable schema.
- Conversion is explicit and loss-aware. It must report dropped fields, coercions,
  invalid rows, schema version, source identity, and output digest; it must never
  silently rewrite the input or infer a destructive mapping.

## Owner

The JSONL engine owns framing, encoding, byte coordinates, source identity, and
bounded reads. A future dataset-profile adapter owns detection and validation of
one documented shape. A future Arrow/Parquet/Protobuf adapter owns its own
container metadata and output contract. The application layer owns conversion
use-cases and cancellation. The Webview owns previews and diff/loss reports. VS
Code owns host integration, workspace trust, and editor surfaces; those platform
capabilities are not product promises for remote access, permissions, or DOM
rendering.

## Alternatives

- Treat every model ecosystem JSON object as one canonical training schema:
  rejected because producer conventions and optional fields evolve independently.
- Parse Arrow, Parquet, or Protobuf through the JSONL scanner:
  rejected because they have distinct framing, metadata, random-access, and
  schema/version contracts.
- Add source mutation or an always-on converter now: rejected because the current
  product is read-only and a write path needs staging, preconditions, rollback,
  and explicit user consent.
- Add a dynamic adapter/plugin registry immediately: deferred until multiple
  independently maintained physical adapters require common discovery and
  lifecycle governance.

## Probe

The next format slice is a read-only, synthetic corpus and contract exercise:

1. Cover JSONL/NDJSON with LF/CRLF, no final newline, BOM recovery, malformed
   UTF-8/JSON, oversized rows, nested messages, tool calls, preference pairs,
   multimodal references, and unknown fields.
2. Add profile fixtures derived from the public documentation of vLLM, SGLang,
   Ollama, and LLaMA-Factory. Pin the observed documentation URL and date in the
   fixture manifest; never use private sessions or local producer state.
3. Test a loss-aware export preview to Arrow IPC, Parquet, and Protobuf using a
   versioned schema. The preview must preserve source row identity, reject
   ambiguous mappings, and produce an independent round-trip or loss report.
4. Measure first-row latency, full scan, conversion throughput, peak RSS,
   cancellation latency, output size, and source/output digests on deterministic
   synthetic corpora. Separate cold and warm runs and retain malformed and
   long-row cases.

## Decision

Deliver the roadmap in vertical slices while keeping the shipped path read-only:

1. **Identity and discovery:** retain the JSONL adapter and add bounded,
   evidence-backed dataset shape detection with Generic JSONL fallback.
2. **Analysis:** expose schema, field coverage, invalid-row, and conversion-loss
   summaries without writing the source or pretending nested values are rows.
3. **Export-copy experiment:** add an opt-in staged export to a user-selected
   output file. Require a source snapshot, operation id, schema version, output
   digest, cancellation, and an explicit confirmation; the source remains
   unchanged.
4. **Physical adapters:** consider Arrow/Parquet/Protobuf readers or writers only
   when the probe demonstrates a concrete workload, a bounded API, dependency and
   license review, and a portable fallback. Each adapter is independently
   disableable and must match the immutable-record/query contract.

No adapter is implied by this ADR. In particular, model-serving integration,
remote server connections, permission escalation, and DOM-specific rendering
remain outside scope until separately contracted and reviewed.

### Accepted E3 runtime provenance slice

This C2 slice connects the reviewed LLaMA-Factory v1 inspector to the existing
profile detection lifecycle. It does not add a new profile or alter selected
profiles, columns, physical rows, schema, timeline, or Insights aggregation. The
extension owns task identity and publication; the profiles layer owns inspection;
the shared contract owns metadata; the Webview renders a small Profile-adjacent
head-sample status and tooltip.

The inspector receives only the prefix from the first existing detection head
`getRows` hydration: at most 32 physical records and 262144 source content bytes.
Use `RecordRef.contentByteLength` with BigInt before safely converting the admitted
size for the adapter. Never stringify a record to measure it. Stop before the
first record that exceeds either limit; do not skip it to inspect later rows.
Tail and stratum hydration remain profile evidence only. No additional dataset
scan is permitted, and disabling profile auto detection adds no reads. These are
inspection limits, not underlying I/O, hydration, allocation, or RSS limits.

The additive internal wire contract is:

```typescript
type DatasetShapeV1 = 'sft' | 'preference' | 'tool-use' | 'multimodal' | 'unknown';
type DatasetHeadPlanV1 = { strategy: 'head'; maxRecords: 32; maxBytes: 262144 };
type DatasetHeadCoverageV1 = {
  sampledRecords: number; validRecords: number; invalidRecords: number;
  examinedBytes: string; partial: boolean;
  stoppedBy?: 'record_limit' | 'byte_limit' | 'time_limit' |
    'hydration_limit' | 'uninspectable_record';
};
type DatasetResultV1 = {
  version: 1; framing: 'jsonl'; samplePlan: DatasetHeadPlanV1;
  adapterId: 'llamafactory-v1' | 'generic-jsonl'; adapterVersion: '1.0.0';
  shape: DatasetShapeV1; confidence: 'high' | 'medium' | 'none';
  clockBasis: 'none' | 'record-order'; coverage: DatasetHeadCoverageV1;
};
type DatasetRuntimeProvenanceV1 =
  | { version: 1; status: 'pending'; samplePlan: DatasetHeadPlanV1 }
  | (DatasetResultV1 & { status: 'ready' | 'partial'; fallback?: never })
  | (DatasetResultV1 & { status: 'fallback'; fallback: {
      code: 'unknown_shape' | 'conflicting_shapes' | 'invalid_sample' |
        'sample_unavailable' | 'inspection_failed';
      candidateShapes: readonly DatasetShapeV1[];
    } });
```

`DocumentSummary` adds optional `datasetProvenance` and `profileEpoch`;
`PROFILE_CHANGED` adds optional `profileEpoch`. Optionality preserves older
fixtures, while every live session summary carries a monotonic safe-integer
profile epoch from one profile-publication path. Once a Webview state has seen
an epoch, a missing or older epoch cannot downgrade it. The runtime sends an
explicit allowlist of metadata: never inspector records, raw/value fields,
free-form reasons, source paths, fingerprints, or private source metadata.
At `Number.MAX_SAFE_INTEGER`, the epoch saturates and profile publication fails
closed: explicit selection returns a controlled error without changing state,
and deferred results are not published. A successfully adopted new snapshot may
restart the profile epoch at 1 because its snapshot epoch distinguishes prior
publications. An unchanged snapshot never reuses a saturated epoch for a new
profile state.

Each asynchronous task captures engine object, document id, generation, snapshot
epoch, prefix fingerprint, profile id/version, and profile epoch. Recheck all
before publication. Profile A-to-B-to-A, cancellation, disposal, and source
replacement invalidate old work. A stale single-flight result is discarded and
current-epoch work retried; it must not leave a permanent pending state. Completed
metadata is cached only for the same source identity and synchronously rebound
by the existing profile-publication path. Rebuild candidate metadata is staged
until adoption; failed rebuilds retain the previous source and metadata.

`ready` requires a confirmed complete prefix at EOF with no truncation. Otherwise
a recognized sample is `partial`; unknown, blank, malformed, oversized, unsupported
content, and message/block-limit cases retain coverage with explicit Generic
JSONL `fallback`. An uninspectable boundary record is not admitted or counted as
an invalid admitted record; it stops the prefix and yields `invalid_sample`,
preserving `sampledRecords = validRecords + invalidRecords` and prior byte
coverage even when the first row is uninspectable. If no record can be admitted
for another reason, use `sample_unavailable`; an
inspector exception uses `inspection_failed`. Neither condition blocks viewing.
Plain `instruction/input/output`, `question/context/answer`, and `text/label`
rows are deliberately outside the reviewed LLaMA-Factory v1 shapes and therefore
use the same visible `unknown_shape` Generic JSONL fallback.

The rejected alternative is a separate dataset scan or profile-selection state
machine: it adds I/O and competing authority. Validation covers head/tail
conflict, exact record/byte boundaries, unsafe large byte counts, invalid rows,
inspection limits, deferred cancellation/rebuild/profile ABA, wire privacy,
epoch ordering, and old fixtures. Evidence is L2 until a real VS Code/Webview
acceptance run observes this slice. Revisit when another adapter needs lifecycle
dispatch or a measured workload requires broader sampling. Rollback removes the
additive metadata and status rendering while preserving Generic JSONL viewing.

## Addendum: bounded detection completion (2026-10-15)

This C2 lifecycle change extends the existing detection operation and its single
profile-publication path. It adds no dataset scan, adapter recognition, source
mutation, dependency, or background service. The pressure is a rejected or
never-settling head read leaving the Generic first page with permanent `pending`
metadata. The owner is the Extension Host; profiles own metadata constructors,
shared transport owns validation, and the Webview owns status explanation.

`DatasetRuntimeProvenanceV1` gains metadata-only terminal states `failed`,
`timeout`, `cancelled`, and `disabled`. They carry `samplePlan` and a closed
`terminal` object, never invented adapter, shape, confidence, or coverage:

- `stage`: `not-started`, `head-hydration`, `head-inspection`,
  `profile-sampling`, or `profile-classification`.
- `code`: respectively `detection_failed`, `deadline_exceeded`,
  `operation_cancelled`, or `auto_detection_disabled`.
- `retryable` and `action`: failed/timeout use `true`/`reload`; cancelled uses
  `false`/`none`; disabled uses `false`/`enable-auto-detection` at `not-started`.

The existing bounded head inspection still returns `fallback` when inspection
completes with unknown/invalid content or a caught inspector exception. A failed
I/O operation is not evidence of unknown content. Disabling detection performs
no sampling reads and publishes `disabled`, rather than `pending`.

Each detection invocation has a 5,000 ms default deadline (internally bounded to
1..30,000 ms), an owned abort controller, and a once-only metadata receipt.
The deadline races completion even if the callee ignores cancellation. Success,
failure, timeout, and cancellation all remove the timer and abort listener.
Callbacks cannot fail the data path; receipts contain only operation sequence,
generation/epochs, stage, status, elapsed milliseconds, and a closed error code.
They never contain paths, values, free-form errors, or source fingerprints.
Failed/timeout detection does not automatically retry; existing Reload performs
a new attempt. Existing source/profile invalidation may retry current work.

Publication still rechecks engine, document, generation, snapshot epoch, prefix
fingerprint, profile id/version, and profile epoch. Cancelled/retired work can
produce a local receipt but cannot overwrite current metadata. Rebuild detection
remains staged until adoption; caller cancellation prevents adoption. Generic
rows and Raw remain usable when optional detection fails. No source or Webview
reset is triggered by this deadline.

The rejected alternatives are a second dataset scanner and timer-only observation
that leaves an unresolved operation occupying the single-flight slot. Node 24
[timers](https://nodejs.org/docs/latest-v24.x/api/timers.html) provide
`clearTimeout` cleanup and `unref` so an idle timer does not keep Node alive.
The timer is cooperative: it cannot preempt synchronous parsing/inspection or
guarantee exact wall-clock delivery while the event loop is blocked. A completion
check also rejects results that exceed the measured deadline.

L2 validation covers rejected and never-settling head reads, late resolve/reject,
cancel/dispose, disabled reads, profile ABA, exact-once receipts, timer cleanup,
transport allowlists, and an unaffected Generic first page. Real VS Code fault
injection remains an L3 gate. Rollback reverts this additive lifecycle slice; the
existing Generic, head inspection, and startup watchdog remain independent.

## Evidence

- [JSON Lines](https://jsonlines.org/) defines UTF-8, one JSON value per line,
  and the optional final line terminator.
- [Apache Arrow documentation](https://arrow.apache.org/docs/) documents the
  columnar in-memory model and IPC/data interchange surfaces.
- [Apache Parquet documentation](https://parquet.apache.org/docs/) documents
  row groups, column chunks, and the file-format boundary.
- [Protocol Buffers overview](https://protobuf.dev/overview/) documents
  schema-driven binary serialization and generated APIs.
- [vLLM OpenAI-compatible server](https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html),
  [SGLang documentation](https://docs.sglang.ai/), [Ollama documentation](https://docs.ollama.com/),
  and [LLaMA-Factory documentation](https://llamafactory.readthedocs.io/en/latest/)
  are producer-specific evidence sources, not a shared schema authority.
- Existing [format/profile boundaries](../format-and-profile-boundaries.md),
  [OTLP and columnar gates](016-otlp-metrics-and-columnar-format-gates.md),
  and [staged mutation](025-experimental-staged-mutation-and-local-mcp.md)
  define the source, physical-adapter, and write-path constraints.

The web-search connector was unavailable during this update; the URLs above are
direct official references and must be rechecked in the next source refresh
before any compatibility claim or implementation is promoted.

## Boundary

This record authorizes planning, public-documentation study, synthetic fixtures,
read-only profile detection, and export-preview contracts. It does not add a
runtime converter, binary dependency, network client, MCP tool, remote-file
access, source mutation, permission bypass, or release claim. It does not make
provider-specific dataset examples a compatibility guarantee.

## Revisit Trigger

Revisit when at least one target workload has a pinned public schema, a
representative synthetic corpus, a conversion schema and loss policy, measured
resource/cancellation results, dependency/license review, and an independently
reviewed rollback path. Revisit the physical-adapter registry only when two
adapters require the same lifecycle and dispatch contract.

## Rollback

Disable the affected profile or adapter and fall back to Generic JSONL. Remove
only disposable indexes, previews, and staged output; never alter source bytes.
If an export produces an invalid or lossy artifact, retain the source snapshot,
mark the output rejected, and require a new operation id after the contract or
schema is corrected. A failed adapter must not prevent portable JSONL viewing.
