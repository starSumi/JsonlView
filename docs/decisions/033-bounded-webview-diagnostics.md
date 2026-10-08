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

## Alternatives and deferred work

- Registering a service worker to suppress the host error was rejected: the
  product has no worker requirement and renderer lifecycle ownership belongs to
  VS Code.
- Calling Claude/Copilot/Codex pane identifiers directly was rejected: those
  commands are provider-owned and are not a stable VS Code extension contract.
- An MCP diagnostic tool is deferred until the read-only local MCP transport
  has its own trust, cancellation, output, and audit gate.

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

## Boundary and rollback

This decision adds no network request, worker, source mutation, or automatic
AI invocation. Remove the command and diagnostic module to roll back; the
editor and navigator remain usable.
