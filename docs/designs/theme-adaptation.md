---
id: "theme-adaptation"
path: "docs/designs/theme-adaptation.md"
title: "Theme Adaptation Design"
kind: "design"
status: "accepted"
owner: "product"
tags: ["accessibility","content-fidelity","design","vscode-theme","webview"]
evidence: []
revisit: "when host-theme ownership or interaction tokens change"
rollback: "restore the accepted design baseline"
---
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

### Two-row workbench header

The workbench header uses two stable rows at normal width. The primary row
starts with the Session Navigator action at the far left, followed by the
existing workspace view tabs and file context, then Profile, Follow, and the
refresh or rebuild action. Profile keeps a short explanatory tooltip so the
profile selector does not need a second help panel for its basic meaning.
The half-filled Navigator glyph reflects whether either Collections or Agent
Sessions is visible and expanded. VS Code exposes visibility per view, so a
container with both child views collapsed is reported as not visible.

The secondary row separates telemetry from query controls: bounded rows, bytes,
valid/problem observations, phase, and progress stay in the left group; search,
order, field filters, row types, and Columns stay in the right group. The query
input has a bounded width. At workspace widths of 700px or less, view tabs use
their icons and compact counts; each tab keeps an explicit accessible name and
tooltip. At 1050px or less, Profile and secondary status labels collapse while
the Follow label remains visible. At workspace widths of 900px or less, query
controls stay on one horizontal rail; when they do not fit, that rail scrolls
with a thin host-token scrollbar that stays transparent at rest and appears on
pointer hover or keyboard focus. The search input shrinks before the other
controls, while keyboard tab order and accessible labels remain available. This
inner rail must not create an outer horizontal scrollbar or displace telemetry
status.
Below 520px, Navigator and the icon tabs share the first primary row; Profile,
Follow, and Rebuild use the next row without clipping.

The header and its controls use host semantic tokens and the same focus, hover,
active, and disabled states as the existing VS Code-native controls. The
layout change does not alter source bytes, query scope, or indexing semantics.
The compact Conversation projection remains dormant until its profile-aware
format contract is accepted; the shipped toolbar exposes the single Table view
entry.

### Native Session Navigator source actions

The Agent Sessions sidebar uses native VS Code TreeView rows for `Detected
sources` and `Connect local agent…`, alongside authorized sources. Their short
labels use the host's normal truncation and tooltip behavior; they add no
minimum sidebar width or custom horizontal rail. Keep the connection action in
the scrollable tree so provider choice remains reachable when title actions
collapse into overflow at narrow widths. `Detected sources` stays collapsed by
default and checks only for eligible provider roots when expanded. Detection
does not grant access or start a session scan; choosing a candidate is the
explicit authorization action. The lower Agent Sessions `Add Source` title
action remains the file, folder, and paste intake route.

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
| Disabled controls | `--vscode-disabledForeground`, `--vscode-descriptionForeground` | disabled control glyphs when the specialized token is absent |
| Active selection | `--vscode-list-activeSelectionBackground` and `--vscode-list-activeSelectionForeground` | selected row or active navigation item |
| Active option | `--vscode-inputOption-activeBackground`, `--vscode-inputOption-activeBorder`, and `--vscode-inputOption-activeForeground` | selected choice in a compact radio group, including row order |
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
- The detail drawer scrolls only the selected record. Selecting another record
  starts its content at the top and preserves the active detail tab; scrolling
  within the drawer never changes record selection.
- With Follow enabled, reading history keeps a physical row anchor and its
  visible offset while source updates continue. A token-backed control at the
  bottom of the primary pane offers Back to bottom and announces New activity
  when the latest physical record has not been seen. It clears only when that
  record is visible. Search, selection, and existing keyboard navigation take
  precedence over automatic scrolling. Safe generation rebinding preserves
  the selected detail's scroll and expanded content.
- The column chooser and other bounded popovers keep a stable scroll gutter,
  contain overscroll, and preserve the current scroll position while their
  options or viewport change. They must be reachable with the keyboard and must
  not flicker when a pointer crosses the scrollbar.
- Scrollbars remain native to the host and keyboard-scrollable. A compact thumb
  may stay transparent at rest when pointer hover or keyboard focus reveals its
  host-token state; scrolling must not depend on hover alone or move layout
  content.
