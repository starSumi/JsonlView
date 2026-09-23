# ADR-001: Format And Profile Boundary

Status: accepted

## Pressure

JSONL files can carry traditional logs, traces, telemetry, Agent sessions, and
SWE trajectories. Adding each semantic family directly to the parser would
make physical framing unstable.

## Invariant

The source bytes and physical record boundaries remain authoritative. A profile
may interpret a record, but never changes framing or silently drops unknown
records.

## Owner

`src/engine/` owns framing, offsets, hydration, and source generations.
`src/profiles/` owns bounded detection, projections, and correlations.

## Alternatives

- Put provider-specific branches in the engine: rejected because every new
  format would affect source correctness.
- Normalize every file into one semantic schema: rejected because it loses
  source evidence and cannot represent unknown events safely.

## Probe

Run the same physical fixtures through Generic JSONL and each profile. Compare
record count, byte references, unknown preservation, and evidence paths.

## Decision

Keep the pipeline `bytes -> adapter -> immutable records -> profile -> query/UI`.
New physical formats require adapters; new meanings require profiles.

## Evidence

Source contract: `docs/format-and-profile-boundaries.md`; engine/profile tests;
synthetic fixtures in `JsonlView-harness/showcase/`.

## Boundary

Regular JSON documents, multiline text logs, compressed JSONL, and OTLP protobuf
are not JSONL profiles. They need separate adapters and coordinate contracts.

## Revisit Trigger

Add an adapter only when a representative corpus and source-offset model are
defined. Revisit the boundary if a profile needs to invent or merge records.

## Rollback

Disable the new adapter or profile while retaining the Generic JSONL path and
the original source bytes.
