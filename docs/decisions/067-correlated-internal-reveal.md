---
id: "067-correlated-internal-reveal"
path: "docs/decisions/067-correlated-internal-reveal.md"
title: "Correlated Internal Reveal and DOM Confirmation"
kind: "decision"
status: "accepted"
owner: "product"
tags: ["navigator", "protocol", "identity", "webview", "security"]
evidence: []
revisit: "when reveal gains an external bridge, concurrent viewers, or an observed virtualizer incompatibility"
rollback: "revert the correlated reveal protocol, handoff, and UI consumers together; no persistent migration exists"
---
# ADR-067: Correlated internal reveal and DOM confirmation

Status: accepted for local implementation; installed-host acceptance pending.

## Pressure and invariant

Navigator selection previously broadcast an uncorrelated scroll request. A
successful post did not establish that the target physical record was mounted
or visible. Only an observed current target may settle `shown`; no external
command or MCP bridge gains permission from this internal protocol.

## Ownership and decision

The source owner retains authorization, canonical file resolution and generation
checks. Navigator passes a one-shot, bounded host-local handoff. The document's
controller owns one in-flight request with a random `reveal-` request ID and a
five-second watchdog. A later request supersedes the former one. Closing or
hiding its panel cancels confirmation. The handoff independently bounds a view
that never becomes ready. Undispatched outcomes have no document identity.
The Navigator fences asynchronous probes by click sequence, and each opener may
clear only its own ticket. Neither a slow old probe nor an old failed opener can
replace or clear the latest handoff. An unfinished index prefix is not a total
record count; only a completed index can reject a target as out of range.

`REVEAL_ACK` echoes the exact document, generation, optional epoch and request ID.
Its payload accepts canonical decimal ordinals of at most 64 digits, fixed
outcomes and an optional bounded reason. `shown` requires a rendered ordinal
equal to the requested ordinal. Extra payload fields are rejected. An old or
unknown receipt cannot settle a newer request. Current source metadata and
authorization are checked again before publishing success; an unobserved change
after that check remains an ordinary observed-snapshot limitation.

Success uses two metadata observations (the source path and held file handle),
comparing device, inode, size, nanosecond mtime and ctime to the opened snapshot.
It never invokes whole-file refresh classification or reads content bytes.
This observation bypasses the content-operation queue without mutating engine
state. Changed or unavailable metadata fails closed. It does not prove atomic
immutability or detect same-metadata rewriting. Node documents bigint stat fields
and the platform-dependent precision of [mtimeNs](https://nodejs.org/docs/latest-v24.x/api/fs.html#statsmtimens)
and [ctimeNs](https://nodejs.org/docs/latest-v24.x/api/fs.html#statsctimens).

The Webview keeps its existing rows while a missing page loads, switches the
visible table to ascending physical order, retains current predicates, and
requests the predecessor of the target because physical forward cursors are
exclusive. A physical ordinal is never used as a virtual-list index. A skipped
target is `filtered-out` only with evidence that the scan passed it; an
unexamined or uninspectable target is `not-found`.

React commit starts bounded DOM observation. The virtualizer seeks the matching
loaded row; two consecutive macro-task observations require a connected,
nonzero row intersecting the content viewport below its header, with the
document visible. A scroll correction alone cannot acknowledge success. No
animation frame is required, so a frozen background frame cannot hang the Host.
`shown` means this DOM observation, not compositor completion or human attention.
Unrelated detail, schema or Insights failures do not cancel a reveal. Failure of
its own row request or an observed source-identity failure retires it.

## Alternatives and standards check

- Broadcast-and-forget was rejected because delivery is weaker than rendering.
- Pure double-rAF was rejected because background execution may be suspended
  and callbacks do not certify physical rasterization.
- A second request queue or external listener was unnecessary: existing typed
  transport, lifecycle gates and the bounded one-shot handoff are sufficient.
- [React useLayoutEffect](https://react.dev/reference/react/useLayoutEffect)
  specifies DOM measurements after commit and before repaint. It does not
  establish user attention or compositor completion.

## Validation and boundary

Focused tests cover malformed acknowledgements, source and epoch changes,
rapid-click supersession, delayed source validation, cancellation, range checks,
one-time handoff consumption, page faults and DOM visibility arithmetic. Existing
Navigator junction containment tests remain in force. Real installed Webview
observation is a separate gate; unit results do not establish that gate.

## Rollback and revisit

Revert this change as a unit with its protocol consumers. No stored source format
or persistent migration is introduced. Revisit on a new reveal bridge, multiple
simultaneous viewers, or an observed virtualizer/platform incompatibility.
