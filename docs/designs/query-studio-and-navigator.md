---
id: "query-studio-and-navigator"
path: "docs/designs/query-studio-and-navigator.md"
title: "Query Studio And Navigator Interaction Contract"
kind: "design"
status: "active"
owner: "product"
tags: ["accessibility","insights","navigator","query","webview"]
evidence: []
revisit: "when a queued interaction or native Navigator composition is accepted"
rollback: "restore the previous header composition and retain physical sources"
---
# Query Studio and Navigator interaction contract

The selected Compact rail direction keeps all five view names reachable and
anchors one Query Studio to the common second toolbar row. The selected
interaction includes Pin, resizing, maximize/restore, defaults and explicit
close. Selecting this direction does not establish that every interaction is
implemented or that the newer Navigator composition has passed visual review.
The [theme baseline](theme-adaptation.md), [ADR-019](../decisions/019-webview-query-and-keyboard-ownership.md),
[ADR-045](../decisions/045-table-query-and-column-ownership.md) and
[ADR-060](../decisions/060-shared-query-anchor-and-treemap-metadata.md) retain
their respective theme, query, source and metadata boundaries.

## Delivery state

This table records the isolated candidate boundary. Update individual rows
when their implementation and corresponding evidence change; a passing row
does not close the remaining requirements.

| ID | Requirement | Current state |
| --- | --- | --- |
| Q1 | One Studio trigger in the common second row for Table, Timeline, Schema, Problems and Insights; Table quick controls retain Table scope | Implemented candidate; integrated product and real-host acceptance pending |
| Q2 | Existing query controller, explicit Run/Cancel, fill-only presets and valid focus return | Implemented candidate; cross-view Close/Escape regression requires correction before acceptance |
| Q3 | Pin lifecycle, outside dismissal, resize, maximize/restore and viewport constraints | Queued for the selected interaction contract below |
| Q4 | Host-owned default dimensions and default Pin setting | Queued; defaults below are the implementation contract, not existing settings |
| T1 | Bounded metadata-only Treemap DTO, runtime guard and pure layout | Implemented candidate; reviewed corrections and integrated checks pending |
| T2 | Treemap Host producer, current-intent admission and Insights consumer | Queued; metric accounting and provenance decisions are prerequisites |
| N1 | Upper Curated and lower Runtime domains, independent collapse and height allocation | Required semantic separation; combined visual composition pending review |
| N2 | Collection ownership, persistence, reference lifecycle and Collect/reveal | Queued product decision and implementation; source authorization is not a collection store |
| N3 | Source actions on the left, direct-open leaves and secondary Info/Recovery | Required across the native Navigator and future Curated surface; actual native composition requires host acceptance |
| N4 | Cross-root context membership and bounded discovery/query/anchor recovery | Retained follow-up requirements; no new query engine or entity graph is accepted by this document |

## Shared anchor and query ownership

`src/webview/App.tsx` composes the existing `TopQueryStudio` once in
`WorkspaceHeader.secondary`. Opening Studio leaves header height and active
view placement unchanged. Table search, row types, field filters and Columns
remain scoped as described by ADR-045. Tabs remain visible or reachable by
horizontal scrolling on narrow panes, with selected and focused states that
do not depend on color alone.

The record-query controller remains the only row-query intent owner. Studio
edits the existing condition draft and Run uses its existing bounded predicate
route. Merely opening Studio or choosing a preset performs no query. Cancel
retains current request correlation and generation barriers. Current presets
are text-search starters; SQL-shaped examples and named parameter examples
are design material, not an executable SQL or bind-parameter capability.
Any later language selection needs its own contract, tests and decision.

Capture a valid Table cell and its source generation when Studio opens from
Table. Explicit Close or a scoped, non-composing Escape restores that cell
only when its bridge and identity remain valid; otherwise focus returns to
the connected shared trigger. Capture the return target at opening rather
than deriving it only from the tab active at closing. In particular,
Timeline -> open -> Table -> Close/Escape must still return focus. A stale
cell must not read a record or borrow a newer generation. If the invoking
trigger was replaced, use the current mounted Studio trigger as the bounded
fallback. Outside dismissal and view activation retain the newly selected
focus target rather than stealing focus back.

## Selected Studio session behavior

The panel is a non-modal overlay. App owns the open session and coordinates a
focused presentation hook/component; that component owns pointer, keyboard,
focus and resize cleanup. One session contains `open`, `pinned`, desired normal
dimensions, maximized state and the pre-maximize dimensions. It does not add a
second query controller, a durable layout store or a new source owner.

