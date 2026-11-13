---
id: "068-bounded-read-only-record-text"
path: "docs/decisions/068-bounded-read-only-record-text.md"
title: "Bounded Read-Only Record Text"
kind: "decision"
status: "accepted"
owner: "product"
tags: ["security","identity","vscode","hydration","webview"]
evidence: []
revisit: "when larger records require a streaming viewer or native host acceptance finds a lifecycle gap"
rollback: "remove the additive record-text action and provider registration together while retaining existing detail and Raw views"
---
# ADR-068: Bounded Read-Only Record Text

## Pressure, invariant and ownership

Large record text needs a native editor action without retaining another large
DOM tree or treating a partial Webview preview as a complete record. This C3
addition uses the existing detail toolbar. The source remains read-only and no
source path, content, or command is accepted from the Webview.

The engine owns the bounded raw read and exact index coordinate check. The
Extension Host owns authorization, generation, opaque references and the native
document lifecycle. The shared protocol adds only `OPEN_RECORD_TEXT {ref}`;
the action has no data response and creates no pending Webview request.

## Standards and alternatives

The [VS Code virtual document contract](https://code.visualstudio.com/api/extension-guides/virtual-documents)
provides a read-only document from a `TextDocumentContentProvider` string and
requires cleanup on close. This fits a bounded whole-record document. A
`FileSystemProvider`, temporary file, generated executable content or custom
whole-file editor adds unnecessary write or runtime authority. A future
streaming viewer needs a separate contract for larger records.

## Decision and failure behavior

- The existing detail toolbar exposes **Open record as read-only text**. Its
  FileText action is unavailable during detail loading or source invalidation.
- The receiver rejects extra payload/ref keys, mismatched generations and
  noncanonical or overlong decimal coordinates. The engine verifies all byte
  coordinates against its own current index and refuses unindexed ordinals.
- The host resolves `sourceId` to an already-open document with a live panel.
  No path or new source authorization is derived from the request or URI.
- The `jsonlview-reveal-text` URI contains only two random UUIDs. The original
  source identity and a frozen reference remain in host memory; URIs cannot
  recreate grants after close or extension restart.
- The read checks strict observed path/handle identity and generation before
  and after reading. It uses `validateObservedSource`, which performs bounded
  metadata observations without starting a whole-source fingerprint. A changed
  observation fails closed, including append; no original-snapshot append
  compatibility is promised for this action.
- After the record size cap passes, verify the original prefix and tail
  fingerprints before and after the record read. Each boundary is at most
  64 KiB, so additional content verification is at most 256 KiB per action,
  independent of source size. This detects short-file rewrites even when the
  filesystem reports unchanged timestamps. It does not prove equality of an
  unobserved middle range under an equal-metadata rewrite. Reveal's separate
  metadata-only observation remains free of content reads.
- A record above **1 MiB** is refused before allocating its content buffer.
  Exact valid UTF-8 text is returned without JSON parsing, formatting, or the
  JSONL delimiter. Invalid UTF-8 and partial content are refused.
- There are at most **20** retained references and **4 MiB** of cumulative
  output per provider lifetime. Reads are serialized, and native open actions
  are single-flight. Cancellation, retirement or failed opens release their
  reference. Closing a matching document releases it; disposal clears all.
- Late results recheck authorization and source generation before publication.
  Native output remains an immutable snapshot once provided. This mechanism
  cannot erase text already seen by VS Code or guarantee an atomic filesystem
  snapshot against an adversarial writer that preserves all observable metadata.
- Host failures show fixed, bounded refusal messages without source contents,
  private paths or raw exceptions. No shell or source-derived command executes.

## Probe, evidence and boundary

Tests cover exact UTF-8 bytes, coordinate forgery, stale generation, source
replacement, append, invalid encoding, read caps, authorization revocation,
opaque URI validation, provider registration, output budgets, late open,
single-flight and cleanup. A deterministic unchanged-metadata rewrite regression
and a large-source byte-budget test exercise the bounded boundary fingerprints.
The append regression requires zero whole-source
fingerprint calls. These tests establish bounded behavior and failure handling;
they do not establish a real VS Code paint, large-workload latency or user
acceptance. Native host acceptance remains a separate check.

## Rollback and revisit

Revert the additive toolbar action, one-way protocol, host adapter and provider
registration together. Existing `GET_DETAIL`, Raw, copy and source access
semantics remain the fallback. Revisit the design when records over 1 MiB need
a streaming native presentation or host evidence reveals a lifecycle problem.
