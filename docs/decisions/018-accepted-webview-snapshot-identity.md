# Accepted Webview Snapshot Identity

Status: accepted

## Pressure

The message client can accept a newer epoch with the same opaque generation,
but the Webview reducer previously detected replacement only by generation.
App also detected document and both-present payload epoch changes. These
different tests allowed stale rows or an invalidation barrier to survive an
accepted replacement. Follow could retain rows when the document changed.

## Invariant

Only the message client admits messages and orders epochs. After acceptance,
App and the reducer must agree about payload snapshot replacement. Generation
identifiers remain opaque. Follow retention never crosses document identity.
Optional epoch compatibility and public protocol/persistence shapes remain
unchanged.

## Owner

The Webview owns the pure comparison and rendered projection. The protocol
client continues to own admission, pending correlation and retired sessions.

## Alternatives

- Change generation admission or require epochs: rejected because this fix
  does not change the protocol's legacy compatibility contract.
- Compare envelope epochs in the reducer: deferred because envelope-only
  epochs were not part of App's existing payload snapshot comparison.
- Put the comparison in a feature component: rejected because snapshot
  lifecycle belongs to the Webview session, consistent with ADR-011/014.

## Decision

Use one pure payload identity comparison after client acceptance. A missing
prior snapshot, changed document, changed generation, or unequal epochs when
both are present indicates replacement. A true duplicate keeps the destructive
invalidation barrier. Follow may retain a prior viewport only within the same
document, pending the new tail projection.

## Probe

Characterize newer same-generation epochs with and without invalidation,
cross-document Follow, duplicate snapshots, optional epochs in both directions,
and envelope-only epochs. Compose the real client and reducer to show old
pending responses cannot commit after a newer admitted epoch.

## Evidence

Three focused regression cases fail before correction: stale rows, retained
invalidation, and cross-document Follow rows. The pure comparison, reducer,
and real-client tests cover the correction. Installed-host evidence remains
the separate acceptance gate for the integrated candidate.

## Boundary

This is a C2 lifecycle correction, separately reviewed before behavior-neutral
query controller extraction. It does not infer numeric ordering from UUIDs,
change the source engine, or strengthen missing-epoch protocol semantics.

## Revisit trigger

Revisit if protocol admission requires epochs or unifies envelope and payload
identity. Add explicit compatibility tests before changing either contract.

## Rollback

Reverse this isolated correction commit, preserving its regression tests and
receipt. Reverting restores the documented stale-projection defect and must
invalidate acceptance evidence for dependent query-controller changes.
