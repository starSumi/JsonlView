# ADR-026: Opt-In Read-Only Navigation Prototype

Status: experimental

## Pressure

Agent sessions, threads, forks, subagents, workflows, tools, goals, plans, and
memories are stored by their producers. A companion navigator needs a common
projection without treating a provider's private files as a product-owned
schema or copying message content into a second source of truth. The existing
viewer must keep its startup cost, source authority, and read-only behavior.

## Invariant

- The stable JSONL viewer remains unchanged when the experiment is not invoked.
- Providers return only bounded metadata projections and opaque references. They
  never mutate source files, execute records, open arbitrary paths, or return
  credentials and message bodies by default.
- Every query has an explicit operation id, source allowlist, snapshot identity,
  cancellation signal, result limit, and entity/relation/time budget.
- A snapshot is immutable for the lifetime of a query. Late or cancelled work
  cannot acquire a UI mutation lock.

## Owner

`src/experimental/` owns the versioned contract and pure read-only facade. A
future VS Code TreeView or MCP transport owns its lifecycle and must adapt to
this facade; it must not bypass it. Provider adapters own their source-specific
discovery and redaction. The harness owns integration and host evidence.

## Alternatives

1. Scan Codex/Claude directories during extension activation: rejected because
   it would add startup I/O, expose private state without a user gesture, and
   couple the product to private producer layouts.
2. Add a SQLite/DuckDB index in the first slice: deferred until a provider,
   migration policy, stale-index recovery, and measured cold-start budget exist.
3. Put discovery and file reads in the Webview: rejected because Webviews do
   not own source authority or filesystem capability.
4. Start an MCP process from the extension immediately: rejected until an
   explicit transport owner, trust policy, stdout/stderr contract, timeout,
   and output cap are reviewed.

## Decision

The first experiment is a dormant TypeScript facade with a host registration
seam and five normalized query
dimensions: source, session/thread hierarchy, relation edges, bounded metadata
slice, and text search over labels. It pins the provider snapshot returned for
the query and keeps source generations separate from snapshot ids. Source ids
are opaque and must be explicitly allowlisted; a multi-source request without
an allowlist is rejected. Default limits are 500 entities, 2,000 relations,
and 1 second per query, with hard maxima of 10,000, 50,000, and 10 seconds.

The registration seam returns no facade when `enabled` is false, so a host can
prove that the disabled path performs no provider read. The facade has no VS
Code import and no transport. A later opt-in command may
construct it after a user gesture and Workspace Trust/allowlist checks. A later
MCP adapter may map `list_sessions`, `get_session`, `list_relations`,
`read_slice`, and `search_index` onto the same bounded query contract. No write
tool, source replacement, staging operation, telemetry, or network endpoint is
part of this phase.
When a filtered query reaches its result limit, the facade examines one further
matching entity before reporting `result_limit`; a final matching entity is not
mistaken for truncation. Provider-level truncation remains visible through its
bounded `truncatedReason`.

## Probe

The unit suite covers source allowlisting, opaque snapshot pinning, relation
projection, cancellation, operation id validation, result bounds, and provider
budget enforcement. It uses synthetic entities only; it does not read Codex,
Claude, or user workspace stores.

## Evidence

- VS Code contribution points: https://code.visualstudio.com/api/references/contribution-points.md
- VS Code Tree View API: https://code.visualstudio.com/api/extension-guides/tree-view.md
- VS Code Workspace Trust: https://code.visualstudio.com/api/extension-guides/workspace-trust.md
- VS Code MCP servers: https://code.visualstudio.com/docs/agent-customization/mcp-servers.md
- MCP tool security: https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- MCP transports: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports

These references constrain a future host/transport integration; they do not
authorize a source write path or guarantee provider schemas.

## Boundary

This prototype does not add an activation event, contribution point, process,
database, filesystem watcher, source adapter, or MCP server. It is not a user
visible feature and is not release authorization. Any host integration must
preserve opt-in activation, source redaction, and the existing read-only path.

## Revisit Trigger

Revisit when one provider adapter has a documented or pinned observed shape, a
real VS Code host probe records cold-start and cancellation behavior, and an
independent security review approves the transport and trust boundary.

## Rollback

Remove `src/experimental/` and this decision record. The stable viewer has no
dependency on the prototype, so rollback leaves source bytes and published
artifacts unchanged.
