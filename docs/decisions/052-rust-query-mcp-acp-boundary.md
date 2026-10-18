# ADR-052: Rust Query, MCP, and ACP Boundary

Status: accepted

## Pressure

The product needs one bounded data plane that can serve the Webview, read-only
MCP tools, and outbound ACP sessions. The previous native surface only scanned
newline offsets and generated diagnostic request strings, so every consumer
would otherwise grow a different parser and lifecycle.

## Invariant

JSONL bytes, absolute byte offsets, and snapshot metadata remain authoritative.
Rust performs bounded, read-only physical queries. The extension host owns path
authorization, protocol transport, process lifecycle, cancellation, and
provider selection. No query surface writes a source or accepts an arbitrary
filesystem path from an agent.

## Decision

Add a versioned Rust NAPI query contract, queryRecords, returning bounded raw
records with decimal ordinals and byte offsets. RustQueryBridge validates the
native response and maps explicit source IDs to authorized paths. The same
bridge feeds the product command and the MCP jsonlview_query_records tool.

Ship an opt-in stdio MCP server entrypoint for external clients. It requires
JSONLVIEW_MCP_SOURCE_ID and JSONLVIEW_MCP_SOURCE_PATH, rejects path-like
tool arguments, and starts only when the client launches it. ACP remains an
outbound host-owned stdio session manager; a caller may attach the MCP server
configuration to session/new, but no agent process starts during activation.

## Alternatives

Rejected: putting stdio/network/process code in Rust, copying the full JS
engine into every adapter, enabling a listener on activation, or using an ACP
provider-specific API as the data plane.

## Probe and evidence

Native unit tests cover malformed UTF-8, byte/record budgets, ordinal paging,
and snapshot metadata. TypeScript tests cover bridge authorization/schema
validation, MCP JSON-RPC negotiation/tool calls, ACP handshake/cancel/timeout,
and the packaged stdio loopback. Full product gates remain required before a
release artifact is accepted.

## Boundary and rollback

The native capability bit is optional. If loading or validation fails, the
portable JS engine remains authoritative. Disable the MCP command or omit the
MCP environment variables to remove external access; close the ACP manager to
kill only its child process. Roll back this ADR scoped files without changing
source data.
