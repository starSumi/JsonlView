---
id: "087-save-as-collection-onboarding"
path: "docs/decisions/087-save-as-collection-onboarding.md"
title: "Save As and Collection Onboarding"
kind: "decision"
status: "accepted"
owner: "product"
tags: ["navigator", "collections", "save-as", "authorization"]
evidence: ["source:src/experimental/session-navigator/session-previews.ts", "source:src/experimental/session-navigator/tree-provider.ts", "source:src/experimental/session-navigator/collections-tree-provider.ts", "source:src/extension/observability/lifecycle-failure.ts", "test/experimental/session-navigator-lifecycle.test.ts", "test/extension/observability/lifecycle-failure.test.ts"]
revisit: "when changing Save As follow-up actions, exact-file authorization, or Collection reference semantics"
rollback: "remove the post-save listener and filing flow while retaining the verified Save As action and saved-copy availability"
---
# ADR-087: Save As and Collection Onboarding

## Pressure and invariant

Save As already creates a verified durable copy of a temporary preview. Users
may also want to organize that copy in Collections, but saving a file must not
silently authorize a source or create Collection membership. Dismissing the
follow-up or failing its later steps must leave the verified saved copy intact.

Collections remain metadata-only. Source registration and exact-file
authorization remain explicit and independent; neither a Collection choice nor
an existing preview grants permission to read source contents or enable Session
Navigator.

## Owner and decision

After the verified Save As copy's open attempt settles, Session Navigator
offers one native prompt with Add as source, Add to Collection and Dismiss.
The same prompt reports an unsuccessful open; the tree Save As command does
not add a second prompt. The Collection flow accepts only
local `.jsonl` and `.ndjson` files, revalidates their canonical local URI, and
requires a modal confirmation before registering the exact file as a
read-only source. It then creates the `@file` reference through the existing
Collections mutation journal and revision checks. It does not scan or probe
the file, and does not enable Session Navigator when it was disabled. The
matching source-settings event does not restart polling or invalidate loaded
sessions. Newly registered files remain metadata-only for automatic refresh
and polling in this host session until an explicit Refresh or Add Source
action. A later extension session uses the durable permission under the normal
scan policy.

If an explicit Refresh admits a saved file while another refresh is already
running, its callers await a following pass over the current source list.
Requests coalesce into one additional pass. Hiding Sessions, losing window
focus, disabling Navigator or disposing its owner prevents a queued pass from
starting after the current scan settles.

Dismissal leaves source settings and Collection metadata untouched. Cancelling
the picker or authorization also leaves the file saved. A later filing failure
shows a fixed warning distinguishing unconfirmed source registration from
retained registered permission and a possibly pending Collection change. It
records only allowlisted error name and recognized
system error code in the JsonlView output channel; messages, stacks and paths
are excluded. Logging is best effort and cannot change Save As success.

This extends the explicit source and membership separation in
[ADR-085](085-collections-reference-entrypoint.md) and retains the temporary
preview ownership described by [ADR-086](086-import-canvas-and-toolbar-entrypoint.md).

## Alternatives

Automatically authorizing or filing the saved path was rejected because Save
As is a file operation and cannot imply a source permission or user-owned
Collection mutation. Reusing Add Existing Reference alone would require users
to find and select the just-saved file through a second flow. A new metadata
store is unnecessary; exact-file authorization, catalog metadata and Collection
membership already have owners and a shared journal.

## Probe, evidence and boundary

Tests cover adding to an existing Collection, creating a Collection, dismissal,
explicit authorization, enabled and disabled Navigator behavior, render and
delayed configuration callbacks, explicit refresh during an active scan,
queued-refresh cancellation on hide/focus loss/disable/disposal, exact-file identity,
verified saved bytes, no scan or probe, and failure logging without copying
error messages or paths. The lifecycle test fixture supplies one generic local
file URI validator in `beforeEach` and resets it in `afterEach`; individual
tests override it only for specific authorization and validation branches.

These checks establish source and test behavior. Installed-host interaction and
user acceptance remain separate evidence.

## Revisit and rollback

Revisit if Save As becomes a product-wide document save contract or if
Collections changes its exact-file identity. Roll back the post-save listener,
prompt and filing action together. Preserve saved files, registered source
settings and existing Collection metadata; do not attempt to infer or undo
prior user actions.
