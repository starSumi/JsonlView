# ADR-022: Read-Only Agent-History Adapter Roadmap

Status: planned

## Pressure

Agent workflows often have parent-child runs, status transitions, cancellation,
and bounded materialization. The product needs a clear way to evaluate those
shapes without coupling the JSONL editor to a private state store or an
unstable producer implementation.

## Invariant

JSONL bytes remain authoritative and immutable. Indexes, graph projections, and
hydrated views are disposable, bounded, cancellable, and reject stale
generations. An internal graph or database observation is never a public plugin
contract.

## Owner

The harness owns synthetic graph, cancellation, framing, and hydration probes.
The product engine owns JSONL framing and source identity. A future adapter would
need a named product owner, a versioned public interface, and an explicit
security and privacy review before implementation.

## Alternatives

- Expose a private local database or internal graph store directly: rejected
  because ownership, compatibility, privacy, and migration guarantees are absent.
- Add row patching, copy-on-write, clipboard upload, or source editing: rejected
  because the editor is read-only and source bytes must remain authoritative.
- Add a default network or MCP gateway: deferred and out of scope until an
  explicit capability, access-control model, and threat review exist.
- Add viewport, worker, IPC, or native acceleration immediately: deferred until
  representative measurements show a bounded need.

## Probe

The harness must first prove cancellation before delivery, cleanup after
cancel, stable child ordering, one parent per child, bounded breadth/depth,
open/closed status filters, byte-safe framing, bounded hydration, and unchanged
source bytes. Product acceptance additionally requires a clean pinned revision,
contract/type/build checks, focused and full tests, an independent privacy and
security review, and an isolated installed-host receipt tied to the exact artifact.

## Decision

Keep this as a staged roadmap entry. Implement synthetic harness probes first.
Consider a read-only external adapter only after a public contract defines
capability-scoped path or URI access, snapshot consistency, row/depth/byte
limits, cancellation, privacy redaction, audit records, owner, and rollback.
The adapter must be opt-in, read-only, and fail closed when the contract or
snapshot cannot be verified.

The host boundary follows the [VS Code Webview
guide](https://code.visualstudio.com/api/extension-guides/webview). Any future
tool boundary must meet the [MCP Tools security
considerations](https://modelcontextprotocol.io/specification/2025-06-18/server/tools),
including validation, access control, rate limiting, output sanitization, and
confirmation for sensitive operations. These references support the boundary;
they do not authorize a new integration.

## Evidence

The harness assessment records bounded source and aggregate observations,
synthetic fixtures, hashes, and validation results. It intentionally excludes
rollout bodies, prompts, credentials, private database values, and user content.
No product runtime or public package depends on those observations.

## Boundary

This ADR changes planning only. It adds no runtime adapter, database reader,
IPC channel, network request, MCP server, telemetry collector, persistent flag,
row mutation, or release permission.

## Revisit Trigger

Revisit when the harness probes pass, a public producer contract and owner are
available, privacy/security review is complete, and measured workloads justify
the adapter over the existing bounded JSONL engine.

## Rollback

Remove the roadmap entry and harness probes if the contract, owner, or evidence
gates cannot be satisfied. Existing JSONL viewing and source immutability remain
unchanged.