- Focus-visible styling is always available without relying on pointer hover.
  Closing a popover or detail surface returns focus to its invoking control when
  the host still contains that control.
- Density changes must use stable dimensions for rows, controls, and fixed
  format surfaces. Text may wrap or reflow; labels must never overlap adjacent
  controls.
- At narrow widths, controls reflow within the Webview container. Search,
  rebuild, profile, and status affordances remain operable. Visible text may
  collapse only when an icon and accessible name preserve the control identity.

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
Compact mutually exclusive choices use native radio inputs so keyboard focus
stays on one choice and selection remains available without a pointer. Forced
colors preserve a visible selected state and focus outline. Workspace tabs use
the host's tab active-border token on their bottom indicator without changing
label weight or control geometry.
Secondary source actions use the host's secondary-button border token, with a
two-column layout below 240 CSS pixels and forced-colors system colors. Narrow
header rules target the nested query toolbar in the rendered DOM. View tabs
retain accessible names and tooltips in icon-only mode; Search, Profile, Follow,
and Rebuild remain available as the host pane narrows.

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

Workspace tabs, status, Profile and Follow share the top bar. The second bar
belongs to the left Table workspace: display mode, Search, Row types, Field
filters and Columns. The right drawer retains selected-record controls.
The temporary-source badge stays visible and Save As stays reachable in this
workspace at every width; other views retain them in the top bar. Responsive
rules may hide secondary metrics and decorative labels while preserving access
to these lifecycle actions and the Navigator entry. Tabs scroll horizontally
when necessary. The Table
query toolbar stays on one row and uses CSS container queries inside the Table
pane to compact and collect actions without creating a third header row or a
horizontal scroll rail. At 760 CSS pixels, controls use their compact icon
presentation while retaining accessible names. At 540 pixels and below, one
native More Actions disclosure contains Save As and Columns; the same controls
remain inline above that boundary, with no duplicate stateful controls. A
single Filters entry keeps both Field filters and Row types available as core
query actions at every width. At 420 pixels, the toolbar remains single-row,
keeps Search usable, and does not move Filters into More Actions. CSS container
queries own these presentation thresholds; toolbar reflow does not use
JavaScript viewport measurements or resize listeners. The detail drawer's
interactive width clamp, modal focus behavior and popover placement retain
their viewport-aware responsibilities. Native disclosure popups remain inside
the Table pane with a scrollable body, using their existing placement behavior.
Labels, focus rings, input borders and selected checkboxes use existing VS Code
tokens in light, dark and high-contrast themes. Column groups distinguish common
profile columns, selected record fields, short scalars and searchable Advanced
fields. ADR-045 owns their query and projection semantics.

The Columns disclosure presents common/default fields first and dynamic record
fields second as one reusable checkbox/disclosure tree. A field can expose both
its display checkbox and a nested Match row values branch. Multiple selected
values retain the existing OR semantics within that condition; display-only
checkboxes never change query predicates. Array presentation groups such as
`type[]` expand into exact indexed paths and do not introduce wildcard queries.
Collapsed branches do not mount their descendants. Each level starts with at
most 24 items and offers an explicit Show more action; search preserves matching
ancestors without expanding every descendant. Long paths wrap inside the
scrollable disclosure. Native details/summary keyboard behavior and existing
host selection/focus tokens remain in use.

Query Studio uses one neutral, icon-only Play glyph in the shared query header,
replacing the former sliders entry. Its accessible name and tooltip describe
Open Query Studio or Close Query Studio, matching the current dialog state.
The trigger opens or closes the dialog without submitting a query. Search Enter
and the dialog's Run query action or Ctrl/Cmd+Enter retain query submission;
closing retains the existing reading-anchor and focus restoration. The icon
uses the host foreground, toolbar-hover and focus-border tokens on a transparent
surface. The compact search toolbar does not add a second Play action. Removing
the separate table Row Types entry must preserve its functionality under the
corresponding field branch, including multi-selection and clearing.

