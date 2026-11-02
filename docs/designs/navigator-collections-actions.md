---
id: "navigator-collections-actions"
path: "docs/designs/navigator-collections-actions.md"
title: "Navigator Collections VS Code Actions and Context Menus"
kind: "design"
status: "proposed"
owner: "product"
tags: ["actions", "collections", "context-menu", "navigator"]
evidence: ["product-revision:14f7bfcd75edf25232c932da0dddf58a3682896f", "https://code.visualstudio.com/api/references/contribution-points#contributes.menus", "https://code.visualstudio.com/api/extension-guides/tree-view#view-actions", "https://code.visualstudio.com/api/extension-guides/webview#context-menus"]
revisit: "before implementation and when provider identity or persistence contracts change"
rollback: "withdraw the proposal and retain the source-preserving metadata boundary"
x-priority: "P1"
x-freshness: "current"
x-review-cadence: "before implementation and at each contract change"
x-last-reviewed: "2026-11-01"
---
## 5. VS Code actions, display and state

The upper area has discoverable routes for collection creation, collection
listing, an explicit Archived items filter, added items and history.
Object-specific commands belong to that object's context menu or an equivalent
keyboard-accessible action menu, not permanent tree sections. Detail panes may
repeat them but cannot be their only entry. A Postman-shaped expandable tree is
a structural reference only: it does not introduce Run/Share/Fork commands,
disk operations, unlimited folder nesting, or Postman's deletion semantics.
Public notebook workflows provide a reference for filing, moving, and removing an existing conversation; the product metadata contract defines the exact source-preserving effects.

| Permanent tree presentation | Context-dependent menu/action | Owned metadata effect and projection refresh |
| --- | --- | --- |
| Existing upper source intake | Existing paste, drop, local-file/folder, connect/authorize actions | Existing intake/authorization owner; no implicit collection membership. Successful registration refreshes added sources under its existing readback. |
| Upper collection header, expandable by its display name | Rename, delete collection | Update collection metadata or delete its links; one commit/revision refreshes upper and lower. Rename does not touch any source name. |
| Session/file item under lower Sessions | File into collection; Archive locally (sessions only); existing direct-open/source actions | `fileInto` creates or reuses the exact durable entry and link. An unarchived item appears above and leaves lower Unfiled after commit; session-local Archive instead moves the item to Archived while preserving links. |
| Session/file/source item inside one upper collection | Open; File into another collection; Move to collection; Remove from this collection; Rename alias; Archive locally (sessions only) | `fileInto` adds a link; `move` transfers only this collection's link atomically; `unfile` removes it; `alias` edits display metadata; session-local Archive retains all links but moves the item to Archived. Provider-native archive is observed on refresh and is never cleared by these actions. |
| Item in the explicit Archived route | Restore local archive (only if intent exists); Remove/Move (only if membership exists); Rename alias; explicit provider recovery | Restore deletes only our local archive intent. If the provider remains archived, the item stays Archived; if it becomes available and has any collection link, it returns above, otherwise lower Unfiled. Provider archive/unarchive remains a separate provider-owned action. |
| Provider/source group inside a collection, such as “Gemini conversations (152)” | Expand/load more; actions only for an explicitly represented source reference | Grouping/count is presentation. No bulk filing, unfiling, selection, or filesystem move follows from the group's shape. |
| Restricted/missing reference placeholder | Remove from this collection; move owned link; explicit authorize/recover when applicable | Metadata removal/move needs no source read. Recovery uses current authorization and explicit rebind; no remembered-path open or guessed match. |
| Added-items/history route | Existing applicable open/reveal actions; File into collection only for a current durable target | Compose registered/recent projections with stated lifetimes. A menu choice does not create a permanent section or permanent event store. |

V1 collections are a flat user-managed set. Provider/source groups are bounded
presentation within a collection; file/folder sources are references, not
nested filesystem ownership. Within a collection these groups expand into
bounded pages; counts state whether they are exact or coverage-limited. A group
is not an implicit membership for all present/future children.

Click a resolved session or registered JSONL/NDJSON item to open directly in
JsonlView through the current host gate. An authorized local Markdown file may
be referenced as a file attachment and opens in the host's native editor; this
proposal does not claim an existing Markdown parser or analysis adapter.
Metadata/provenance remain secondary actions. Renaming an item writes a
user alias, and removing an item from a collection unlinks metadata only.
For a resolved item, display precedence is durable alias, then the existing
catalog product-title overlay, then the current provider title. Clearing an
alias restores that fallback; it never writes the fallback back to the source.

