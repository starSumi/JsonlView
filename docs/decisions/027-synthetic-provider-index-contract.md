# ADR-027: Synthetic Provider and Navigation Index Contract

Status: proposed experiment

## Pressure

The opt-in navigation facade needs evidence that heterogeneous agent topology
can be projected without coupling the product to private producer stores. The
next experiment must exercise sessions, teams, workflows, tools, tasks,
subagents, forks, and spawn edges while keeping the source and payloads out of
the projection.

## Invariant

The adapter accepts only caller-supplied synthetic records. It has no path,
filesystem, database, process, network, VS Code, or MCP dependency. Its output
is metadata-only, bounded by negotiated entity and relation budgets, carries an
opaque source generation, and is immutable after construction. Malformed or
unsupported records are reported and do not discard valid records.

## Owner and change class

Owner: JsonlView experimental navigation lane. Change class: C2 contract and
index projection. The harness owns fixtures and runtime measurements; this
source module owns only the pure adapter seam and its focused tests.

## Alternatives considered

- Read producer JSONL or SQLite files directly: rejected because it would make
  private layouts and paths a product dependency.
- Add a provider-specific union to the host facade: rejected because it would
  make the control-plane contract depend on one producer.
- Persist a catalog in this experiment: deferred until a separate storage and
  migration gate proves ownership, crash recovery, and bounded startup cost.

## Probe and expected metric

Synthetic fixtures cover parent, child, fork, spawn, team, workflow, tool,
confidence, malformed, unsupported, redaction, generation rebuild, cancellation,
and entity/relation limits. The expected result is deterministic metadata-only
snapshots, explicit diagnostics, and no payload or path leakage. A future
provider may reuse the contract only after its own shape and provenance review.

## Decision

Use SyntheticNavigationAdapter and SyntheticNavigationProvider as the pure
contract probe. Records are copied on input, accepted kinds and relation kinds
are allowlisted, labels and identifiers are bounded, and unknown properties are
ignored. Parent edges are derived only from an explicit parent identifier;
additional edges are allowlisted and bounded. Snapshot identifiers include the
source generation and negotiated bounds. rebuild returns a new provider and
never mutates an earlier snapshot.

The adapter may report malformed and unsupported diagnostics while returning a
valid partial index. It does not turn a payload field into a label or opaque
reference. An empty or all-rejected fixture is still a valid bounded snapshot;
the diagnostic status tells the caller why records were not accepted.

## Evidence

The focused suite is test/experimental/synthetic-provider.test.ts. It checks
topology, redaction, malformed/unsupported handling, bounds and truncation,
generation immutability, cancellation, and identity validation. The shared
read-only facade remains the only caller contract; no activation entry point
imports this adapter.

The contract follows the existing navigation ADR and the platform boundaries
documented by [VS Code contribution points](https://code.visualstudio.com/api/references/contribution-points.md),
[VS Code Tree View](https://code.visualstudio.com/api/extension-guides/tree-view.md),
and the [MCP tools security guidance](https://modelcontextprotocol.io/specification/2025-06-18/server/tools).

## Boundary and known unknowns

This is synthetic evidence, not proof that Codex, Claude, or another producer
can be safely scanned. No native UUID, session path, prompt, message body,
credential, database schema, or provider-specific relation is part of the
contract. A real adapter must first document its source authority, redaction
rules, generation signal, and rebuild behavior. This experiment does not add a
TreeView, MCP transport, catalog persistence, or write capability.

## Revisit trigger and rollback

Revisit when a provider contract is public or a read-only source adapter has a
reviewed fixture and bounded host evidence. Revert this module, export, tests,
decision, and changelog entry if diagnostics cannot remain fail-closed or if a
provider proposal requires exposing source paths or payloads.
