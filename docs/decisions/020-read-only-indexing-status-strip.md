# ADR-020: Read-Only Indexing Status Strip

Status: accepted

## Pressure

The Webview needs a stable, low-noise indication of the current bounded
projection: indexed rows, indexed bytes, observed hydration problems, snapshot
state, and progress. A proposed telemetry pill and progressive system state
mix UI guidance with unverified visual and latency claims.

## Invariant

The status strip is a read-only projection of existing authoritative summary
and invalidation fields. It never collects editor telemetry, sends network data,
changes the JSONL source, or becomes a second lifecycle state machine. Status
updates must not move keyboard focus.

## Owner

`src/webview/` owns the presentational strip and responsive layout. The
extension host and engine remain owners of file identity, generations, bytes,
indexing, cancellation, and bounded summary values.

## Alternatives

- Add a persisted `telemetryAlignment` setting: rejected because the current
  product has no demonstrated user need and the setting would add IPC, state,
  test, and compatibility surface.
- Add a status popover or a new telemetry service: rejected because the current
  strip already exposes the bounded values and the product is read-only.
- Apply Gutenberg, F-shaped scanning, Shannon, or invented latency targets as
  layout requirements: rejected because those claims are not primary evidence
  for this Webview contract.

## Probe

Verify DOM order and status semantics in focused tests. In a fresh isolated VS
Code host, exercise wide and narrow container widths, long row/byte labels,
incomplete indexing, append-pending snapshots, disabled Rebuild, keyboard
focus retention, and header overflow. Bind the observed runtime assets to the
candidate archive and retain the lifecycle stop receipt.

## Decision

Render the existing status strip before the toolbar in the wide-layout DOM and
flex order. At the existing `720px` container boundary, keep the strip on its
own row so search and actions remain operable. Keep the existing bounded metrics,
`role="status"`, `aria-live="polite"`, and numeric `progressbar`; do not add
new fields, settings, IPC messages, feature flags, or network telemetry.

The placement and layout decisions are grounded in the [VS Code Status Bar UX
Guidelines](https://code.visualstudio.com/api/ux-guidelines/status-bar) as a
placement reference, the [WAI-ARIA status
role](https://www.w3.org/TR/wai-aria-1.2/#status), [WCAG 2.2 status
messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html),
the [CSS Containment Level 3 container-query
specification](https://www.w3.org/TR/css-contain-3/), and the [VS Code Webview
guide](https://code.visualstudio.com/api/extension-guides/webview). The VS Code
guideline is not treated as a normative Webview ordering rule.

## Evidence

`test/webview/workspace-header.test.ts` covers bounded progress, observed
problem wording, pending snapshots, DOM order, and long labels. Installed-host
geometry, focus, and artifact identity remain harness evidence. Current global
coverage is recorded separately; this ADR does not claim that the repository has
reached an 80% aggregate threshold.

## Boundary

This decision changes only Webview presentation. It does not change physical
JSONL framing, semantic profiles, engine queries, native code, persisted state,
IPC, editor content sharing, MCP, or release authorization. Harness task
packages, screenshots, lifecycle receipts, and coverage reports remain outside
the product checkout.

## Revisit Trigger

Revisit when measured host geometry shows the existing responsive breakpoints
cannot preserve controls, when a user-owned status detail action is requested,
or when a new authoritative state field requires a visible representation.

## Rollback

Revert the status-strip placement and CSS order as one small change. Retain the
focused tests and failed host evidence; do not alter query, generation, or
summary contracts.