V1 has no separate collection-container archive state. The explicit Archived
route filters item archive status; it is not another collection lifecycle.
Delete collection removes only that collection and its membership rows. A
remaining link in any other collection continues to hide the same lower leaf.
Delete never calls source removal, vendor archive/delete, filesystem
move/unlink, or preview cleanup.

The item projection has exactly three mutually exclusive default states:

1. **Unfiled**: the current authorized provider item is not effectively
   archived and has no collection membership; it appears in lower Unfiled.
2. **Filed**: the current authorized provider item is not effectively archived
   and has at least one collection membership; it appears in the corresponding
   upper collection(s).
3. **Archived**: `providerObservedArchived` is true OR our durable
   `localArchiveIntent` exists. It is hidden from the default upper/lower
   active item lists and is reachable through an explicit Archived items view;
   all of its collection links remain visible in that view and are preserved.

The effective predicate is exactly
`effectiveArchived = providerObservedArchived OR localArchiveIntent`.
Any membership prevents an unarchived entry from returning to Unfiled. Provider status is a read-only observation
from the authorized native catalog; its `archived` bit is not copied into or
overwritten by our metadata. A local restore removes only
`localArchiveIntent`. It cannot clear Codex's native archived bit, whose
archive/unarchive operation moves provider rollout data and updates the Codex
state database. When provider status is unknown because authorization or
coverage is incomplete, the item remains a redacted/unavailable row and is not
silently placed in Unfiled.

`effectiveMembership(item)` means a membership row joins an existing durable
entry, current reference, and existing collection. It is independent of
temporary resolution and authorization status. Filing hides only an **exact
session/file identity**; source/root/folder references do not hide child
sessions, including future discoveries. Filing a parent does not implicitly
file subagents or descendants. If a filed parent is omitted but has unfiled
descendants, a non-openable context branch retains those descendants without
turning the parent into an unfiled session.

| Resolution state | Upper row and allowed behavior |
| --- | --- |
| `resolved` | Current authorized display data; direct open, alias, link/unlink/move, selection where the adapter supports it. |
| `authorization-required` | Generic placeholder and metadata-only unlink/move/delete-collection controls; no source-derived title, user alias, path, content, provider diagnostic body, open target, or analysis input. Authorize uses the existing explicit host flow. |
| `coverage-pending` | Association retained; show bounded loading/coverage status. Partial/truncated scan or an absent page is insufficient to call an entry missing. |
| `missing` | Association retained after a complete relevant authorized discovery/probe establishes absence. Offer explicit rebind or source recovery; no guessed path open. |
| `identity-conflict` | Association retained; require explicit resolution. No title/fingerprint-based auto-merge. |
| `unsupported` | Reference can be managed; open/analysis capabilities are explicit. A Markdown reference does not imply JSONL/session analysis support. |

Collection names and link counts are owned metadata. Restricted rows expose
only opaque IDs, generic state, link metadata, and permitted metadata actions.
Counts distinguish accessible resolved entries from retained unavailable links;
they never count unauthorized source content. Clear resolved/alias data already
rendered when authorization changes. A DTO error is a fixed code, not a raw
provider exception or remembered URI.

The upper **Added items** route composes the existing effective registered-source
projection with durable referenced items, deduplicated by exact
`(providerId, sourceId, nativeId)` identity within each registered source. An unlinked
retained reference may be shown as Unfiled; it does not hide a lower item.
History reuses existing recent-preview/reveal/recent-access projections with
their stated lifetimes. Do not create an event-sourcing or permanent history
table for this feature, and do not promise restart history where the current
owner supplies only session memory.

If a later selected analysis interaction uses checkboxes, its selection belongs
to the existing AnalysisIntent/workspace lifecycle. This document adds no
permanent checkbox UI. Selection may carry entry IDs and a current resolved
source snapshot, but it is not a membership column or durable archive bit.
Unchecking does not unlink; filing does not select. Any group selection must
name an explicitly bounded current set; unbounded/future-child “select all” is
queued. Before analysis, re-resolve every
selected reference under current authorization; revoked/unresolved inputs cannot
continue through a cached selection. Rebind invalidates the affected selection
and requires a new analysis intent.

### Context-menu dispatch (proposed)

The permanent tree is intentionally smaller than the action set. A native tree
item or upper Webview row supplies an object-kind and opaque ID; the adapter
offers only applicable context actions. Native lower-tree menus use VS Code
`view/item/context` with `when` conditions and grouping. The upper remains the
existing Webview: equivalent accessible actions use its validated message
bridge, or `webview/context` contributions with its own context data. A native
TreeDragAndDropController is not an upper-Webview integration. In both cases
the host handler remains the authorization and revision gate. A visible menu item never grants source
read permission.

