# 017: Physical order paging and incomplete filtered results

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
- Add physical continuation to sorted requests: deferred until a separately
  reviewed cursor and generation contract exists.

## Probe

Route both physical ordinal identifiers and directions through the real host
controller and session beyond 2,048 rows. Exercise record, byte, and deadline
limits with zero or one visible match, and preserve paging to another known
match within the examined range.

## Decision

Exempt only validated `__ordinal` and `$ordinal` sorts from the field-sort
offset-plus-limit guard. Keep malformed-offset checks and field-sort limits.
For filtered ordinal pages, a scan truncation alone does not set `hasAfter`.
Retain the scan reason and cursor as incomplete-result evidence; this cursor
does not become an implicit sorted continuation.

## Evidence

The message-validation, integrated-session, and engine regression suites
characterize request acceptance, actual row identities, bounded failure
outcomes, and known-match continuation.

## Boundary

No protocol version, persisted preference, field-sort retention limit, scan
allowance, or source file changes. This decision does not promise that a
partial filtered result contains every source match.

## Revisit Trigger

Revisit when sorted physical cursor continuation is required. It must preserve
generation correlation, cancellation, byte and time allowances, and stable
row identity across page boundaries.

## Rollback

Revert the ordinal-specific validation and pagination correction together
with their contract tests. Preserve source authority and incomplete-result
labels; do not broaden scan budgets to hide a regression.