Inside Query Studio, Run query uses a primary host-token capsule with a Play
glyph and a platform shortcut hint. Normal and compact forms have 28-pixel and
26-pixel minimum heights. Real rows pending state changes the capsule to a
quiet Scanning status and a separate native Cancel button, without estimated
bytes or elapsed time. Its polite status region excludes the interactive
button. The same button stays mounted through state changes, preserving focus
in a pinned Studio. Cancel remains available even when new queries cannot run.
Click, search Enter and Ctrl/Cmd+Enter share availability and pending guards;
modified Enter cannot fall through to native form submission while blocked.
Escape cancels pending work and otherwise closes. Unpinned Run and Cancel keep
the existing close and focus-restoration behavior. The capsule uses primary
and secondary button tokens, host borders, descriptions and progress colors;
reduced motion disables its spinner and transition while retaining status text.
It wraps within the available Studio width and retains visible action names.

The field-filter disclosure uses a funnel and retains its Field filters label,
conditions, clear actions and native disclosure behavior. The column chooser
uses the original three-column glyph while keeping the shared field/type tree.

Conversation is a persisted display choice inside the Table workspace. It uses
the same physical records, query, ordering, pagination, selection and reading
anchors. User and assistant cards have a bounded four-line source-text preview;
tool, system and reasoning records remain compact strips. Unknown records use
neutral labels and source summaries rather than an invented agent role.
Opening a card requests details only for that selected record. Source truncation
is stated as Preview limited; visual line clamping always offers Open record.
No image, tool path, link or embedded HTML is resolved by the compact preview.

Role accents use existing host text-link, chart and border tokens; role words
provide the same distinction without color. Selected rows and keyboard focus
continue using the grid's host selection/focus tokens. Cards have deterministic
132-pixel or 42-pixel geometry, independent of theme or width, so reflow does not
change physical reading anchors. Changing display mode clamps only the saved
intra-record pixel offset to the new card height. A maximum 500-row page remains
virtualized; no transcript-wide DOM or per-row detail request is introduced.

## Navigator intake canvas

The editor-area Import canvas uses the host editor/surface background, text,
description, border, focus, list-drop and button tokens. It puts Choose files,
Choose folder and Paste JSONL above a wide drop target. Native Collections and
Sessions keep their own layout, selection and focus ownership. Source permission
and temporary preview state remain host-owned; see
[ADR-086](../decisions/086-import-canvas-and-toolbar-entrypoint.md).

The canvas reflows its action row on narrow windows, keeps accessible button
names, and shows file-drag state with border style as well as color. Forced
colors retain system borders and a Highlight outline. Reduced motion removes
the drop transition. Keyboard focus uses the host focus border. No custom
palette or tree renderer is introduced.

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

### Record Lineage rail

The Detail Drawer Lineage tab uses a single vertical rail with the selected
record outlined by `focusBorder`, a small role icon, physical ordinal and bounded
summary. Upstream, downstream and related labels explain the relationship;
color alone never carries it. Host foreground, description, panel, list,
button, badge and focus tokens own the light/dark/high-contrast appearance.
No source content becomes markup, inline style or an SVG identifier.

Verified unbranched Claude attachment/turn-duration records may appear as
inspectable badges. OTLP logs may attach by non-causal span context. Selecting
metadata always keeps that record as a full card. Shared-parent tool groups
expand in place with 280-pixel internal scrolling and no horizontal branch
tree. Coverage details and exact observed edges remain available in a disclosure.
Missing IDs show an unknown location, without a guessed ordinal.

Click previews the existing bounded row. Enter or double-click explicitly
locates it; a separate action opens the full detail. Arrow keys move between
visible rail records, Left/Right collapse/expand a group, and Escape dismisses
the preview/group before the drawer. A bounded return control survives detail
tab changes. Explicit lookup shows progress and Cancel, then the actual checked
window/outcome. Page/source/profile changes discard stale lookup content.
Default Lineage activation never starts a source lookup.

The rail follows the existing docked/modal drawer breakpoints. Its cards and
badges wrap within the available width; compact workspace geometry reduces
padding and summary lines. Detail tabs scroll within their own row when their
minimum button widths exceed the narrow drawer. The observed-topology dialog uses the same bounded
nodes, native modal focus and a dedicated scroll area. See ADR-078 for evidence,
quotas, lifecycle and the distinction between context and causal relationships.

If the visual change regresses readability, focus, scrolling, layout stability,
or host-theme compatibility, revert the implementation to the last accepted
token mapping and preserve the source, query, generation, and transport
contracts. A rollback must not modify user settings or require a harness
artifact.
