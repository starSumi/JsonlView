# ADR-037: MCP July 2026 Compatibility Boundary

Status: accepted for the experimental contract only

## Context

The MCP protocol family changed on 2026-07-28. The package split matters for
implementation planning: the v2 `@modelcontextprotocol/server` and
`@modelcontextprotocol/client` packages implement the 2026-07-28 line, while
the v1 `@modelcontextprotocol/sdk` package remains a maintenance line for
2025-11-25 and does not provide the July 2026 protocol. This repository must
not accidentally bind a read-only local experiment to the wrong wire contract.

JsonlView also has a stronger boundary than a general MCP server. JSONL bytes
and provider stores remain external read-only authority; the extension catalog
is a disposable projection. A first MCP experiment must not expose transcript
content, paths, prompts, attachments, tool arguments, or provider database
handles, and it must not create a network listener or mutate a source.

## Decision

Keep the current experiment transport-independent.
`McpReadOnlyNavigationAdapter` negotiates exactly these protocol identifiers,
ordered from newest to oldest:

    2026-07-28
    2025-11-25

Negotiation chooses the newest common identifier and rejects unknown versions;
it never silently downgrades an unknown client or server version. The adapter
exposes one bounded read-only metadata query tool. It is not an MCP process,
stdio endpoint, HTTP service, VS Code registration, or package-level server.
The experiment remains opt-in and disabled by default because no runtime caller
is registered in this phase.

The adapter accepts only an allowlisted source and bounded query fields.
Results contain redacted entity and relation metadata, a snapshot identifier,
explicit truncation, an opaque in-memory continuation cursor, and no source
locations or raw payloads. Product and provider titles are preferred; a title
derived from a first message is never returned. Cursors are bound to source,
snapshot, query, budget, and expiry. A snapshot or generation change invalidates
continuation rather than mixing rows from different reads. Cancellation is
checked before and after the supplied query; synchronous provider work remains
bounded by the existing facade budget and is not represented as hard
pre-emption.

The future wire integration must use the v2 packages for the 2026-07-28 line.
The v1 SDK is not a compatibility shim for that line. A later v2 stdio
implementation must keep stdout protocol-only, bound stderr, and preserve the
same source allowlist, redaction, cursor, timeout, and shutdown gates. HTTP,
OAuth, resources, prompts, logging, write tools, and raw JSONL access remain
out of scope until separate evidence and a new decision are recorded.

## Consequences

- The source package has no MCP SDK, transport, process, network, or VS Code
  dependency for this experiment.
- Both known protocol lines can be tested now without claiming wire-server
  compatibility.
- A future transport change is a contained adapter addition; it cannot widen
  the query projection or source authority implicitly.
- The compatibility set must be revisited when MCP publishes another protocol
  identifier or the v2 packages change their supported range.

## Validation and rollback

Compatibility, unknown-version rejection, source allowlisting, redaction,
cursor expiry/mismatch, cancellation, response byte budgets, and forbidden
dependency checks are covered by the adapter characterization tests. Rollback is
the removal of the adapter export and this experimental ADR; existing navigator
catalog and provider behavior remains unchanged.

Evidence checked 2026-10-10:

- [MCP server v2 package](https://www.npmjs.com/package/@modelcontextprotocol/server)
- [MCP client v2 package](https://www.npmjs.com/package/@modelcontextprotocol/client)
- [MCP SDK v1 maintenance package](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