| Event | Unpinned | Pinned |
| --- | --- | --- |
| Outside pointer activation or focus moving outside | Close; preserve the destination action/focus | Remain open |
| Successful dispatch of Run | Close after dispatch; preserve the existing query lifecycle | Remain open |
| Active view changes | Close; retain selected view and its focus | Remain open at the shared anchor |
| Explicit Close or scoped Escape | Close and end this panel session | Close and end this panel session |
| Pin toggle | Change only the current session | Change only the current session |

Pin means keep open. It does not lock position, prevent resizing or survive
explicit closure. Its accessible name, pressed state and tooltip explain that
meaning. Escape during IME composition is ignored. Run and Cancel shortcuts
remain scoped to the Studio; unrelated views do not acquire global listeners.
Unmount, source retirement and explicit closure clean up active pointer/resize
listeners. Reopening creates a fresh session using the latest Host defaults.

The selected starting size is 640 by 430 CSS pixels. Normal placement follows
the common trigger below row two and uses the available editor viewport,
including when the native sidebar or detail drawer changes size. Reserve the
prototype's 12 px horizontal margins, 8 px anchor gap and 14 px bottom margin
where space permits. Available width and height take precedence over normal
minimum dimensions; tiny panes must not force an outer scrollbar or conceal
Close. Internal content scrolls. Persist desired normal dimensions only in the
current open session so shrinking and re-expanding a viewport can reclamp them
without treating a temporary clamp as a user's new preference.

The lower-right resize handle adjusts both dimensions. Visible, labelled
width/height decrement and increment buttons provide a keyboard alternative,
using 20 px steps. Normal desired dimensions stay within the configuration
bounds below; actual dimensions may be smaller when constrained by the viewport.
Maximize fills the available area below the two-row header. Restore returns
to the saved normal desired dimensions, clamped against the current viewport.
Resizing while maximized must first restore or be explicitly disabled.
Neither resize nor maximize writes settings. Theme tokens, high contrast,
focus indicators and accessible size readouts remain observable.

## Host configuration contract to implement

| Setting | Type | Default | Legal configured value |
| --- | --- | --- | --- |
| `jsonlView.queryStudio.defaultWidth` | integer | 640 | 480 through 1100 CSS pixels |
| `jsonlView.queryStudio.defaultHeight` | integer | 430 | 320 through 800 CSS pixels |
| `jsonlView.queryStudio.defaultPinned` | boolean | false | true or false |

