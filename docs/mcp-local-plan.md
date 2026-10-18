# Local MCP and Audit Plan

MCP is a host adapter, not a second source of truth. The first shipped boundary
is read-only and opt-in. It reads the same bounded snapshot and catalog used by
the Navigator and returns opaque source identifiers unless a trusted user asks
for a path.

## Commands and fences

The planned Navigator query set is `list_sessions`, `get_session`,
`list_relations`, `read_slice`, and `search_index`. Each planned request carries
an operation ID, source allowlist, generation/snapshot token, cancellation
signal, traversal budget, and output byte cap. The shipped Rust record adapter
described below is a narrower physical-page API and does not implement this
query set. No command execution, arbitrary path access, secret disclosure, or
source write is part of this phase.

The audit ledger and OTel telemetry are separate: the local ledger is the
forensic record for bounded operation metadata and recovery outcomes; optional
telemetry is a redacted trend signal with fixed enums and bounded cardinality.
Raw prompts, source bytes, local absolute paths, credentials, and full tool
payloads do not leave the local boundary.

## Mutation phases

`stage_patch` can be considered only after the read-only query contract has
conformance and failure evidence. It must produce a diff and precondition receipt
without changing the source. A commit tool is a later capability requiring
explicit human confirmation, authority fencing, idempotency, journal intent,
atomic replacement, readback digest, and unknown-commit reconciliation.

This plan does not add an MCP server to extension startup. A separate
dist/mcp-server.cjs stdio entrypoint is packaged for an explicit MCP client
launch. It requires JSONLVIEW_MCP_SOURCE_ID and JSONLVIEW_MCP_SOURCE_PATH; the
source path is supplied by the trusted host, never by a tool argument.
Transport ownership, Restricted Mode behavior, Workspace Trust, and source
authorization remain host policies.

An MCP client launches the packaged entrypoint with its normal Node runtime and
sets those two environment variables for one explicitly authorized JSONL file.
The only tool is jsonlview_query_records; it accepts sourceId, startOrdinal,
limit, and maxBytes. The host caps a tool page at 256 records and 512 KiB; it
never splits a physical record, and a first record that exceeds maxBytes fails
explicitly with `record-exceeds-max-bytes` instead of returning a stationary
continuation cursor. The Rust core caps ordinal-prefix scanning at 64 MiB. The
packaged N-API query is synchronous, so the stdio adapter cannot process MCP
cancellation or enforce its cooperative request timeout while a native read is
running. This is a bounded-read limitation, not a cancellable query contract.
Unknown requested protocol versions negotiate to the newest server-supported
version. Tool arguments cannot supply paths, commands, or write operations.

The shipped inspection command only reports the frozen capability descriptor:

## Diagnostic bridge

The Rust `McpManager` in `native/jsonl-core/src/mcp_manager.rs` is a
transport-neutral lifecycle manager. It stays dormant until the user explicitly
chooses `Send to side agent` or invokes the corresponding command. The extension
then asks the native manager for a bounded, metadata-only request plan; the
manager never starts a process, opens a socket, or contacts a provider. The
separate AcpSessionManager owns an explicit ACP stdio child session and can
attach the packaged MCP server definition to session/new for the configured
agent.

The plan includes the current MCP handshake (`2026-07-28`) and compatibility
attempts for `2025-11-25` (the repository's existing line) and `2025-06-18`
(the Codex legacy line). A host-owned bridge decides whether and how to execute
one attempt, applies its own timeout and trust policy, and may route to any
compatible agent. Copilot is not a required dependency. On the explicit
`Send to side agent` action, a configured ACP agent is used only in a trusted
workspace; otherwise the extension tries its MCP side-agent bridge and copies
the bounded prompt if no bridge accepts it. No provider process starts at
activation.
The Navigator inspection capability remains experimental, disabled by default,
metadata-only, and without an activation-time transport. The Rust query server
is a separate explicit stdio adapter and remains read-only, bounded, source
allowlisted, synchronous, and provider-neutral.
