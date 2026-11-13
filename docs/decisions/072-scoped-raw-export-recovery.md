---
id: "072-scoped-raw-export-recovery"
path: "docs/decisions/072-scoped-raw-export-recovery.md"
title: "Scoped Raw Export and Durable Recovery"
kind: "decision"
status: "accepted"
owner: "product"
tags: ["export","filesystem","identity","recovery","security"]
evidence: []
revisit: "when projected formats, larger budgets, journal retirement UI or destination filesystems require another contract"
rollback: "remove the scoped commands and modules; preserve retained operation storage, owned pending evidence and all user destinations"
---
# ADR-072: Scoped Raw Export and Durable Recovery

## Pressure, scope and owner

ADR-069 copies an entire source. Users also need exact full-record copies of a
selected detail record, an inclusive physical ordinal range or every match of
the current accepted predicate. They need a recoverable operation identity when
the publication result is lost. This is a C3 extension-owned filesystem and
authorization boundary; it adds native actions, not a Webview export protocol,
MCP write capability, daemon or projected-column format.

`raw-export-intent` owns normalization and immutable selection identity;
`scoped-raw-spool` owns the bounded physical scan; `raw-export-operations` owns
private durable stages; `native-raw-exports` owns user choice and current grants.
`raw-jsonl-export` remains the sole no-replace publication primitive. The session
captures its existing profile projection and engine predicate evaluator.

## Invariant and contract

| Field or scope | Contract |
| --- | --- |
| requestId | Host-issued UUID, persisted unchanged before scanning |
| selectionDigest | SHA-256 of canonical normalized selection and original source/profile binding |
| binding | Document/generation/epoch, Host URI, source size/mtime/prefix and optional device/inode, profile ID/version/epoch |
| selected-records | At most 4096 current Host record references; deduplicate and sort by physical ordinal; native UI currently selects one record |
| ordinal-range | 0-based first/last inclusive; absent endpoint is an error |
| matching | Exact predicate from the last successfully posted, current and non-superseded GET_ROWS; no visible-page or sort-window authority |
| destination | Native Save selection, canonical parent plus filename, never supplied by the Webview |
| sourceObservation | Persisted original URI plus device/inode/size/mtimeNs/ctimeNs from matching held-handle and path observations |
| prepared | Canonical destination, owned sibling temporary identity, byte count and SHA-256, flushed before hard-link invocation |
| committed | Same operation ID/digest, output size/hash, written only after destination identity and digest proof |

Capture GET_DETAIL only after a successful current delivery, using the returned
Host reference. Capture immutable profile fields before awaits. Failed posts,
failed requests and late superseded deliveries cannot replace export authority.
The save picker retains its captured intent; a different accepted predicate or
selection, source identity or profile revokes it. An equivalent new page does
not change the normalized intent. No export action treats a query page as all
matching data.

The scanner reads the source read-only in 64 KiB chunks, verifies the open/path
identity and metadata before and after work, and rechecks the captured grant.
`RecordRef.byteEndExclusive` ends at **content**, with the delimiter stored
separately. Raw physical end is `byteEndExclusive + delimiterByteLength`.
Blank, malformed and invalid UTF-8 bytes are copied exactly for selected/range
and unfiltered scopes. Active predicates use fatal UTF-8 decoding and the same
profile and predicate evaluation as GET_ROWS; unparseable/blank records do not
match. A predicate record over 1 MiB fails explicitly as uninspectable rather
than silently claiming complete coverage.

Caps are 256 MiB actually read from the original source, one million examined
physical records, 64 MiB output and a 30-second cooperative precommit deadline.
Core tests permit tighter limits, never higher limits. A scan that reaches a
cap fails before publication; selected/range scans can stop at their inclusive
physical endpoint. Output is always physical ascending order. No full-source
hash is part of authorization: the existing session source check uses metadata.
The original source scan is at most 256 MiB; publication additionally makes at
most four passes over the at-most-64-MiB spool/output (copy, verify temporary,
destination proof and durable recovery inspection). Inspection/retry may make
additional explicitly requested bounded proof passes. This is an I/O bound,
not a performance SLO or universal latency claim.

## Recovery sequences

1. Admit an immutable `intent.json` with `wx`, mode `0600` and `FileHandle.sync`.
   It includes the current observed source version. Reserve each of at most
   eight scan attempts before creating its new private raw spool.
2. Scan and sync the spool. Record owned spool identity for eventual cleanup.
   The established raw core copies to a random sibling temporary, verifies it,
   and awaits a flushed `prepared.json`. Failure or cancellation before linking
   creates no destination. Reauthorize again after the journal await.
