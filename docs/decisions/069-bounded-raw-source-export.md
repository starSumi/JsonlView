---
id: "069-bounded-raw-source-export"
path: "docs/decisions/069-bounded-raw-source-export.md"
title: "Bounded Raw Source Export"
kind: "decision"
status: "accepted"
owner: "product"
tags: ["export","filesystem","security","identity"]
evidence: []
revisit: "when filtered export, larger sources, or unsupported destination filesystems need a separate contract"
rollback: "remove the export command and its two extension modules; preserve all user-created destination files"
---
# ADR-069: Bounded Raw Source Export

## Pressure, scope and owner

Users need a separate byte-preserving copy of an open JSONL source. This C3
extension-owned operation exports the entire physical source, including malformed
rows, delimiters and final undelimited bytes. Table filters, sort, projections,
Collections, and semantic profiles do not alter the copy. This is an explicit
native command, not an MCP tool or a new Webview message.

## Decision and invariant

The command is available from the Command Palette, the JsonlView editor title,
and the upper source board title. It requires an open local JsonlView document;
the save dialog states the whole-source scope. Closing the last source panel,
changing the document/generation/epoch, or failing a current source check revokes
publication. Repeated concurrent commands for the same document share one
operation. No automatic retry is performed after a result.

The extension captures the current identity and fingerprints at most 1 GiB in
64 KiB chunks. Export rechecks that identity and observed source state before
copying and immediately before publication, opens the source read-only, copies
to a random sibling temporary file with `wx` and mode `0600`, checks source
metadata plus the complete SHA-256, flushes and closes the temporary handle,
then re-reads and verifies the temporary file. Decimal strings carry sizes and
the captured lifecycle epoch; `authorizationEpoch` in the internal receipt is
the open-document epoch, not a Navigator source grant.

Publication uses a same-directory hard link. An existing destination is never
replaced, including a destination created during copying. Unsupported hard-link
filesystems fail closed. A successful link still requires a destination inode
and digest proof. Ambiguous outcomes return `commit-unknown`; the target is
preserved, never deleted as compensation. Cleanup removes only the random
temporary pathname whose current inode/device still match the owned file.

Cancellation is checked before publication and between bounded reads. Once the
link begins, the operation finishes its bounded destination proof and reports
the result even if cancellation arrives. It cannot claim cancellation while
leaving a successfully published file unreported.

## Standards and alternatives

Node 24 [fsPromises.link](https://nodejs.org/docs/latest-v24.x/api/fs.html#fspromiseslinkexistingpath-newpath)
uses the filesystem hard-link primitive and points to POSIX `link(2)`.
The Windows Node primitive was exercised with a real temporary source and
destination, including an existing destination. Node's
[copyFile contract](https://nodejs.org/docs/latest-v24.x/api/fs.html#fspromisescopyfilesrc-dest-mode)
allows default overwrite, makes no atomic-copy guarantee, and may remove a
destination on error. Therefore copy/rename publication is not a fallback.
[FileHandle.sync](https://nodejs.org/docs/latest-v24.x/api/fs.html#filehandlesync)
requests a device flush whose implementation is OS/device specific.

## Boundaries and known unknowns

This is bounded application-level publication evidence, not a filesystem
transaction or power-loss durability guarantee: the destination directory is
not synced. Hard links require filesystem support; FAT-like targets and some
network shares may reject them. The destination parent is user-selected and
must be trusted against hostile same-user directory replacement. Portable Node
path APIs cannot make parent-directory replacement or same-user temporary-file
tampering atomic with publication. Final identity and digest proof detects
unverified output but cannot retract an ambiguous target safely.

Memory is bounded to one 64 KiB buffer per sequential pass, excluding Node
hash state. The complete operation performs fingerprint, copy, temporary proof
and destination proof passes, so IO can reach four source lengths. The 1 GiB
ceiling is a product budget, not a benchmark-derived performance promise.
Filtering/exporting selected rows and durable retry receipts are deferred.

## Validation and rollback

Focused tests cover exact bytes, Windows paths and a real Windows hard link,
source fingerprint/generation/epoch changes, authorization revocation, existing
and competing destinations, temporary replacement, unsupported filesystems,
ambiguous commit proof, cancellation before and after publication, document
retirement and closed-panel fencing. Type, contract and product gates apply.
Real VS Code save-dialog and progress behavior still require host acceptance.

Rollback removes command/menu registration and the two extension modules. It
never cleans user-selected destinations or broadens temporary cleanup.
