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
