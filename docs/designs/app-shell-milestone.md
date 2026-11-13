---
id: "app-shell-milestone"
path: "docs/designs/app-shell-milestone.md"
title: "AppShell v0.3.0 Milestone Plan"
kind: "design"
status: "proposed"
owner: "product"
tags: ["accessibility", "app-shell", "history", "intake", "navigator", "webview"]
evidence: ["design-receipt:appshell-prototype-1-attempt-3"]
revisit: "before implementation and whenever intake identity, persistence or source authorization changes"
rollback: "restore the prior shell and command composition while preserving originals, saved copies and recoverable material metadata"
x-priority: "P1"
x-baseline-revision: "cd8c429323fb3b474d23212a0c3d3f82e393dee6"
x-target-branch: "feature/appshell-v0.3.0"
---
# AppShell v0.3.0 Milestone Plan

## Goal and delivery boundary

Deliver the selected 40px command rail, controlled 260px drawers and full remaining reader canvas. Make Import provenance, Save As guidance, Navigator entry and retained-material history coherent within that shell. Original JSONL/NDJSON bytes remain read-only and authoritative.

The user has selected the layout direction. This document is a proposed implementation plan: wire names, storage mechanics, budgets and new state presentation still require review. It does not declare v0.3.0 implemented, packaged, installed or accepted. The baseline above pins the merged convergence checkpoint. Development proceeds on the target branch; this plan does not bump a package version.

| State | Scope |
| --- | --- |
| Selected direction | 40px rail; 260px History/Sessions/Import drawers; remaining-space canvas; source actions on the left; direct-open items and secondary details. |
| Required outcome | Truthful Import/Save As guidance, Navigator opening Sessions, Host-owned durable history, bounded Webview projections and preserved source/query/authorization semantics. |
| Proposed implementation | Studio-scoped bridge, material-history port, SQLite/blob adapter, operation receipts and state DTOs below. |
| Open decisions | Storage budgets/retention, deduplication, changed-original UX, protocol versioning/migration and native-view retirement. |

The product owns these documents, runtime contracts, ADRs and implementation. External prototypes and receipts are optional design evidence; no runtime or documentation workflow depends on a private workspace or local path.

## Invariants and layout

- Keep `App.tsx` as composition root, the current query controller as the sole query owner, and existing engine/profile boundaries. Compose existing reader components instead of replacing their props or state with blueprint examples.
- Use one controlled `activeDrawer: 'none' | 'history' | 'sessions' | 'import'`, initially `none`. Rail is exactly 40px; open drawer is exactly 260px; closed drawer takes 0px. Main canvas fills the remainder.
- Same-icon click, Close and a scoped non-composing Escape dismiss the drawer. Restore the invoking control when it is current, visible and enabled; otherwise use its visible rail fallback. A higher-priority active overlay/interaction handles its own Escape first.
- Opening drawers grants no access, starts no scan/poll, submits no query and creates no history entry. Follow existing request cancellation and focus ownership rather than adding competing global handlers.
- Keep Table, Timeline, Schema, Problems, Insights, Query Studio, search, filters, sort, columns, follow, lineage and exact record detail. Preserve physical record identity and current bounded viewport/query state across composition changes.
- Every source, query, navigation, authorization, sorting, paste, connect, refresh and recovery action has a discoverable left-side entry. Real session/registered JSONL item titles open the reader directly; metadata inspection is secondary.
- Keep the [theme adaptation baseline](theme-adaptation.md), labelled keyboard controls, reduced motion and host token ownership. Prototype colors and simplified controls are illustrative and must not replace the existing theme or query contract.
- At 800px and 1280px, use internal canvas scrolling instead of outer horizontal overflow. At narrow widths secondary detail may overlay within the reader; it must not consume an additional permanent sidebar.

## Intake and provenance

