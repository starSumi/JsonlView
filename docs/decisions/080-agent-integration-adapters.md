---
id: "080-agent-integration-adapters"
path: "docs/decisions/080-agent-integration-adapters.md"
title: "Agent Integration Adapters and Execution Targets"
kind: "decision"
status: "accepted"
owner: "product"
tags: ["acp", "mcp", "plugins", "runtime", "adapters"]
evidence: []
revisit: "when an adapter adds a protocol version, transport, permission scope or executable plugin"
rollback: "disable the explicit integration profile and retain the existing local read-only product path"
---
# ADR-080: Agent Integration Adapters and Execution Targets

## Context and change class

JsonlView already launches one explicitly configured ACP stdio agent for a
diagnostic, exposes a read-only MCP stdio server, and has a workspace runtime
package that models local, WSL, SSH and bridge targets. Their ownership is
disconnected: ACP configuration has one command, runtime target execution is
separate from the ACP manager, and `apps/bridge` returns a successful-looking
JSON-RPC result from `/mcp` without implementing MCP. Optional provider catalogs
and agent plugins therefore cannot be treated as active merely because their
manifest exists.

This is a C2 shared-contract and lifecycle change, with a C3 protocol-boundary
review for any claimed compatibility. Goals are multi-agent ACP selection,
protocol-neutral adapter descriptions, safe separation of protocol transport
from execution target, truthful MCP/bridge behavior, and reproducible
interoperability checks. Product source remains read-only; no integration starts
at activation.

## Decision

Keep four responsibilities separate:

1. **Protocol adapter** owns ACP or MCP message lifecycle and its negotiated
   protocol version. ACP v1 stdio is the shipped client contract. The current
   manager does not claim ACP v2 prompt semantics or the proposed remote ACP
   transport until a complete state machine and conformance tests exist. The
   existing JsonlView MCP server remains the provider-neutral, read-only
   product adapter. MCP SDK v1.32.2 is the stable external client surface used
   for interoperability checks and covers the legacy initialization era; the
   product's own 2026-07-28 stateless server contract remains independently
   tested. Do not infer support for a protocol version from a package name.
2. **Execution target** chooses where an explicitly launched process runs:
   local, WSL distribution, or SSH host. The protocol remains ACP/MCP stdio
   over the resulting process streams. Shipped ACP profiles currently bind to
   local execution only; the runtime exposes deterministic WSL/SSH launch
   construction, but no user-facing remote ACP/MCP profile is enabled. A bridge
   target is not enabled by a WebSocket URL alone.
3. **Adapter catalog** describes provider identity, protocol versions,
   transports, targets and declared capabilities. It is static metadata and
   provenance, not executable code, credentials, or permission. User instances
   bind an installed command to a catalog entry. The ACP profile carries an
   explicit execution target, currently fixed to `local`, and the session
   manager launches through the shared runtime factory. Provider authentication
   stays with the provider's existing login mechanism or host process
   environment; no secret value is copied into the catalog.
4. **Plugin/skill sources** remain optional content. Discovery or installation
   does not enable a protocol server or grant a tool permission. Provider
   plugin formats are adapted as pinned, source-specific metadata; they are not
   declared a universal JsonlView plugin standard. A Git-backed plugin entry
   requires a full 40-character commit SHA and content digest. JsonlView does
   not download, evaluate, or auto-activate plugin code in this change.

`packages/runtime` owns a versioned adapter descriptor and a target-to-process
launcher. `src/extension` owns VS Code configuration, the user-facing ACP
profile choice, workspace trust and lifetime. `packages/mcp-server` owns the
read-only MCP tools and their source allowlist. `apps/bridge` may expose only a
protocol it actually implements; its placeholder `/mcp` responder must be
removed. The existing custom WebSocket passthrough is not advertised as a
standard ACP transport.

## Alternatives

- **Keep one command field per protocol:** lowest cost but makes concurrent
  multi-provider profiles and target selection implicit; retained only as a
  backward-compatible ACP fallback.
- **Adopt a vendor plugin catalog as the runtime contract:** rejected because
  provider manifests have different semantics and often include executable
  hooks. This loses provenance and permission boundaries when normalized
  without an owner.
- **Add a custom WebSocket/HTTP protocol adapter now:** rejected because MCP
  Streamable HTTP and ACP remote transport have different lifecycle/version
  contracts, and the current bridge implements neither. Add them only behind
  protocol-specific transports, standard client probes, auth policy and
  disconnect/cancellation tests.
