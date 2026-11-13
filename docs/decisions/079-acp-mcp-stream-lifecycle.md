---
id: "079-acp-mcp-stream-lifecycle"
path: "docs/decisions/079-acp-mcp-stream-lifecycle.md"
title: "ACP and MCP Stream Lifecycle"
kind: "decision"
status: "accepted"
owner: "product"
tags: ["acp", "mcp", "stdio", "identity", "cancellation"]
evidence: []
revisit: "before adding new ACP capabilities, transports, MCP protocol versions or source-revocation coordination"
rollback: "revert the stream changes together with their tests; disable affected explicit adapters if compatibility cannot be maintained"
---
# ADR-079: ACP and MCP Stream Lifecycle

The ACP diagnostic client and standalone read-only MCP server already implement
their application contracts. This C3 change closes stream and session lifecycle
gaps without adding a protocol, dependency, background service or launch action.
Extension activation continues to start neither adapter.

## Contracts and ownership

The existing ACP manager owns its explicitly configured process and one session.
Node's UTF-8 stream decoder retains incomplete multibyte sequences between pipe
chunks. Both stdout and stderr use that decoder. Outgoing JSON-RPC lines have
the existing 1 MiB byte cap before write. Empty or over-limit session IDs cannot
make the session ready. Session updates with missing or foreign session IDs are
ignored; valid updates retain their original fields. Prompt cancellation still
accepts trailing updates for the active session until its terminal response.
The process uses separate command arguments, no shell and a hidden Windows
window. A closed stdin reports failure through the same manager lifecycle.

The standalone entry composes `mcp-stdio-transport.ts` with the existing server.
The transport owns UTF-8 decoding, newline/CRLF framing, bounded retained input
and stream closure. An over-limit line produces one bounded size error and is
discarded until its newline. Its remaining fragment cannot become another RPC.
EOF discards unterminated input and closes the server; input/output failure or
output closure follows the same path. The server cancels active and queued work
and cannot publish a late result. Output completion observes the write callback;
a rejected asynchronous send is handled and stops the server.

Modern MCP requests keep their per-request protocol metadata; legacy clients
retain their existing initialization lifecycle. Neither a cursor nor a resource
URI grants source access. The physical and semantic tools and spine resource
continue to resolve only the source identity supplied at explicit startup.
Cross-process instantaneous permission revocation and immutable snapshots are
outside the current adapter contract; stopping its owning process ends access.

## Native ACP progress and failure evidence

The C2 diagnostic interaction uses VS Code's native cancellable notification
and a request-owned status-bar item, keeping the current stage and elapsed time
visible when a notification is hidden. The Extension Host owns that projection;
the ACP manager emits only fixed launch, initialize, session/new and
session/prompt stages. Observer exceptions cannot alter protocol behavior.
Permission waiting and response chunks update the native surface without
publishing their bodies to Output. Cancellation before start launches nothing;
superseding a connection closes its progress and suppresses late publication.

Timeout errors retain the operation and limit as structured metadata. Output
records only fixed stages, elapsed times, allowed error names/codes and numeric
RPC codes. User guidance distinguishes handshake and session-creation timeouts
from a response timeout after submission. Authentication-required retains the
standard ACP error code -32000. There is no automatic resend or inferred login.
Raw stderr and RPC error bodies were rejected as a diagnostic alternative
because either can contain source content or credentials. Stderr byte counts
remain available; a generic refusal message alone was rejected because it
cannot distinguish a launch failure from work already in progress.

## Process-tree shutdown and optional diagnostics

`AcpSessionManager.close()` synchronously closes protocol state and rejects
pending requests, then returns a promise for owned process settlement. Runtime
`stop()` is bounded: POSIX children are launched in an owned process group,
receive SIGTERM, then SIGKILL after 750 ms if needed, followed by bounded group
exit polling. Windows uses `taskkill /T /F` and waits for the taskkill process to
finish. The stop budget is four seconds; if the tree cannot be confirmed gone,
the result is `unknown` and remains visible in sanitized Output evidence.
Session replacement and extension deactivation await close settlement before
they report completion. Injected process adapters that expose only `kill()`
retain the compatibility fallback and return no settlement result; that path
does not claim verified process-tree cleanup.

The optional side-agent command dispatch is not included in the shutdown wait.
Deactivation prevents a late dispatch completion from writing Output, the
clipboard, or a notification. This avoids letting an external command receiver
hold extension shutdown indefinitely while keeping its result best-effort.

The interaction adds no dependency, launch action or configuration convention.
The platform contract was checked through Context7 against the official
[VS Code API](https://code.visualstudio.com/api/references/vscode-api#window.withProgress)
on 2026-11-08. Focused real-child tests stall each protocol stage and exercise
missing executables, authentication, cancellation and supersession; native
surface tests verify elapsed updates and disposal after success and failure.
Those tests are L2 evidence, not installed UI acceptance. Rollback restores
the diagnostic presentation and observer together without changing source
files, agent authentication or user configuration.

## Protocol and stream standards check

Checked official primary sources on 2026-11-08. Context7 and the session web
tool were unavailable; direct HTTPS retrieval of these official pages succeeded:

- [ACP session setup](https://agentclientprotocol.com/protocol/v1/session-setup):
  initialize before creating a session, unique session identity, and stdio MCP
  entries with command, argument array and environment-variable array.
- [MCP versioning and compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/lifecycle):
  modern request metadata and dual-era behavior remain protocol-owned.
- [MCP stdio](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio):
  newline-delimited messages, protocol-only stdout and closure-based lifecycle.
- [Node 24 streams](https://nodejs.org/docs/latest-v24.x/api/stream.html#readablesetencodingencoding):
  use the standard decoder and write completion surface rather than decoding
  each arbitrary buffer independently.

## Validation and limits

Regression tests reproduce split Chinese and emoji bytes through real ACP child
process pipes, reject cross-session updates and oversized outbound prompts, and
exercise session-ID failure. Process tests cover SIGTERM-resistant child and
grandchild shutdown on POSIX and verify Windows tree termination before stop
resolves. Deactivation tests verify that side-agent completion cannot block
shutdown or emit late UI effects. MCP stream tests cover CRLF, fragmented oversized
lines, delayed/failed output, client EOF, cancellation and suppressed publication.
The existing modern/legacy query, permission, source, cursor and budget suites
remain required. Harness-only official SDK clients check built stdio separately;
their dependencies do not enter the product lockfile or runtime.

An active OS filesystem operation is cooperative and cannot be forcibly
preempted. Write completion means delivery to the stream, not client acceptance.
This work claims no latency or throughput improvement and changes no supported
protocol version. Rollback preserves source bytes and user configuration.