| Entry | Reader source | History outcome | Required guidance |
| --- | --- | --- | --- |
| Accepted local URI through Import/drop | Open original directly through the existing Host source path | Persist an authorized source reference after Host commit; original bytes are not copied by reference registration | Temporary Import context, original-file identity, no separate saved copy, Save As and History actions. Do not call the disk file unsaved. |
| Bounded pasted text/browser File | Existing validated preview input; proposed Host-owned immutable managed bytes | Managed-copy history only after bytes and metadata are durably committed | Pending retention before acknowledgement; managed history copy afterwards; Save As remains a separate chosen-location copy. |
| Ordinary registered-file/session open | Existing direct reader path | Do not infer an Import event from timing or filename | Ordinary reader status, without a fabricated temporary Import banner. |
| History item | Host resolves opaque material ID and current access/observation | Reopen the selected reference or verified managed blob | Direct reader open; unavailable/changed references need explicit recovery. |

A durable reference is not a backup of original bytes. Save As, source authorization, History membership and user Collections membership are distinct operations. No entry implicitly authorizes a source, enables Navigator, starts a provider scan or files a Collection reference.

### Separate original references from inline previews

The current inline intake contract is at most 1,048,576 UTF-8 bytes and 10,000 records. Browser File decoding remains strict UTF-8 and uses existing preview validation. Reject or redirect oversized inline input before whole-file allocation; an explicit Host file-selection/open path is the alternative, not an unrelated silently opened picker.

Those inline limits are not a whole-source size or record cap for local URI references. Large originals use existing Host bounded reads and reader/index behavior; the Webview must not call `File.text()` or retain the full source. URI length/list limits and canonical path/trust authorization stay at their current owner.

Malformed records, blank lines and invalid UTF-8 in original files follow the existing reader/Problems contract, preserving physical rows and bounded diagnostics where that contract supports them. Do not apply inline-preview validation to categorically reject the original. Existing source-open failures remain bounded errors; this milestone does not promise that every invalid input becomes readable. Invalid message shape, unsupported scheme and denied source access remain intake/authorization failures before effects.

One supported canvas drop starts one intake operation. Nested drag events, blur and disposal have bounded cleanup. A Webview listener alone cannot prove VS Code native drop interception; installed-host tests must verify the supported path and its recovery entry. Multiple-file drop behavior retains the existing explicit Choose files route until a separate batching contract is reviewed.

## Proposed state and protocol seam

The following names describe proposed interfaces, not existing callable APIs:

```ts
type MaterialStorage = 'source-reference' | 'managed-copy';
type IntakeOrigin = 'studio-drop' | 'studio-paste' | 'studio-pick';
interface MaterialView {
  materialId: string;
  revision: string;
  displayName: string;
  sizeBytes: string;
  storage: MaterialStorage;
  availability: 'available' | 'unavailable' | 'changed';
  history: 'pending' | 'durable' | 'failed';
  save: 'idle' | 'saving' | 'saved' | 'cancelled' | 'failed';
  savedCopy: boolean;
}
interface IntakeIntent {
  operationId: string;
  payloadDigest: string;
  origin: IntakeOrigin;
  binding?: { documentId: string; generation: string; epoch?: number };
}
```

`savedCopy` is a boolean fact, not a path or Uri. A later cancelled/failed save attempt must not erase an earlier confirmed copy. A durable history acknowledgement cannot regress to pending because a panel closes or a later open fails. Save and history facts survive reopening the recorded item. The active document binding exists only after the exact open resolves; an empty Studio never fabricates `documentId`.

| Proposed Studio operation | Bounded input | Independent result facts |
| --- | --- | --- |
| Intake | Operation identity, origin and nested validated SourceDropMessage using current `intakeProtocolVersion=1` | Accepted/rejected, document binding, history outcome. |
| List materials | Cursor, history revision, bounded page/sort | Metadata-only page and opaque continuation cursor. |
| Open material | Opaque material ID and expected revision | Opened/cancelled/unavailable/changed and exact document binding. |
| Save material as | Selected material ID/revision and operation identity | Cancelled/failed/verified copy; later editor-open failure is separate. |
| List sessions | Authorized source ID and existing bounded catalog continuation | Existing session metadata; no implicit scan or grant. |