Declare all three with explicit `window` scope in `package.json`. This follows
the official [VS Code configuration contribution](https://code.visualstudio.com/api/references/contribution-points#contributes.configuration)
contract: user, workspace and remote settings may apply, while folder-specific
overrides are not part of this choice. Invalid, non-finite, fractional,
out-of-range or missing numeric values independently fall back to their default;
an invalid Pin value falls back to false. Do not coerce strings to numbers.

`src/extension/extension.ts` reads and sanitizes configuration through VS Code's
configuration API. `src/extension/webview-html.ts` remains the existing bootstrap
owner for initial bounded defaults. A configuration change must also update the
latest validated defaults for an already mounted Webview through a narrow typed
Host route before its next explicit Studio opening. That update route is queued,
not an existing protocol capability. Keep any added shared payload and guard
under the shared protocol owner, using normal client admission. Configuration
changes do not change geometry or Pin during an open session. The next opening
uses the latest admitted defaults; viewport clamping never changes configuration.

The settings control opens VS Code Settings filtered to these keys. It does not
present a second settings store, write current size on close, or use localStorage.
No workspace-state migration is necessary for ephemeral panel geometry.

## Navigator domains and unresolved visual composition

Upper User Collections is a mutable working set of references. Lower Agent
Sessions is a read-only projection of explicitly authorized runtime sources.
Collections can span directories and worktrees; current working directory is
not their identity or authorization boundary. Add/remove/rename changes user
metadata only. Collection deletion and reference removal never delete, move,
rename or close a physical source. Collect copies a reference, preserves its
destination, then expands, reveals and focuses the destination; duplicates
reuse an established reference identity. Missing or moved sources use an
explicit Recovery/Rebind action without silently authorizing another source.

Each domain needs its own collapse, scrolling, search, sort and refresh path.
When both expand, the host supports independent height allocation and remembered
layout; when one collapses, the other can use the remaining area. The prototype's
custom separator and storage are review mechanisms, not a decision to replace
VS Code's native view management. Current manifest contributions are native
Add source (`jsonlView.sourceDrop`) and Sessions (`jsonlView.sessionNavigator`).
Curated ownership and native contribution changes remain unresolved, so this
document does not prescribe embedding those views in the editor Webview.

The left command surface exposes Drop, Files, Folder, Paste and Connect with
Add Source initially compact. Authorization, refresh, query, sort and recovery
remain discoverable there. Primary activation of a real session or exact JSONL
reference opens JsonlView directly. Info and diagnostics are secondary actions;
the right detail surface never becomes the sole entry to a command.

Follow-up curation decisions must retain the requested collection/subcollection
CRUD, cross-source membership, import and portable manifest export, query within
a collection, copy/reveal reference actions, and explicit Save As Copy & Collect.
They must freeze persistence scope/version, canonical identity/deduplication,
missing-source recovery and authorization before implementation. Current
authorized roots and session-only Recent Previews are separate existing owners.

The broader context requirements remain traceable: alias-aware membership,
separation of state assertions from transcript events, cross-session causal
links and explicit negative evidence. Progressive discovery should expose a
bounded envelope/subtype/low-cardinality taxonomy, then explicit predicates
and exact physical anchors for on-demand hydration; high-cardinality fields
must not expand the default skeleton. Profile normalization and Copy for Agent
must retain source identity, predicate and physical anchors. These are queued
contracts; no new MCP method, graph store, bitmap engine or performance claim
is established here.

## Product implementation task route

Each task starts with a failing behavioral test against its declared owner,
then the smallest implementation, independent review and bounded regression
checks. New files named below are proposed seams, not current capabilities.

| Task | Owned production paths | Prerequisites and behavioral oracle |
| --- | --- | --- |
| Q-A anchor/focus correction | `src/webview/App.tsx` | Q1; extend `test/webview/app-column-projection.test.tsx` with non-Table -> Table Close/Escape, stale cell and missing-origin cases; retain one Run request and no open-time query |
| Q-B defaults and admission | `package.json`, `src/extension/extension.ts`, `src/extension/webview-html.ts`, narrow `src/shared/` contract/guard and existing Webview bootstrap owner | Q4 table; tests in `test/extension/` and `test/shared/` reject invalid/default payloads and verify config changes affect the next opening only; do not broaden query envelopes |
| Q-C panel lifecycle and geometry | `src/webview/features/record-query/TopQueryStudio.tsx`, focused new `query-studio-presentation.ts`, App composition, `src/webview/styles/query-studio.css` | Q-A/Q-B; extend `test/webview/top-query-studio.test.tsx` and `query-studio-keyboard.test.ts`, add pure presentation-policy tests for the event matrix, restore, cleanup and viewport clamping |
| T-A metadata candidate | `src/shared/treemap.ts`, `treemap-layout.ts`, `src/shared/transport/treemap.ts` and barrel | ADR-060; `test/shared/treemap-contract.test.ts` and `treemap-layout.test.ts` cover limits, stale identity, malformed input and representable geometry |
| T-B aggregation/Host producer | Existing `src/aggregation/`, `src/extension/insight-query.ts`, `integrated-session.ts`, `document-controller.ts`, shared Insights contracts/guards | Decide grouped records/bytes, delimiter policy, accounting/truncation and complete AnalysisIntent binding first; extend `test/extension/insight-query.test.ts` plus transport and stale/cancel/failure integration tests |
| T-C Insights consumer | `src/webview/widgets/insights-panel/`, current reducer/client admission | T-B; preserve count/provenance/empty/error/limited states and exact decimal labels; extend `test/webview/insights-chart.test.ts`, `insight-request.test.ts` and consumer tests; no second scanner |
| N-A Curated ownership/native decision | Product ADR, existing `src/application/catalog/`, `src/infrastructure/navigator/` and `src/experimental/session-navigator/` boundaries | N1 visual review and N2 metadata lifecycle decision before code; characterize native manifest/lifecycle/direct-open behavior in existing Navigator tests; do not repurpose authorized sources |
| N-B Curated implementation | Narrow owners selected by N-A, native contribution/command owners in `package.json` | N-A contract and approved visual composition; negative tests cover duplicate refs, removed/revoked sources, persistence recovery and source-byte preservation; collect/reveal host probe required |

Native-host acceptance binds the integrated revision and actual script/CSS
identity. Observe all five tabs, shared anchor, Pin matrix, Run/Cancel, focus
return, resize/maximize/restore, configuration reopening, theme states and
narrow panes. Navigator acceptance separately observes native collapse/layout,
direct open, all left command entries and source preservation. Treemap
acceptance separately binds current intent, producer provenance and consumer
states. Pure layout tests, SSR and prototype browser interaction cannot replace
those observations. Run the mandatory product gates from `AGENTS.md` for an
integrated implementation change. Roll back task-owned presentation, contract
and test files together; physical JSONL and provider data remain authoritative.
