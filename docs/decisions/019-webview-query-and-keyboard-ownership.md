# Webview Query Ownership and Keyboard Interaction

Status: accepted

## Pressure

App previously combined query paging and recovery intents with message
admission, persistence, nonrow reads and rendering. A queued rows response or
replacement snapshot could arrive before React committed the prior action.
Keyboard row navigation also selected records immediately and opened details.

## Invariant

The existing client is the only authority for wire admission, pending request
correlation and session retirement. App synchronizes source/readiness barriers
before query handling, dispatches each accepted message once, then runs its
follow-up. The reducer retains bounded rendered projections. Focus movement
never reads a record or changes selection; Enter, Space and click activate it.

## Owner

The Webview controller owns query/filter/sort intent, page draft/submission,
paging history and recovery. Pure recovery decisions own no I/O or React
state. App owns the listener, client, persistence, source barriers, global
cancellation, Follow and nonrow work. Controlled components own keyboard
focus, accessible markup and viewport placement.

## Alternatives

- Move wire admission or a second request map into the controller: rejected;
  it duplicates the established client authority.
- Put lifecycle logic in record-query rendering components: rejected; session
  recovery must remain independent of component mount/unmount.
- Activate tabs or detail reads on every arrow: rejected; manual activation
  preserves deliberate user intent and avoids unnecessary reads.
- Keep all virtual rows mounted for focus: rejected; retain the normal visible
  range plus at most one active row.

## Decision

Extract a controller with explicit client/context/action/cancellation/page
ports and pure capture/opened/empty-recovery decisions. Preserve public IPC
and persisted workspace shapes, decimal-string ordinals and existing bounded
paging helpers. Keep pending submission and dirty draft intent synchronous.

Use one grid Tab entry and an active cell identified by document, generation,
ordinal and column. Headers participate in navigation; header activation
enters its resize control. Workspace and detail tabs use manual activation
with existing panel IDs. A detail drawer is an aside above the existing narrow
breakpoint and a modal dialog below it, with focus containment, background
inertness and focus return. Native details menus retain dismissal behavior and
clamp their content to the viewport.

## Probe

Compose the real client, controller and reducer with explicit queued commits:
rebuild while a page request is pending, duplicate replacement, destructive
invalidation, late response, edited drafts, incomplete index and exhausted
restore, Profile/Follow supersession, partial sorted offsets, huge ordinals
and failed row-order persistence. Test focus reconciliation and virtual range
bounds without equating mocks or SSR with browser acceptance.

## Evidence

Focused suites cover policy decisions, full message sequences and controlled
markup. Separate installed-host acceptance must bind actual script/CSS hashes
and observe keyboard navigation, focus containment, inert restoration,
virtualization and menu geometry. Measurements record observed bundle sizes,
DOM and Chromium timing/heap with workload and cache limits.

The interaction decisions follow the primary
[WAI grid pattern](https://www.w3.org/WAI/ARIA/apg/patterns/grid/),
[manual tabs pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/),
[modal dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/),
and [TanStack range extractor](https://tanstack.com/virtual/latest/docs/api/virtualizer#rangeextractor).

## Boundary

This C2 Webview change does not change physical JSONL records, semantic
profiles, the engine, native code or transport. Harness guards and operational
receipts stay outside the runtime. Unit results and individual measurements
do not establish a performance SLA, OS sandbox or public release readiness.

## Revisit trigger

Revisit if query protocol or persisted state changes, a new view needs its
own recovery, multiple dialogs can coexist, or measured virtual focus adds
more than one row. Preserve admission and cancellation characterization first.

## Rollback

Reverse the controller/App or UI commits independently, retaining tests and
review evidence. A source change invalidates dependent artifact, review and
installed-host acceptance. The snapshot correction has its separate ADR.