Before implementation, freeze the Studio wire version, strict allowlists, direction/delivery mapping, bootstrap identity, lifecycle epoch and request correlation in an ADR and shared contracts. Keep document `ProtocolEnvelope` identity/generation checks intact; an explicit Studio scope handles empty-shell requests. A compatibility adapter may accept the existing bare intake format, but one gesture must emit one operation rather than duplicate old/new messages.

Register cancellation before any effect. Accepted durable mutations need Host-owned idempotency identity and payload binding: identical retries resolve the same receipt; changed-payload replay fails. A timeout means unknown until inspected, not automatic resend. Disposal/stale epochs suppress late UI publication without undoing a committed copy/history receipt. Wire names, canonical digest and recovery format remain review decisions.

## Proposed Host history owner

Introduce a cohesive application `MaterialHistoryPort` and Host infrastructure adapter rather than overloading provider sessions or inventing methods on the existing CatalogStore. A candidate implementation uses SQLite metadata plus exclusive owned blobs under extension storage. Choose and document its transactional/crash-recovery contract before persistent writes ship.

- Host metadata contains opaque identity, revision, storage kind, authorized private reference/blob locator, byte size, timestamps and operation receipt. Webview receives bounded metadata pages, never full-source cache, raw grant or private arbitrary locator.
- A managed copy becomes durable only after verified owned bytes and metadata commit. Reconcile accepted/prepared/committed states after restart; retain pending/corrupt recovery evidence instead of deleting it to admit new work.
- Reference reopen rechecks current authorization and original observation. A missing or changed original is not a preserved snapshot and cannot silently rebind to another source.
- History removal never deletes an original or a Save As destination. Managed-blob cleanup requires verified ownership, identity and reference checks; retention/eviction is not implied by metadata removal.
- Current session-only previews remain session-only until an explicit, verified adoption path exists. Do not relabel existing previews restart-durable.
- Reuse bounded catalog paging for Sessions. Material history also requires a reviewed page bound; 200 default / 500 maximum is a candidate consistent with current catalog pages, not an activated setting.

### Decisions to settle before persistent implementation

| Decision | Known requirement | Unapproved options / required review |
| --- | --- | --- |
| Storage budget | Finite managed bytes and metadata; report capacity failures without silent deletion | The earlier 20 managed items x 1 MiB / 1,000 references suggestion is only a proposal. Freeze workload-backed counts/bytes and migration behavior in the implementation ADR. |
| Retention and removal | Preserve user originals, saved destinations and pending recovery state | Explicit removal, age/size retention and any eviction policy require review; none is enabled by this plan. |
| Repeated intake | Identity is not filename; retry identity differs from a new user action | Define whether new intake of the same original makes another row or updates a reference, and how prior receipts remain stable. |
| Changed original | Recheck authorization/observation and show truthful availability | Decide reopen-confirmation and explicit rebind UX without promising a snapshot or starting an unbounded fingerprint scan. |
| Persistence/recovery | Host is the authority; failures retain recoverable facts | Review SQLite/blob ordering, journal format, schema migration, exact-byte proof and restart reconciliation. |
| Native surface migration | Left action parity and direct-open behavior precede removal | Decide contribution retirement after installed-host evidence; no sidebar/menu removal is implicit. |

## Sequences and failure handling

