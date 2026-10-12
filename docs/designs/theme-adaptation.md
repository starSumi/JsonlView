# Theme Adaptation Design

Status: accepted

This document is the product design baseline for JsonlView's Webview visual
adaptation. It records the approved composition and interaction rules. It is
not an ADR, a theme extension, or a harness report.

## Purpose

JsonlView is installed inside a user's existing VS Code window. The product
must provide a coherent data-studio workbench while remaining legible and
native beside the user's editor, terminal, and other extensions. The visual
system therefore adapts to the host theme instead of becoming a second theme
owner.

## Approved direction

### Neutral Contrast

**Neutral Contrast** is the product's default visual direction. Its hierarchy
comes from spacing, borders, typography, density, and semantic emphasis. It
does not require a brand palette or a fixed light/dark color set.

### Compact Focus in dark mode

Dark host themes may use the **Compact Focus** density and layout rhythm:
compact but stable row heights, restrained surface separation, and clear focus
placement for long agent trajectories. This is a layout decision, not a color
decision. The product must never infer or hard-code a dark palette.

### Host theme ownership

Every runtime color comes from a VS Code semantic token (`--vscode-*`). The
implementation may use token aliases when a more specific host token is absent,
but it must not introduce fixed hex, RGB, HSL, named color, or brand-color
fallbacks. Opacity and geometry may vary by state; the underlying color still
comes from the host token.

The Webview must not:

- install or activate a user theme;
- write `workbench.colorCustomizations`;
- set a forced `color-scheme`;
- change the user's global VS Code settings;
- assume that a theme contributes product-specific custom variables.

User-installed themes and accessibility themes remain authoritative. A host
theme change while the editor is open must update the surface through the
existing VS Code token values without rebuilding the document or changing query
state.

## Token and state contract

The following semantic roles are stable. The exact token mapping may evolve
when VS Code adds a better semantic token, but the role and fallback behavior
must remain observable.

| Role | Host semantic token family | Product use |
| --- | --- | --- |
| Workbench surfaces | `--vscode-editor-*`, `--vscode-sideBar-*`, `--vscode-editorWidget-*` | editor, drawer, popover, and secondary surfaces |
| Primary text | `--vscode-editor-foreground` | record values, headings, and controls |
| Secondary text | `--vscode-descriptionForeground` | metadata, summaries, and quiet status |
| Borders and dividers | `--vscode-editorWidget-border`, `--vscode-panel-border` | table rules, drawer boundaries, and separators |
| Keyboard focus | `--vscode-focusBorder` | focus-visible outlines and active control affordances |
| Hover | `--vscode-list-hoverBackground` | pointer and keyboard hover preview |
| Active selection | `--vscode-list-activeSelectionBackground` and `--vscode-list-activeSelectionForeground` | selected row or active navigation item |
| Inactive selection | `--vscode-list-inactiveSelectionBackground` and `--vscode-list-inactiveSelectionForeground` | selected row when the grid has lost focus |
| Text selection | `--vscode-editor-selectionBackground` and `--vscode-editor-selectionForeground` | user-selected text only |
| Scrollbar | `--vscode-scrollbarSlider-background`, `--vscode-scrollbarSlider-hoverBackground`, `--vscode-scrollbarSlider-activeBackground` | scroll thumb states |

Selection states are distinct. A focused grid cell uses the active selection
role and a focus-visible outline; a grid that loses focus uses the inactive
selection role. Native text selection uses the editor selection role. The
browser's default selection blue must not leak into the workbench state model.
Rows and cells must retain readable text and a stable geometry in every state.

## Content fidelity and display truncation

The source JSONL bytes remain the authority for every provider and profile. A
table cell, summary, Markdown view, diff, patch, tree node, or semantic tool
presentation is a disposable display projection. A provider adapter may choose
which fields to present, but it must not redefine whether the source is complete
or silently replace source content with a preview.

### Presentation state

Every bounded content surface exposes the same provider-neutral state model,
whether the record came from a generic JSONL file, Claude, Codex, Pi, OTLP, or
another supported profile:

| Field | Values | Meaning |
| --- | --- | --- |
| authority | `source`, `derived` | Whether the view is a source-backed range or a computed presentation |
| visibility | `complete`, `bounded`, `unavailable`, `malformed` | Whether the requested display content is fully available in this view |
| omission | `none`, `display-budget`, `malformed-input`, `unsupported-shape` | Why content is absent; this is product metadata, never source text |
| copy | `exact-range`, `derived-rendering`, `unavailable` | What a copy action is allowed to place on the clipboard |

The state is attached to the presentation envelope or view model. It is not
inserted into the Raw payload, parsed JSON, Markdown, diff, patch, or provider
message. `bounded` means the product display budget was reached; it must never
be labelled as a source truncation. `malformed` means the source could not be
parsed or decoded within the contract; it is distinct from a valid but bounded
display. `unavailable` means the requested projection is not available without
claiming that the source is empty.

### UI and copy contract

