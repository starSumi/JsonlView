---
id: "052-rust-query-mcp-acp-boundary"
path: "docs/decisions/052-rust-query-mcp-acp-boundary.md"
title: "Rust Query, MCP, and ACP Boundary"
kind: "decision"
status: "accepted"
owner: "product"
tags: ["acp","json-rpc","mcp","query","rust"]
evidence: []
revisit: "when a second native query consumer or remote ACP transport is promoted"
rollback: "disable the native capability and omit the opt-in MCP or ACP entrypoints"
---
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

The shipped package exposes `dist/mcp-server.cjs` directly for client-owned
Node stdio launch; it does not need a package `bin` alias or an HTTP daemon.
Required environment grants bind one opaque source ID to one explicit source
path. `JSONLVIEW_EXTENSION_PATH` is optional and defaults to the distribution's
parent extension root. This launch-time grant is independent of current VS Code
workspace permissions and ends with the stdio process. Realpath-resolved parent
roots constrain the authorized file; they never expose arbitrary sibling files.
The separate disabled MCP navigation metadata contract is not this query server.

The server reports `JsonlView/0.1.0` and accepts `2026-07-28`, `2025-11-25` and
`2025-06-18`. It exposes two tools (`jsonlview_query_records` and
`jsonlview_query_trajectory_slice`) and one resource template
(`jsonlview://source/{sourceId}/spine`, named `jsonlview_trajectory_spine`). Its
concrete resource list is empty. Tools and resources are the only advertised
capabilities. The default admission budget is 3000 ms, two active/eight queued
queries; bounded launch settings permit a 1–60000 ms budget and 1–8 active
queries. Input lines, response envelopes and tool arguments are capped at
1 MiB, 4 MiB and 32 KiB respectively. The packaged physical tool selects the
cooperative portable reader. See ADR-066 for semantic limits and continuations.

### ACP v1 wire compatibility

The [official ACP v1 schema](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v1/schema.json)
and [session setup](https://agentclientprotocol.com/protocol/v1/session-setup)
define stdio MCP entries with `name`, absolute `command`, `args` and an `env`
array of `{ name, value }`. Native Claude/Codex MCP configuration uses environment
objects instead; that client configuration shape must not cross the ACP wire.
The host owns a narrow typed `AcpMcpServerStdio` projection for its one stdio
transport. It does not claim support for unimplemented HTTP/SSE transports.

[Initialization](https://agentclientprotocol.com/protocol/v1/initialization)
advertises supported `authMethods`; a nonempty list does not mean authentication
is required. Proceed to `session/new` using the adapter's native authentication
state. An authentication-required error is reported without calling
`authenticate`, reading credentials, or opening a login flow.

[Tool permission requests](https://agentclientprotocol.com/protocol/v1/tool-calls#requesting-permission)
are agent-to-client JSON-RPC requests, not malformed output. A typed host port
shows the offered `allow_once` and `reject_once` options in a native QuickPick.
Only an offered once-option ID may return a `selected` outcome. Persistent
options are excluded. There is no stored host authorization. Missing handlers,
dismissal, a foreign session, cancellation, close, failed handlers or invalid
selections return `cancelled`; cancellation aborts pending UI and late choices
cannot send a second response. Unknown methods receive `-32601` without killing
the agent. No client filesystem or terminal capability is advertised by default.

These corrections use the existing stdio process/session owner and native VS
Code UI. Adding the entire ACP SDK would add a second transport/runtime owner
for a narrow outbound surface; the schema-backed focused projection keeps that
surface explicit. Revisit this choice when additional ACP transports or client
capabilities are implemented. Rollback removes the scoped wire/permission
changes and disables ACP configuration until compatibility is restored.

Response validation precedes pending-request removal and timer cleanup. A
response has exactly one of `result` or an object `error`, with a safe-integer
code and a bounded string message. Malformed replies fail the session through
the controlled rejection/close path; they cannot escape the stdio listener or
leave a removed pending request unresolved. Optional error data remains bounded
by the existing input-line limit.

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

The v1 compatibility regression uses a real local Node child that validates
the required MCP stdio fields and advertises authentication, plus a separate
agent permission request/reply handshake. Fault tests cover unsupported RPCs,
foreign sessions, unoffered/persistent options, cancellation, close and late
permission completion. These synthetic tests do not establish provider login,
adapter installation, model execution, or real-provider MCP tool delivery.

## Boundary and rollback

The native capability bit is optional. If loading or validation fails, the
portable JS engine remains authoritative. Disable the MCP command or omit the
MCP environment variables to remove external access; close the ACP manager to
kill only its child process. Roll back this ADR scoped files without changing
source data.