1. Import -> validate message/authorization -> register operation and canonical intent before open -> use original or bounded managed preview -> bind exact document/generation/epoch -> publish open and history results independently. Pending never means retained. A successfully committed history result survives a subsequent open error.
2. Save As -> resolve selected material in Host -> native destination picker -> identity-safe exclusive exact-byte copy -> durable copy receipt -> attempt opening it -> offer explicit source/Collection follow-up through existing owners. Copy success is independent of editor-open success.
3. Denied/stale input -> reject before effects. Inline validation failure -> no fabricated history. Original parse/encoding problems -> current reader diagnostics. Disk/DB/capacity failure -> truthful history failure, original reader retained when available. Cancellation before commit -> no new success claim; cancellation after commit -> keep the receipt.
4. History reopen -> authorize/observe original or verify owned blob -> direct reader open or bounded unavailable/changed result. Restart reconciles owned persistence before accepting conflicting writes. A later successful save attempt updates the selected material facts rather than only the active editor's transient status.

## Ordered work packages

| Order and owner | Product scope | Exit evidence |
| --- | --- | --- |
| 1. Root: contracts and decisions | Confirm merged baseline/new branch; ADR update for ADR-086/087 placement/lifetime; shared Studio/material contracts; AGENTS.md and affected theme/query design updates | Review open decisions, strict negative wire cases and selected clickable states before runtime work. |
| 2. Storage owner | Proposed `src/application/materials/`, `src/infrastructure/materials/` and focused tests | Restart/reopen, identity conflicts, quota policy, disk/DB faults, crash boundaries, owned cleanup and migration tests. |
| 3. Host owner | Proposed `src/extension/studio/`; extension/document-controller wiring; existing source-intake/drop/preview adapters | Exact provenance binding, one operation per gesture, current authorization/limits, cancellation and selected-material Save As. |
| 4. UI owner | Proposed studio-shell widget/facade/hooks/styles; root integrates `App.tsx` and ordered stylesheet contract | Controlled drawers, truthful Host-backed state, bounded pages, keyboard/theme/viewport and current query/reader behavior. |
| 5. Navigation owner | Existing Navigator/catalog/Collections adapters; root owns package contribution changes | Sessions entry without Add Source, direct-open items, explicit access/connect/recovery and existing polling/journal gates. |
| 6. Root: candidate and acceptance | Exact clean candidate, required checks, independent review, packaging/install/reload and [acceptance checklist](app-shell-acceptance.md) | Separate source/test, real DOM, installed-host and human acceptance records; no stale candidate evidence. |

Concurrent workers own explicit non-overlapping modules in isolated worktrees; root owns shared contracts and final integration. Preserve other work and stage exact paths only. Shared lifecycle/protocol work is C2; persistent migration and eventual release are C4 under the product working agreement.

## Evidence and completion

External design receipt `appshell-prototype-1-attempt-3` records 43 real-Chrome DOM/input checks for a standalone synthetic mock at 800x800 and 1280x800. Its HTML SHA-256 is `eb4eef0ad98d710733c2abb8f9a7a67e202254df47027603cd4b771f5587b166`; receipt SHA-256 is `abb1e04d34f66a2a0785d62d41252101c74b04dc0af3cef479f35f93b23cf37d`. This is design interaction evidence, not installed extension, persistence, byte-copy or user-acceptance evidence.

Run the current full mandatory commands in AGENTS.md plus focused intake/protocol, storage recovery, navigation and real-DOM checks for implementation. Required hosted checks and CodeQL must pass for the exact candidate. Packaging/install requires exact artifact identity, reload and the separate installed-host checklist. Any candidate change invalidates its previous release gate evidence.

## Rollback and blueprint corrections

Restore the previous shell, commands and contributions together. Preserve originals, saved copies, source permissions, Collections journals and new history metadata/blobs. Disable new history writes if necessary while keeping recovery accessible; do not downgrade a schema in place or delete user data to roll back layout.

Blueprint examples must not be copied as implementation: they use optimistic saved states, browser downloads, localStorage retention, whole-file text reads, missing intake versioning, unhandled/duplicated messages, invalid `savedCopy` Uri access, incomplete Sessions stubs and an App replacement that drops existing controls. A URI reference is not a vault byte copy; DOM drag handlers do not control every native VS Code drop. The new design must extend actual product owners and reviewed contracts instead.