- A complete source-backed surface has no truncation badge.
- A bounded surface shows an explicit product label such as `Display limited`
  and, when known, the applied byte, line, item, or nesting budget. The label
  must not say `Source truncated` unless the source itself contains an explicit
  producer field with that meaning.
- Malformed and unsupported states use distinct status text and badges from
  display-budget state. Unknown provider records remain inspectable through Raw
  and do not inherit another provider's wording.
- Raw remains the authority view. It may itself be bounded for memory or layout
  safety, but the UI must expose the bounded range and retain a path to inspect
  the source-backed range; it must not imply that the visible slice is the whole
  record.
- Copying a source-backed view copies only the exact displayed source range and
  never copies the status badge or its explanatory text. When a source-backed
  view is bounded, the action is labelled as copying the visible range.
- Copying a derived view is labelled or scoped as derived content. A diff,
  patch, Markdown rendering, tree summary, tool summary, and provider-specific
  projection must never be presented as the original record.
- When no exact source range can be determined, source copy is unavailable; the
  product must not silently substitute a derived summary.

These rules apply equally to Claude, Codex, Pi, generic logs, telemetry, and
future adapters. Provider-specific builders own semantic labels and field
selection; the shared presentation contract owns authority, visibility,
omission, and copy semantics. Adding a provider therefore cannot introduce a
new interpretation of truncation.

## Layout and interaction rules

- The primary table remains a virtualized DOM grid. Header, body, and detail
  surfaces keep an opaque, token-backed stacking layer so rows cannot bleed
  through a sticky header or drawer boundary.
- The column chooser and other bounded popovers keep a stable scroll gutter,
  contain overscroll, and preserve the current scroll position while their
  options or viewport change. They must be reachable with the keyboard and must
  not flicker when a pointer crosses the scrollbar.
- Scrollbars remain discoverable and native to the host. They may be compact,
  but they must not be hidden, replaced with a fixed product color, or allowed
  to move layout content when they appear.
- Focus-visible styling is always available without relying on pointer hover.
  Closing a popover or detail surface returns focus to its invoking control when
  the host still contains that control.
- Density changes must use stable dimensions for rows, controls, and fixed
  format surfaces. Text may wrap or reflow; labels must never overlap adjacent
  controls.
- At narrow widths, controls reflow within the Webview container. Search,
  rebuild, profile, and status affordances remain operable; none is hidden as a
  substitute for responsive layout.

## Fallback and accessibility

Fallback is token-based and monotonic: use a specific VS Code semantic token,
then a related host semantic token, then the broad editor or panel token. Do
not fall back to a literal color. If a host does not expose a specialized token,
the surface may lose subtle contrast but must retain readable text, borders, and
focus visibility through the broader token.

The acceptance matrix includes a standard light theme, a standard dark theme,
high contrast themes, and a user theme with sparse optional tokens. It checks
keyboard navigation, focus-visible state, text selection, reduced-motion
behavior, 320 CSS-pixel reflow, and readable content at the smallest supported
viewport. Color is never the only signal for selection, status, or failure.

## Ownership and lifecycle

**Owner:** `src/webview/` owns runtime presentation, state styling, and visual
interaction tests. The extension host remains the owner of document lifecycle,
transport, and source state. Product maintainers own this design document and
the public documentation link.

**Lifecycle:** this is the accepted baseline for the current modular product.
Any change to semantic token roles, selection/focus behavior, scrollbar
visibility, responsive affordances, or host-theme ownership must update this
document in the same change and run the documented acceptance checks. A
cross-cutting lifecycle or protocol change belongs in `docs/decisions/` as a
separate ADR; do not turn this design note into a duplicate decision record.

The harness may contain synthetic screenshots and review variants named
Neutral Contrast or Compact Focus. Those artifacts are human review inputs
only. The product does not load harness files, screenshots, local paths, or
private transcripts at runtime.

## Non-goals

- Shipping a JsonlView VS Code theme extension.
- Replacing a user's installed theme or mutating VS Code color settings.
- Guaranteeing identical colors across themes, operating systems, or display
  profiles.
- Making Compact Focus a universal dark palette or a separate product mode.
- Replacing the DOM grid with canvas, WebGL, or a custom scrollbar engine.
- Treating a screenshot as proof of accessibility, performance, or installed-host
  compatibility.

## Validation and rollback

For a documentation-only update, run:

```text
pnpm check:agent-spec
pnpm check:docs-index
```

For an implementation change covered by this design, additionally run the
product's mandatory contract, formatting, type, test, and build commands from
`AGENTS.md`, plus focused Webview tests and a real VS Code host check. Review
the same interaction matrix in light, dark, and high-contrast themes. Record
the product revision and validation boundary; do not copy machine-local paths
or raw host logs into product documentation.

If the visual change regresses readability, focus, scrolling, layout stability,
or host-theme compatibility, revert the implementation to the last accepted
token mapping and preserve the source, query, generation, and transport
contracts. A rollback must not modify user settings or require a harness
artifact.
