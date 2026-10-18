# Local MCP and Audit Plan

MCP is a host adapter, not a second source of truth. The first shipped boundary
is read-only and opt-in. It reads the same bounded snapshot and catalog used by
the Navigator and returns opaque source identifiers unless a trusted user asks
for a path.

## Commands and fences

The initial query set is `list_sessions`, `get_session`, `list_relations`,
`read_slice`, and `search_index`. Each request carries an operation ID, source
allowlist, generation/snapshot token, cancellation signal, traversal budget, and
output byte cap. Late, oversized, stale, or uncancellable results are discarded.
No command execution, arbitrary path access, secret disclosure, or source write
is part of this phase.

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

This plan does not add an MCP server to extension startup. Transport ownership,
Restricted Mode behavior, Workspace Trust, and source authorization remain host
policies. The existing experimental adapter is the compatibility seam until an
independently owned transport and security review exist.

The shipped inspection command only reports the frozen capability descriptor:
experimental, disabled by default, metadata-only, and without transport,
process, network, command execution, or source mutation. It does not construct
a facade or read a provider. A future transport must keep the same explicit
allowlist, generation, budget, cancellation and redaction gates.
