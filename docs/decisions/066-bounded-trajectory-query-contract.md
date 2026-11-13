---
id: "066-bounded-trajectory-query-contract"
path: "docs/decisions/066-bounded-trajectory-query-contract.md"
title: "Bounded Trajectory Query Contract"
kind: "decision"
status: "accepted"
owner: "product"
tags: ["mcp","query","security","profiles","identity"]
evidence: []
revisit: "when a supported producer format changes or cold continuation and storage workloads justify a persistent index"
rollback: "disable trajectory tool and resource registration, preserve the physical query tool, and revert the additive scanner and contracts together"
---
# ADR-066: Bounded Trajectory Query Contract

## Pressure and invariant

Physical record queries cannot substitute for producer-specific actor and error
semantics. A missing error flag is unknown; it must not match `hasError:false`.
Semantic output also needs a reproducible continuation, current authorization,
physical record references and a budget that includes actual reads.

The source JSONL remains authoritative and is opened read-only. This additive
C3 contract preserves the existing physical query API and its index. Shared
contracts own request validation and serialization; profiles own producer
semantics; the extension adapter owns authorized handles, bounded scans, cursors
and publication checks. Neither transport input nor a cursor can supply a path.

## Decision

Trajectory slice v1 accepts a nonempty AND predicate over `actor` and
`hasError`, with strict keys and bounded numeric options. Actor is one of user,
assistant, tool, system or unknown in output. Error is true, false or null.
Only explicit evidence from the selected versioned profile establishes a known
value. Warnings, cancellation, completed events and missing flags do not become
success merely because they lack an error marker. Text is a bounded display
projection, never a promise of full source content.

The result is exactly one complete, partial or error branch. Partial includes
a reason and a continuation; errors carry a fixed code and recoverability,
without records, paths, diagnostic messages or internal exception data.
`returnedBytes` measures compact serializer UTF-8 bytes with that slot set to
zero. Admission checks use the actual serialized result size, including the
final counter. MCP envelope bytes are a separate bounded transport concern.

Each query opens a regular file inside realpath-resolved allowed roots and
compares handle and path metadata before publishing. Host integrations recheck
the current binding and authorization epoch after asynchronous metadata reads.
A standalone stdio process uses its explicit launch-time grants; stopping that
process revokes them. It has no implicit live VS Code authorization channel.

Snapshot v1 is SHA-256 of RFC 8785 canonical JSON for
`{v:1,sourceId,device,fileId,sizeBytes,mtimeUnixNs}`. Numeric filesystem values
are decimal strings; unavailable device/file IDs are null. It detects observed
metadata changes and path replacement. It does not provide immutable snapshots,
content hashing or protection against undetectable same-metadata rewriting.

The portable scanner uses fixed-size reads capped by the remaining examined
byte budget. Profile detection, a cold continuation prefix and repeated reads
all consume that same budget. Examined records count observations, including
repeated prefix work, rather than unique coverage. Only a complete physical row
advances the semantic continuation. Empty, invalid and unknown rows consume
progress without fabricating matches. An oversized first row or a budget that
cannot reach the continuation returns a recoverable failure without a cursor
that would repeat forever. Deadlines are monotonic cooperative boundaries;
they do not preempt an active filesystem read.

A cursor contains exactly
`{v:1,sourceId,snapshotId,queryHash,nextOrdinal,expiresAtMs}`, encoded as
unpadded base64url canonical JSON, with a five-minute expiry. Its query hash
binds the normalized predicate and selected profile ID/version. Parsing rejects
noncanonical, duplicate, malformed and additional fields. It is a locator,
never authorization. A bounded in-memory LRU maps an unchanged snapshot and
ordinal to an offset/profile. After eviction or process restart the scanner
reconstructs the prefix under the requested budgets; arbitrarily large cold
resumes are not guaranteed. This is intentionally not an unbounded replay or a
durable semantic index.

The separate spine projection reuses the same authorization, scanner and
accounting. It presents bounded conversation entries and explicit omission
counts. It does not rename a filtered slice as an entire conversation or claim
token counts without a tokenizer contract.

## MCP compatibility

The opt-in stdio adapter retains `jsonlview_query_records` and adds the semantic
tool and spine resource. Modern `2026-07-28` requests carry protocol version and
client capabilities in each request's `_meta`. `server/discover` is modern;
the `2025-11-25` and `2025-06-18` initialize handshake remains a separate legacy
path. An accepted queued request retains its own version. All data-plane
requests, including resource reads, share bounded admission, cancellation and
total transport deadlines. The effective deadline is the stricter scanner or
transport budget. Adapter exceptions never become client-visible diagnostics.

The shipped standalone `dist/mcp-server.cjs` registers exactly
`jsonlview_query_records`, `jsonlview_query_trajectory_slice` and the
`jsonlview_trajectory_spine` template `jsonlview://source/{sourceId}/spine`.
`resources/list` is empty; `resources/templates/list` discovers the template.
The server advertises tools/resources only, reports `JsonlView/0.1.0`, and
accepts exactly the three protocol versions above. This stdio query adapter
is distinct from the disabled experimental MCP navigation metadata adapter.

Launch grants require one explicit source ID/path and permit no directory
enumeration, arbitrary-path query or inherited VS Code authorization. The
default total server budget is 3000 ms with two active/eight queued requests;
launch settings can select 1–60000 ms and 1–8 active requests. The semantic
request separately caps matches at 128, output at 1 MiB, examined bytes at
64 MiB and its deadline at 30000 ms. Defaults are 50 matches, 256 KiB output,
8 MiB examined and 5000 ms; the server's stricter deadline still wins. No
HTTP listener or long-lived background daemon is introduced by this surface.

## Alternatives and primary contracts

Reusing the physical index's continuation would hide additional indexing and
hydration reads from the semantic budget. A persistent semantic index adds
schema, invalidation, coverage and recovery obligations before its workload
benefit is established. Keep the portable implementation as the differential
oracle before considering that optional acceleration.

Canonicalization follows [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html),
including UTF-16 key ordering and rejecting invalid Unicode and non-finite
numbers. Filesystem identity and read semantics follow the official
[Node.js 24 filesystem contract](https://nodejs.org/docs/latest-v24.x/api/fs.html).
Modern metadata and discovery follow the normative
[MCP basic contract](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/2026-07-28/docs/specification/2026-07-28/basic/index.mdx),
[versioning](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/2026-07-28/docs/specification/2026-07-28/basic/versioning.mdx)
and [discovery](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/2026-07-28/docs/specification/2026-07-28/server/discover.mdx).
Legacy clients remain bound to their negotiated version.

## Probe, evidence boundary and rollback

Use synthetic mixed-role/error fixtures and a sequential oracle. Exercise
actual-byte caps, sparse matches, output boundaries, cold/warm continuation,
expiry, predicate changes, CRLF, blank/invalid UTF-8 rows, no final newline,
replacement, append, authorization revocation during I/O and cancellation.
Compare modern and each supported legacy protocol through the real packaged
stdio entry; test resource URI rejection and queue admission under contention.
Unit tests do not prove external-client interoperability, representative storage
latency or installed UI behavior. Those remain separate acceptance evidence.

Disable the new registrations first, retain the physical query API, then revert
the additive contracts, profile projection, scanner and adapter wiring as one
change. No source mutation or index migration is required for this rollback.