| Context and business reason | Context actions offered | Success and projection | Conflict/failure visible symptom |
| --- | --- | --- | --- |
| Lower resolved session/file: user wants to organize an existing item | File into collection; Set local archive (session only); Open | `fileInto` moves the unarchived item to upper collection(s); local archive moves it to Archived while retaining links; Open keeps the existing direct-open gate. Both projections refresh at one committed revision. | Stale target/authorization shows a fixed retry or authorize action; no remembered path opens. A failed commit leaves lower state unchanged. |
| Upper resolved member: user wants another link or cleanup | File into; Move to; Remove from this collection; Alias; Set local archive (session only); Open | Add keeps other links; Move atomically transfers one link; remove deletes one link; alias changes product display only; archive keeps every link and moves to Archived. | `REVISION_CONFLICT` leaves original collection link and row visible; failed move never shows a half-transfer; provider bytes/title remain unchanged. |
| Archived item: user wants to restore visibility | Restore local archive only when local intent exists; Remove/Move link only for memberships; Alias; Reset local metadata; Open/recover | Restore removes only our intent. If provider remains archived, row stays Archived with a provider-archived explanation; if provider is active, membership returns upper or no membership returns lower. | No menu promise of Codex unarchive. Native status unknown/revoked shows unavailable/re-authorize; no false lower row. |
| Collection header: user manages a container | Rename; Delete | One metadata commit updates container and both projection reads; delete removes its links only. Source rows survive. | Concurrent delete/rename gives fixed conflict; deletion never removes source or provider data. |
| Provider/source group: user browses bounded grouping | Expand/load more; no bulk archive/file/remove | Bounded child page uses current provider coverage and keeps future children independent. | Truncated/partial page shows coverage-pending; no inferred missing/unarchived state and no bulk menu. |
| Restricted/missing/identity-conflict placeholder: user manages metadata or recovery | Remove; Move; explicit authorize/rebind where supported | Metadata-only unlink/move can succeed without source content; rebind requires fresh verified target and preserves entry/links. | Generic redacted row plus fixed error; paths, titles, content, and provider diagnostics stay hidden. |
| Intake/Added/History route: user brings a new source or revisits recent work | Existing paste/drop/local/connect/reveal/open; File into only after explicit durable registration | Existing intake owner performs validation/readback; collections consume a registered identity. History remains existing projection, not a new event table. | Temporary preview returns `TEMPORARY_SOURCE` for filing; source authorization remains explicit and no collection menu creates a saved file. |

Suggested future native menu contributions are `view/item/context` entries with
`when` predicates such as object kind (`navigatorCollection`,
`navigatorEntry`, `navigatorArchivedEntry`, `navigatorSourceGroup`) and
capability/status flags (`canFile`, `canUnfile`, `canMove`, `canAlias`,
`canLocalArchive`, `providerArchiveObserved`). These predicates only shape the
menu; the host rechecks them after every await. The official VS Code menu
surface is documented at
[contributes.menus](https://code.visualstudio.com/api/references/contribution-points#contributes.menus)
and [Tree View actions](https://code.visualstudio.com/api/extension-guides/tree-view#view-actions).
The upper Webview's distinct surface is documented at
[Webview context menus](https://code.visualstudio.com/api/extension-guides/webview#context-menus).
For existing entity TreeItems, preserve the current
`viewItem == jsonlView.sessionNavigator.entity` context value. A new collection
TreeItem must first set its namespaced `contextValue` (for example,
`jsonlView.sessionNavigator.collection`) in the provider; its menu contribution
then matches that exact value, such as
`view == jsonlView.sessionNavigator &&
viewItem == jsonlView.sessionNavigator.collection`. Use a
`navigation`/named context group and the registered command ID. Upper actions
validate object kind/capability from host-owned DTO context and dispatch the same
port; Webview-supplied flags are never trusted business guards.

Authorization is checked at the host effect boundary, on every asynchronous
resumption, and before publishing list/open/analysis data. Metadata-read/write
capability is profile-local extension authority, never an authorization to read
a remembered source. Creating references, rebind and open require the existing
effective authorization readback; local restricted-link management does not
scan, open, authorize, or leak that source. Disabled Navigator behavior retains
the existing no-scan/no-catalog-creation contract; metadata UI capability does
not implicitly enable provider scanning. A new store may be created only by an
explicit collection action after the metadata-write gate, not activation.
