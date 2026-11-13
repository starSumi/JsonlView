---
id: "061-virtualized-list-a11y-semantics"
path: "docs/decisions/061-virtualized-list-a11y-semantics.md"
title: "Virtualized List Accessibility Semantics"
kind: "decision"
status: "accepted"
owner: "product"
tags: ["accessibility","webview","virtualization"]
evidence: []
revisit: "when Timeline or Problems virtualization or keyboard interaction changes"
rollback: "restore the prior list containers and role mapping while retaining the focused semantic tests"
---
# ADR-061: Virtualized List Accessibility Semantics

Status: accepted for the Timeline and Problems semantic-list slice. Schema
treegrid semantics remain a separate C2 task with its own keyboard and focus
contract.

## Pressure

Timeline and Problems used ARIA list roles on generic containers and buttons.
The role mapping described a list, but it did not use the native list structure
that assistive technology expects and made the interactive control itself carry
the item role.

## Invariant

The Timeline and Problems views expose a real `ul` with an accessible label and
direct `li` items. Each `li` contains the existing native `button`, preserving
the button's keyboard activation, selection callback, disabled document-row
behavior, and loading-disabled Continue scan action. Virtualizer count,
overscan, estimated heights, absolute positioning, transforms, scroll bounds,
and selection styling remain unchanged. The Schema treegrid is intentionally
out of scope.

## Owner

`src/webview/views.tsx` owns the semantic element composition and existing
interaction callbacks. `src/webview/styles/views.css` owns list reset and
virtual-item layout. Focused Webview tests own the semantic and invariant
regression checks.

## Alternatives

- Keeping `role="list"` and `role="listitem"` on `div` and `button` preserves
  markup shape but retains the inaccurate native-semantic mapping.
- Making each button the direct child of `ul` would require assigning the
  button the list-item role again and would conflate interaction and structure.
- Removing virtualization would simplify the DOM but changes bounded rendering
  and scroll behavior without addressing the semantic ownership problem.

## Decision

Keep the scroll viewport as a `div` because it owns the existing scroll
element. Render a labelled `ul` as the virtual-space element and render each
virtualized entry as a direct `li`; the existing button remains inside the
item. Reset list markers, margins, and padding so native list defaults do not
change the current visual geometry. Keep Schema's `treegrid` markup unchanged
for its independent keyboard and focus work.

## Probe

Focused `views.test.tsx` assertions verify labelled `ul` elements, direct `li`
items, absence of the former synthetic list roles, native button selection
styling, and the disabled Continue scan state. The existing virtualizer mock
continues to render every supplied item so the assertions cover each semantic
entry without changing production virtualization.

## Evidence

The focused Vitest test and the repository's Biome, docs-index, agent-spec,
contract, and TypeScript gates establish candidate behavior at source level.
They do not establish installed VS Code host acceptance or keyboard behavior
in every assistive technology. The existing Schema treegrid's twelve explicit
ARIA row, columnheader, and gridcell nodes retain narrow per-node Biome ignores
for the two diagnostics that require the separate keyboard/focus C2 contract;
these comments are temporary boundary markers and must be removed when that
task supplies its replacement semantics.

## Boundary

This is a C2 Webview semantics change limited to Timeline and Problems. It does
not change the shared protocol, source reads, query ownership, selection
identity, scan continuation policy, or Schema treegrid contract.

## Revisit trigger

Revisit when virtual item composition, keyboard/focus behavior, scroll strategy,
or list labels change. Start the separate Schema treegrid C2 task before
changing its role hierarchy or keyboard interaction.

## Rollback

Revert the task-owned JSX and list-reset rules together, then rerun the focused
view tests and required static gates. Keep this ADR as the historical record if
the semantic implementation is superseded.
