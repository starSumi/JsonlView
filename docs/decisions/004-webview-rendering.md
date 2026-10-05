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
- Repeating the source filename in the Webview header: rejected because the
  VS Code editor tab and breadcrumb already identify the open resource.
- Forcing every header control into one row at every width: rejected because
  search and status need room to remain readable and operable.

## Probe

Check first paint, virtual row count, detail memory, long-line wrapping,
fold/copy behavior, theme changes, keyboard navigation, and truncated/invalid
content across representative profiles.

## Decision

Use virtualized DOM for the primary workbench, bounded syntax/tree previews for
detail, explicit truncation labels, and optional charts only when requested.
Keep the workspace header presentational: the host identifies the file, while
the Webview header groups profile, Follow, query, and rebuild controls with
bounded status. `App.tsx` retains query and source-generation state. Use CSS
inline-size container queries for header-local reflow; allow a second control
row when space is tight instead of hiding search behind a new interaction.
The status region announces non-urgent indexing changes without moving focus.
The Problems tab is a separate bounded projection: `GET_PROBLEMS` scans
physical records from a cursor, returns `ProblemPage`, and exposes continuation
when the file exceeds the scan budget. It must not derive a supposedly global
problem list from the current visible row page or from the summary counter.

## Evidence

Webview tests, Engine/Host contract tests, CDP smoke captures, `docs/assets/`,
and the harness showcase. A Problems page marked partial is evidence of a
bounded scan window only; it is not evidence that the file has no later
problems.

The layout and accessibility contracts are grounded in the
[W3C CSS Containment Level 3 container-query specification](https://www.w3.org/TR/css-contain-3/),
[WCAG 2.2 Reflow criterion and guidance](https://www.w3.org/WAI/WCAG22/Understanding/reflow),
and the [WAI-ARIA status role](https://www.w3.org/TR/wai-aria-1.2/#status).
The [VS Code Webview guide](https://code.visualstudio.com/api/extension-guides/webview)
defines the host theme and accessibility hooks used by this surface. The
320-CSS-pixel reflow criterion is a validation target, not a claim that the
current header has passed a narrow-host interaction check.

## Boundary

Rich Markdown is conservative and bounded; unsupported embedded formats remain
plain text or Raw source. A truncated preview is not the full record.
Container queries govern header presentation only; detail-drawer sizing and
source-generation behavior keep their existing owners. Preserve keyboard
focus, labels, and access to search and Rebuild while the container narrows.

## Revisit Trigger

Revisit rendering only after a measured frame or memory failure identifies a
specific surface that a secondary canvas layer can improve without removing
the DOM fallback.

## Rollback

Switch the affected detail mode to Raw/plain text and preserve the source copy
path. Keep the table and source-bound protocol unchanged.
For header regressions, restore the prior header layout without changing
generation, query, or detail state.
