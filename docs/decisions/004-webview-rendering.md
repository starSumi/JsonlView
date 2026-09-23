# ADR-004: Webview Rendering And Bounded Detail

Status: accepted

## Pressure

The product needs dense tables, resizable columns, timelines, foldable JSON,
copying, theme integration, and readable long text without retaining a whole
source file in the Webview.

## Invariant

The Webview receives bounded projections, not the complete file. DOM remains
the accessible authority for text and controls; derived views never replace
Raw source evidence.

## Owner

`src/webview/` owns rendering and local UI state. The extension host owns file
reads, limits, generations, and message validation.

## Alternatives

- Native TreeView as the main UI: rejected because it cannot host the dense
  virtualized table/detail workflow.
- Canvas/WebGL/WebGPU for all text: rejected because selection, copying,
  accessibility, and theme behavior would regress without measured need.
- Unbounded Markdown/JSON parsing: rejected because one large record can
  exhaust Webview memory.

## Probe

Check first paint, virtual row count, detail memory, long-line wrapping,
fold/copy behavior, theme changes, keyboard navigation, and truncated/invalid
content across representative profiles.

## Decision

Use virtualized DOM for the primary workbench, bounded syntax/tree previews for
detail, explicit truncation labels, and optional charts only when requested.
The Problems tab is a separate bounded projection: `GET_PROBLEMS` scans
physical records from a cursor, returns `ProblemPage`, and exposes continuation
when the file exceeds the scan budget. It must not derive a supposedly global
problem list from the current visible row page or from the summary counter.

## Evidence

Webview tests, Engine/Host contract tests, CDP smoke captures, `docs/assets/`,
and the harness showcase. A Problems page marked partial is evidence of a
bounded scan window only; it is not evidence that the file has no later
problems.

## Boundary

Rich Markdown is conservative and bounded; unsupported embedded formats remain
plain text or Raw source. A truncated preview is not the full record.

## Revisit Trigger

Revisit rendering only after a measured frame or memory failure identifies a
specific surface that a secondary canvas layer can improve without removing
the DOM fallback.

## Rollback

Switch the affected detail mode to Raw/plain text and preserve the source copy
path. Keep the table and source-bound protocol unchanged.