3. Publish once with the existing same-directory hard-link primitive. Once
   linking begins, finish destination proof even if cancellation arrives.
4. Inspect destination device/inode, size and full digest. Only that proof permits
   the immutable `committed.json` receipt. Retain prepared temporary and spool
   until that receipt settles, then remove only identity-matching owned paths.
5. After restart, inspect first. A link committed before its receipt is recovered
   by the same inode and digest, so it does not publish again. A different inode
   is unknown even if its bytes match. Unknown/corrupt evidence never triggers
   an automatic write or destination deletion.
6. When the target is absent and no committed receipt exists, the user may
   explicitly retry the same publication. Verify the retained temporary and
   current source grant first. An unprepared operation may explicitly rescan
   with the original intent and a new bounded attempt. A committed receipt
   prevents recreating an output its owner subsequently moved or deleted.

An application restart creates new document/generation UUIDs. Recovery does
not erase that boundary or overwrite the original intent. After the user picks
Retry, resolve an explicitly open and authorized document by the original Host
URI, then prove its current profile ID/version, size/mtime/prefix and original
device/inode/size/mtimeNs/ctimeNs. Capture the fresh document/profile generation
only as the current authorization guard. Any fresh grant change revokes the
retry. Missing original observation permits inspection only. The operation ID,
original selection references and digest remain immutable. Metadata evidence
does not prove protection against a privileged actor that can forge filesystem
identity or restore unobservable content and timestamps.

## Alternatives and primary sources

The current Node 24 [hard-link API](https://nodejs.org/docs/latest-v24.x/api/fs.html#fspromiseslinkexistingpath-newpath)
delegates to the filesystem primitive. Reuse ADR-069's no-replace/hard-link and
inode-plus-digest proof rather than adding a second publisher. Node's
[exclusive open flags](https://nodejs.org/docs/latest-v24.x/api/fs.html#file-system-flags)
refuse existing files but have network-filesystem limitations. Its
[FileHandle.sync](https://nodejs.org/docs/latest-v24.x/api/fs.html#filehandlesync)
requests a device flush; [BigInt nanosecond stats](https://nodejs.org/docs/latest-v24.x/api/fs.html#statsmtimens)
preserve nanosecond timestamps and filesystem identifiers. The official Node 24
filesystem document was freshly fetched during this implementation.

A page iterator was rejected because lookahead, hydration/index budgets,
sorted windows and invalid-record truncation do not define exhaustive raw
coverage. The direct forward scanner is the simple baseline, with real engine
reference and query-predicate differential fixtures as its correctness oracle.
Rename/copy fallback, automatic retries and metadata-only destination proof
were rejected for overwrite, duplicate or false-commit risks.

## Lifecycle, limits and rollback

Private journals and raw spools live under the extension's global storage
`raw-export-operations` owner. They are never source inputs, public artifacts,
telemetry, Output log data or harness receipts. On Windows, numeric POSIX mode
does not replace inherited user storage ACLs. The destination parent is selected
by the user and must support hard links. This work does not promise power-loss
transactions, parent-directory fsync durability, network-share semantics or
recovery after loss of the extension's storage.

There are at most 256 retained operation directories and eight scan attempts
per operation. Terminal receipts have the same cap; pending/corrupt operations
are never automatically evicted. A full or corrupt store fails closed.
Immutable exclusive admission slots enforce the cap across VS Code hosts;
an interrupted reservation consumes a slot until explicitly inspected. Partial
spools and pre-journal sibling temporaries after a process crash are retained
for explicit operator inspection; there is no automatic broad sweep. Successful
settlement removes only paths whose current identity matches recorded owned
evidence. A later explicit retirement UI remains separate scope. Raw pending
data can consume storage until reviewed; directory entries and file bytes are
not a cross-process database transaction.

Focused tests cover exact real-engine references, LF/CRLF/EOF/blank/invalid
UTF-8, inclusive ranges, predicate progress past a page, query delivery races,
picker intent changes, budgets, corrupt/full journals, failed prepare flush,
cancellation/grant loss before publication, destination identity conflicts,
link-before-receipt recovery, real session close/reopen, and deleted committed
outputs. They do not claim human product acceptance, power-failure durability
or universal filesystem behavior.

Rollback removes the two native scoped commands and their modules and restores
the prior raw-core callback-free flow. Preserve private operation storage for
inspection and every destination. Do not reset the store or delete outputs to
make rollback appear clean. Projected formats, arbitrary projections, multirow
selection UI and broader format migrations remain future contracts.
