# Phase 2 staged mutation experiment

This package is an isolated, opt-in experiment for ADR-025 P2. It evaluates a
small coordinator over synthetic immutable bytes:

- the base snapshot is copied once and never mutated;
- edits are non-empty, ordered, non-overlapping base-byte intervals;
- all old-byte expectations are SHA-256 digests of the immutable base;
- source, base, and staging generations are separate receipt fields;
- operation IDs and idempotency keys replay an exact prior stage outcome;
- an export-copy simulation returns bytes in memory and marks
  sourceUnchanged: true;
- an unresolved commit simulation returns sourceUnchanged: "unknown" and
  holds the authority fence until reconciliation.

The package deliberately has no filesystem, VS Code, MCP, Monaco, PieceTree,
network, or product-runtime dependency. It is not imported by the extension
entry points and cannot replace an original source. P3 export authorization and
any real write path require a separate review and gate.

## Contract limits

Ranges use UTF-8 byte coordinates. The experiment does not parse JSON, repair
partial records, normalize CRLF, or infer a rebase. A CRLF or partial-tail
fixture is treated as opaque bytes and is only changed inside the requested
interval. Empty insertion ranges are rejected until an explicit insertion
contract is reviewed.

The implementation is a correctness baseline, not a PieceTree or LSM claim.
It materializes a copy in O(base bytes + replacement bytes) for the export
simulation. Performance measurements must remain tied to a pinned corpus and
must not be promoted to product targets.
