# ADR-043: Core Closure And Evidence-Gated Evolution

Status: accepted

## Pressure

JsonlView is entering a larger format and workflow surface while its current
extension-host, Webview, engine, and provider boundaries are still being
staged. Expanding formats, mutation, native execution, or package topology
before those boundaries are closed would multiply rollback paths and make a
passing UI result weaker evidence for the physical data contract.

## Invariant

- JSONL bytes remain the physical authority; indexes, caches, derived fields,
  and Webview state are disposable projections.
- The current mainline closes and measures physical framing, typed transport,
  application ownership, provider presentation, resource budgets, and failure
  recovery before expanding the product surface.
- Read-only behavior remains the default. Any write or mutation capability is
  opt-in, preview-first, staged, auditable, and reversible.
- A new format or agent surface implements the immutable record contract and
  preserves malformed, unknown, oversized, and uncorrelated input as visible
  evidence.
- A capability advances only when its contract, negative cases, resource
  budget, provenance, and rollback are bound to the candidate revision.

## Owner

- Product architecture owns the mainline invariant and stage ordering.
- Engine and format owners own physical framing, offsets, parsing, and corpus
  conformance.
- Extension and Webview owners own typed transport, cancellation, generation
  fencing, and bounded presentation.
- Mutation and native owners remain separate capability owners with independent
  failure gates.
- `docs/roadmap.yaml` is the machine-readable registry for stage metadata and
  the unique `deferred:*` tag index; this ADR is the durable rationale.

## Alternatives

- Expand directly into every requested dataset and storage format: rejected
  because format and mutation contracts would be mixed with incomplete core
  boundaries.
- Introduce pnpm/Cargo workspaces or zero-copy transport immediately: rejected
  until an independent consumer or measured copy/build bottleneck exists.
- Make writes implicit when a user opens an editable view: rejected because
  source authority, trust, audit, and rollback would become ambiguous.
- Maintain roadmap tags only in prose: rejected because deferred work is easy
  to lose without a stable machine-readable owner and revisit key.

## Probe

Every stage in `docs/roadmap.yaml` identifies priority, owner, dependencies,
acceptance evidence, rollback, and a revisit trigger. A stage is eligible for
implementation only after the preceding stage's candidate-bound gates pass.
Format work starts with public producer or format specifications and synthetic
corpora; write work starts with a trust review and fault-injected recovery;
native or workspace work starts with paired end-to-end measurements.

The current closure probe includes the candidate-bound contract, public-surface,
documentation, typecheck, test, and build gates plus focused provider and
malformed-input coverage. The native scanner baseline remains the measured
boundary in ADR-040: optional native plus portable fallback, with no zero-copy
or asynchronous native topology inferred from a single local run.

## Decision

Adopt an evidence-gated four-stage roadmap:

1. **P0 core closure:** finish the current vertical slices, typed transport,
   provider ownership, bounded failure behavior, and YAML metadata registry.
2. **P1 contract and format discovery:** evaluate agent dataset and telemetry
   adapters, including vLLM, SGLang, Ollama, Llama-Factory, OTLP, Arrow,
   Parquet, and Protobuf, only through source-backed contracts and synthetic
   conformance corpora.
3. **P2 opt-in mutation and native expansion:** add preview-first writes and
   native capabilities only with authorization, journaling, cancellation,
   crash/failure recovery, and measured portable-oracle parity.
4. **P3 workspace and distributed topology:** consider package/workspace
   extraction and WSL2 or distributed workflows only when independent build,
   trust, and release evidence justifies the added topology.

Deferred work uses the unique keys in the `deferredTags` registry. The initial
registry is `deferred:workspace-split`, `deferred:zero-copy`,
`deferred:native-expansion`, `deferred:write-path`,
`deferred:format-adapters`, and `deferred:distributed-connectors`. Each
key must retain `status`, `owner`, dependencies, and a measurable revisit
trigger; removing a key requires a superseding decision or a completed stage
record.

## Evidence

- [JSON Lines specification](https://jsonlines.org/) defines the physical
  line-delimited record boundary.
- [VS Code custom editor guide](https://code.visualstudio.com/api/extension-guides/custom-editors)
  defines the document/editor integration surface.
- [VS Code Webview API](https://code.visualstudio.com/api/references/vscode-api#Webview)
  defines the host-to-Webview messaging surface.
- [OpenTelemetry Protocol specification](https://opentelemetry.io/docs/specs/otlp/)
  and [File Exporter specification](https://opentelemetry.io/docs/specs/otel/protocol/file-exporter/)
  define supported telemetry contract sources.
- ADR-039, ADR-040, ADR-041, and ADR-042 define the staged migration, native
  measurement, typed boundary, and product/harness ownership constraints.
- The candidate-bound validation receipt is retained by the external harness
  under its immutable receipt id; product source does not depend on its path.

## Boundary

This decision does not authorize implicit source mutation, remote services, a
package or Cargo workspace split, zero-copy buffers, or a public performance
claim. It does not make a dataset or telemetry adapter supported merely because
its name appears in the roadmap. The source JSONL and portable engine remain
the rollback path for every experimental capability.

## Revisit Trigger

Revisit when a P0 gate fails to close a boundary, when a P1 corpus demonstrates
a stable high-value format contract, when a P2 capability has a reviewed trust
and recovery design, or when a P3 topology has an independent consumer and
reproducible build/provenance evidence. Revisit a deferred tag only through
its registry trigger; do not promote it based on implementation availability.

## Rollback

Revert the affected vertical slice or capability and retain the prior facade,
portable scanner, read-only source projection, and immutable harness receipt.
Invalidate candidate evidence whenever source, package, lockfile, or gate input
hashes change. A roadmap stage can be marked superseded only by a new decision
that names the replacement and preserves the old record.
