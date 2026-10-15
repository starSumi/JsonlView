# ADR-033: Bounded Webview Diagnostics and Agent Handoff

Status: experimental

## Pressure

VS Code can report a Webview host lifecycle failure before extension code runs,
including service-worker registration errors. JsonlView does not register a
service worker and cannot intercept renderer-owned notifications. Users still
need a useful recovery path without copying JSONL bodies or private paths into
an AI pane.

## Invariant

- Product-controlled Webview errors produce a bounded diagnostic envelope.
- The envelope contains error metadata only: no source records, prompts,
  credentials, absolute paths, or arbitrary Webview payloads.
- Sending to VS Code Chat is best effort and always has a clipboard fallback.
  Third-party panes remain responsible for their own commands and consent.
- A host-generated error is described as a host boundary; JsonlView never
  claims to have repaired a VS Code or Chromium lifecycle failure.

## Owner and decision

`src/extension/diagnostic-context.ts` owns the versioned, redacted envelope.
The extension host owns the copy and Chat actions. `SourceIntakePanel` exposes
the same bounded action for its own `error` and `unhandledrejection` events.
The command `jsonlView.diagnoseWebview` gives a recoverable entry point when a
renderer-owned host error has no extension callback. The command uses a known
symptom template and marks the source boundary explicitly.

For product-owned editor startup, register the host message receiver before
publishing Webview HTML. The Webview uses one VS Code API handle, retries READY
for a bounded interval, and shows a named startup error if no OPENED summary
arrives. Opening, resolving, READY receipt, OPENED host-post acceptance, and
the first row request/result log stage and aggregate outcome only; they never
log source bytes or full source paths. A successful host post does not prove
the Webview rendered it; a subsequent row request is a separate receipt. A late valid
OPENED may still recover the editor after the timeout is displayed.

The host correlates a fixed stage receipt with a per-resolve startup ID, the
current document ID, generation, and monotonic source epoch. Retired receipts
and receipts from an earlier editor resolve are ignored. The
Webview reports OPENED acceptance, first page state commit (including zero
rows), or startup error; these receipts do not prove pixels were painted. A
10-second host watchdog records a stalled outcome and last accepted stage when
startup has not committed. This exceeds the Webview's 7.5-second bounded READY
retry window. The Webview also reports the bounded READY timeout as a startup
error when its script is running. The watchdog permits late recovery; it does not
automatically recreate the Webview or infer the underlying renderer cause.

The create phase has a separate 10-second, single-shot observation starting
before awaiting document creation. It uses the same open trace ID that is
retained when the created document reaches editor resolve. While creation is
pending, the last observable stage is `create-begin`; a timeout logs
`open-document stage=stalled phase=create` with elapsed time. This observation
is distinct from the per-resolve `startup-outcome`: it does not settle, cancel,
retry, or rebuild the creation operation, and does not introduce a new editor
startup terminal state.

Creation success or failure clears the timer and cancellation listener. Token
cancellation also clears both immediately and logs one create cancellation,
even if creation has not settled. An already cancelled token has the same
cleanup behavior. The original creation promise still owns its result or
error. A late completion or failure keeps that result and records
`afterStall=true` or `cancelled=true` as applicable; a late successful creation
may still proceed to the existing resolve lifecycle. Each opening owns its
own timer and trace, so a cancelled or stalled opening cannot clear another
opening's observation. No source path, body, or error message is added.

## Alternatives and deferred work

- Registering a service worker to suppress the host error was rejected: the
  product has no worker requirement and renderer lifecycle ownership belongs to
  VS Code.
- Calling Claude/Copilot/Codex pane identifiers directly was rejected: those
  commands are provider-owned and are not a stable VS Code extension contract.
- An MCP diagnostic tool is deferred until the read-only local MCP transport
  has its own trust, cancellation, output, and audit gate.
- Racing creation against a rejecting timeout was rejected: a diagnostic
  deadline must not replace the existing creation result or leave a hidden
  operation running after a new product-owned failure.

## Evidence

- [VS Code Webview guide](https://code.visualstudio.com/api/extension-guides/webview)
  defines the extension-owned Webview lifecycle and restrictive CSP boundary.
- [VS Code commands reference](https://code.visualstudio.com/api/references/commands)
  defines command invocation; built-in Chat availability is runtime-dependent.
- [VS Code Chat extension guide](https://code.visualstudio.com/api/extension-guides/chat)
  documents extension-facing Chat integration surfaces without granting
  ownership of another extension's view.

## Probe and validation

Pure tests cover field bounds, path redaction, policy markers, and prompt
construction. Focused intake tests cover the message schema and CSP. Installed
host acceptance must separately verify the command palette action, clipboard
fallback, and behavior when Chat is unavailable.
Startup tests must deliver READY as soon as HTML is assigned, drop the first
READY, and withhold OPENED; verify listener order, bounded retry/error, and
late-response recovery. Installed-host acceptance must match the running
extension bundle to the tested candidate before interpreting its output log.
Fault injection must also verify stale epoch and startup ID receipts are ignored,
and a late page commit after a startup error or watchdog stall is logged as
recovery.
Controlled-clock provider tests must hold creation pending, expire the create
timer exactly once, and then complete or fail it late. They must also verify
timer and token-listener cleanup on success, failure, and cancellation,
independent concurrent openings, the same trace at resolve, rejected OPENED
posts followed by a READY retry, and stale document, generation, epoch, startup,
build, and runtime identities. These tests establish product lifecycle behavior
only; they do not inject or validate a VS Code host or renderer failure.

## Boundary and rollback

This decision adds no network request, worker, source mutation, or automatic
AI invocation. Remove the command and diagnostic module to roll back; the
editor and navigator remain usable.
The create observation can be removed independently from `openCustomDocument`
without changing creation, cancellation, or the existing resolve watchdog.