- **Split each provider into a package:** rejected until one adapter needs an
  independent build/release or has more than one consumer. A generic versioned
  manifest and a small set of protocol/target adapters address current change
  pressure with less build and dependency cost.

## Ecosystem patterns reviewed

The Hermes ACP reference is an ACP server with a broader session,
authentication and update surface than JsonlView needs when sending one
explicit diagnostic. JsonlView stays an ACP client and implements only its
declared v1 lifecycle; the server implementation is not treated as the client
contract. A Hermes optional MCP connector sample declares a hosted HTTP URL and
OAuth separately, while its FastMCP workflow treats local stdio and HTTP runs
as distinct launch choices. These patterns support separate protocol,
transport, execution-target and authentication owners; they do not make the
custom JsonlView tunnel an MCP transport. Hermes optional skills are
instructional workflow content, while its plugin catalog uses reviewed
admission, exact commit pins and declared capabilities. JsonlView records only
pinned, disabled metadata and provides no installation or activation path.
These local repository patterns inform design choices but do not replace ACP,
MCP or Agent Skills specifications.

## Invariants and failure behavior

- No process or listener starts on extension activation or catalog discovery.
- Commands use argument arrays and `shell: false` locally. WSL/SSH wrappers are
  tested as launch descriptors only; SSH necessarily sends a quoted command
  string to the remote login shell, so live support requires shell and path
  mapping acceptance for the selected host.
- Every shipped ACP profile is explicit and tied to ACP v1, stdio and local
  execution. Unsupported combinations fail closed before process spawn.
- ACP prompt timeout leaves outcome unknown and never replays a prompt. A
  canceled or closed profile cannot publish late updates to a newer session.
- MCP tool calls remain subject to the existing source allowlist, output and
  time budgets. This change adds no write-capable MCP operation.
- Plugin discovery never grants execution. Credentials are values supplied by
  host-owned secret resolution or provider login, never stored in a catalog
  manifest or copied into diagnostics.
- Bridge endpoint names and health responses do not claim MCP/ACP compliance
  unless official client initialize/session/tool probes pass.

## Validation and rollback

Tests cover manifest version and invalid-combination rejection, ACP profile
selection and legacy configuration, target command argument boundaries,
message-count and byte queue bounds, UTF-8 split chunks, bridge rejection of
false MCP success and proof that rejected clients do not launch the child, and
the existing ACP timeout/cancel/session lifecycle. A separate official MCP TypeScript SDK client
probe validates the packaged JsonlView stdio server's legacy initialize,
`tools/list`, and bounded `tools/call`; the modern 2026-07-28 path continues to
use its native contract suite. WSL and SSH launch syntax receive deterministic
command-construction tests; live remote acceptance is reported only when a
configured target is actually reachable.

The rollout remains local and opt-in. Rollback removes the new profile and
catalog path, restores the prior single-command ACP setting, and leaves the
read-only MCP server and source files unchanged. It does not require deleting
user settings or remote resources.

## Standards checked

Checked official ACP v2 initialization, prompt lifecycle and remote-transport
documentation, official MCP 2026-07-28 stateless/transport/versioning pages,
and the official MCP TypeScript SDK v1.32.2 client API on 2026-11-09. ACP v2
prompt acknowledgement is distinct from turn completion; its remote WebSocket
transport remains a separate proposal surface. MCP 2026-07-28 places protocol
version, client identity and capabilities on each request, while the stable
SDK v1 client uses the legacy initialize lifecycle. These are separate
compatibility paths and must not be collapsed into one generic handshake.

- [ACP initialization](https://agentclientprotocol.com/protocol/v2/initialization)
- [ACP prompt lifecycle](https://agentclientprotocol.com/protocol/v2/prompt-lifecycle)
- [ACP remote transport proposal](https://agentclientprotocol.com/rfds/streamable-http-websocket-transport)
- [MCP 2026-07-28 stateless protocol](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/2026-07-28/docs/seps/2575-stateless-mcp.mdx)
- [MCP Streamable HTTP](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/2026-07-28/docs/specification/2026-07-28/basic/transports/streamable-http.mdx)
- [MCP TypeScript SDK v1.32.2 client](https://github.com/modelcontextprotocol/typescript-sdk/tree/1.32.2/docs)
