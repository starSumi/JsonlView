# ADR-021: Explicit Row-Order Toggle

Status: accepted

## Pressure

Two adjacent bare arrows in the record toolbar do not identify whether they
move through matches, change pages, or change the physical row order. They also
consume two control slots for one mutually exclusive setting.

## Invariant

The control changes only the existing physical row-order preference. It does
not add a column sort model, alter JSONL framing, change paging, or change the
persisted state contract. Reverse order remains unavailable until the existing
indexing and invalidation gates allow it.

## Owner

`src/webview/features/record-query/RecordQueryControls.tsx` owns the control
label, icon projection, tooltip, and disabled explanation. `state.ts` and the
row-query controller remain owners of persistence and ordering behavior.

## Alternatives

- Keep two bare arrow buttons: rejected because the visual form is ambiguous
  beside the search field and duplicates one binary state.
- Use A/Z or text-only labels: rejected because the data is ordered by physical
  JSONL line and the labels would suggest lexical sorting.
- Add per-column sort controls: rejected because this control is for the
  physical record order, not semantic column ordering.

## Probe

Verify that the server-rendered control has one button, a stable accessible name,
an `aria-pressed` state, a state-specific tooltip, and the existing disabled
reason. Verify that the narrow toolbar keeps its current responsive boundary.

## Decision

Render one toggle button. Use Lucide's `arrow-down-narrow-wide` shape for first
line first and `arrow-down-wide-narrow` for last line first. Keep the accessible
name stable as `Toggle row order`; expose the current mode through
`aria-pressed` and the visible tooltip. Disable the toggle while reverse order is
unavailable and expose the existing reason through `title` and
`aria-description`.

This follows the [Lucide arrow-down-narrow-wide icon definition](https://lucide.dev/icons/arrow-down-narrow-wide),
the [Lucide arrow-down-wide-narrow icon definition](https://lucide.dev/icons/arrow-down-wide-narrow),
and the [WAI-ARIA Authoring Practices button pattern](https://www.w3.org/WAI/ARIA/apg/patterns/button/)
for toggle buttons with a stable name and pressed state. These references
define the control semantics; they do not establish a universal visual
recognition rate.

## Evidence

`test/webview/record-query-controls.test.ts` covers the single toggle, both
directions, stable accessible naming, state-specific titles, and the disabled
reason. Existing state and row-query-controller tests cover persistence and
ordering behavior.

## Boundary

This decision changes only the Webview control presentation. It does not change
the source file, physical offsets, query semantics, page ranges, IPC messages,
native code, or release authorization.

## Revisit Trigger

Revisit if user testing or installed-host evidence shows the sort-shape icons are
still mistaken for navigation, or if a separate semantic column-sort action is
introduced.

## Rollback

Restore the two-button presentation and its focused tests without changing the
persisted `sortDirection` or row-query controller contracts.
