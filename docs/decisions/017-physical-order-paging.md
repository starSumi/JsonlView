---
id: "017-physical-order-paging"
path: "docs/decisions/017-physical-order-paging.md"
title: "Physical Order Paging"
kind: "decision"
status: "accepted"
owner: "product"
tags: ["ordering","paging","query"]
evidence: []
revisit: "when paging or order semantics change"
rollback: "restore physical-order navigation"
---
# ADR-017: Physical order paging and incomplete filtered results

Status: Accepted

## Pressure

Global forward and reverse controls use physical ordinal order. Applying the
field-sort retention window to these requests rejects later pages even though
the index can address them directly. A filtered ordinal scan can also reach
its allowance before filling a page; restarting the same logical rank does
not advance the physical scan cursor.

## Invariant

Physical ordinal offsets remain decimal strings and can exceed the retained
field-sort window. A partial result must remain labelled, and Next must imply
known matches or a hydration continuation that makes progress.

## Owner

The extension validates requests, the engine owns index and scan semantics,
and the Webview renders the returned pagination and incomplete-result state.

## Alternatives

- Apply the same retained window to all sorts: rejected because physical
  ordinal addressing does not require retaining sorted field candidates.
- Increase scan allowances or silently scan the complete file: rejected
  because bounded query work is part of the engine contract.
- Add physical continuation to ordinal-sorted requests: accepted because an
  exclusive ordinal cursor is stable across append generations and does not
  require a retained field-sort candidate set.

## Probe

Route both physical ordinal identifiers and directions through the real host
controller and session beyond 2,048 rows. Exercise record, byte, and deadline
limits with zero or one visible match, and preserve paging to another known
match within the examined range.

## Decision

Exempt only validated `__ordinal` and `$ordinal` sorts from the field-sort
offset-plus-limit guard. Keep malformed-offset checks and field-sort limits. A
physical request uses an exclusive decimal `anchorOrdinal` plus `direction`; it
must not include `sortOffset`, and a non-ordinal sort must not include either
physical cursor field. Direct page-number jumps remain logical rank requests.

Adjacent ordinal pages use physical cursor requests. For descending display,
Next scans backward from the last displayed ordinal and Previous scans forward
from the first displayed ordinal, then the engine reverses presentation. This
keeps a partial older page stable when newer rows append. Direct page-number
submissions, including page one, carry a logical-navigation intent and always
send `sortOffset`. Adjacent requests carry a physical-navigation intent and
never send `sortOffset`. Recovery and Columns projection refresh preserve the
original request's navigation intent; a pending request takes precedence over
the previously displayed window.

The reading viewport retains the request identity that produced the window:
sort, page limit, navigation intent, and a deterministic scan boundary when
the original scan was truncated. A physical identity retains its exclusive
anchor and direction; a logical identity retains its matching-rank
`sortOffset`. Generation recovery replays that identity. A logical rank must
never be converted to an ordinal from the source count, and a physical anchor
must not be synthesized from the first visible match. New matching rows can
change the records at a logical rank after append; physical window recovery
preserves its original scan range. A bounded scan may continue only when its
cursor advanced and physical records remain. Zero-progress deadline or
byte-limit scans expose their truncation evidence but disable the
same-direction continuation.

The frozen range retains the original examined record and byte counts,
separately from the operation deadline. Columns refresh and generation recovery
attach a fresh five-second deadline without expanding that range or reusing
an expired absolute deadline. A replay stopped earlier by time retains the
original range for the next attempt. Pending projection refresh also retains
its original record and byte caps while renewing the deadline. A frozen
zero-progress range remains empty until an explicit new query or navigation.

## Evidence

The application-port, message-validation, integrated-session, engine, paging,
and row-query-controller suites cover both ordinal aliases and directions,
requests beyond 2,048 rows, invalid mixed cursors, bounded zero/one-match scans,
zero progress, logical page-one submission, partial final pages, and gap-free
forward/backward continuation against an independent ordinal oracle. Real
controller-to-engine tests exercise the production Columns refresh caller for
partial DESC, sparse bounded physical, and logical pages, plus append/reopen
recovery of physical windows and a sparse logical rank with a nonmatching
append. Pending projection tests cover both navigation intents.
Deterministic controller-to-engine clock tests cover an original five-record
time-limited window, a slower one-record replay, a later complete replay,
append/reopen, pending deadline renewal without larger caps, and zero-progress
replay. A deadline stops work before the next record; it cannot preempt one
record hydration already in progress.

## Boundary

No protocol version, persisted preference, field-sort retention limit, scan
allowance, or source file changes. The existing optional cursor fields gain a
validated ordinal-sort combination. This decision does not promise that a
partial filtered result contains every source match.

## Revisit Trigger

Revisit if arbitrary field sorts need cursor continuation, or if a durable page
number must be assigned after an append changes logical ranks. Those contracts
need a retained sort snapshot or another explicit ordering identity.

## Rollback

Revert the ordinal-specific validation and pagination correction together
with their contract tests. Preserve source authority and incomplete-result
labels; do not broaden scan budgets to hide a regression.
