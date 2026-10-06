# ADR-025: Experimental Staged Mutation and Local Agent Navigation

Status: proposed

## Context

JsonlView currently treats JSONL bytes as an immutable source and keeps framing,
indexing, projection, and rendering behind bounded read contracts. A future
companion surface could help a user find local agent sessions, parent/child
threads, workflows, tools, plans, goals, and memories across more than one
producer. A second experiment proposes controlled edits, clipboard or drop
ingestion, and a local MCP boundary.

These pressures are related but they do not share an authority. Navigation is a
read projection over producer-owned stores. Editing changes bytes and therefore
needs a source identity, a conflict policy, recovery, and an explicit commit.
MCP adds a third caller that can outlive a UI request. A fast data structure or
an atomic file replacement does not supply those policies.

## Decision

Treat the feature as an opt-in companion experiment with a single host-owned
mutation coordinator. Keep the shipped viewer read-only until the stages below
have independent evidence. The coordinator is the only component allowed to
turn an edit intent into a staged change or a commit.

The architecture has four ownership layers:

| Layer | Owns | Must not own |
| --- | --- | --- |
| Provider adapters | read-only discovery of a documented or observed source, provenance, and bounded snapshots | source mutation, secrets, or a public promise about a private schema |
| Catalog/index | normalized navigation records and relation edges in extension-owned storage | the producer's source bytes or a second authoritative copy |
| Mutation coordinator | authority lock, generation, preconditions, journal, staging, conflict detection, and commit | rendering details or direct UI/MCP writes |
| Webview, TreeView, and MCP facade | requests and immutable projections | filesystem replacement, arbitrary commands, or bypassing the coordinator |

The base source remains unchanged while a session is in staging. A staged
document is an immutable base plus an ordered delta set keyed by source identity
and base-coordinate ranges. The default P3 workflow exports a new editable copy.
Replacing the original is a later, separately approved capability.

An original replacement first persists an intent containing the target identity,
base digest, expected replacement digest, owned temporary path, and operation
fence. It then records replace-started, performs the platform replacement, and
records replace-observed only after a fresh identity and digest reconciliation.
If the process stops after replacement but before readback or journal outcome,
recovery reports an unknown commit and reconciles the source and temporary file;
it never claims that the source stayed unchanged. Flush and rename provide a
best-effort process-consistency boundary, not a promise of power-loss
durability. The default user action is “Create an editable copy” or “Stage
edit”; there is no silent unlock of the source.

### Authority and operation contract

Every UI, ingestion, or future MCP request carries:

    operationId, idempotencyKey, documentId, baseGeneration, baseDigest,
    expectedOldBytesOrDigest, editRanges, replacementLineBytes, actor, capability

The coordinator serializes intents per document. It rejects an unknown
generation, a changed source identity, a stale expected range, a path outside
the canonical allowlist, a symlink or reparse-point swap, a duplicate operation,
or a request that exceeds byte, line, operation, or wall-clock budgets. The
contract distinguishes sourceGeneration, baseGeneration, and stagingGeneration;
the digest is SHA-256 over the exact source bytes used by the snapshot, and an
initially unverified digest is an explicit unknown state. Idempotency keys are
unique within a provider and document scope and remain replayable until journal
garbage collection has a recorded watermark. A successful stage publishes a
new stagingGeneration without changing sourceGeneration. A commit has an intent
record, a temporary-file record, a replace record, a readback digest, and an
outcome. Startup reconciliation marks incomplete intents unresolved and never
guesses that a replacement succeeded.

Path checks use a canonical allowed root and a regular-file identity bound to an
open handle where the platform permits it. The identity and digest are checked
again immediately before replacement and after readback. A name-only check is
not a sufficient defence against a reparse or check-to-use race. These checks
are not a cross-process compare-and-swap. Original replacement is considered
only when the coordinator can prove exclusive handle protection; otherwise the
operation remains an export-copy, even if the precondition check passed.

An external watcher is an invalidation hint. Reconciliation covers initial
scan, restart or downtime, overflow, rename, replacement, duplicate events,
and reorder. It compares file identity, size, timestamps, and the required
digest before accepting a write. Windows ReplaceFile or MoveFileEx semantics,
sharing violations, ACL failures, antivirus locks, and metadata preservation
are explicit test cases. Atomic replacement provides a per-file publication
step; it is not a transaction across the source, catalog, MCP caller, and UI.

### Data structures and performance claims

The first implementation benchmark is an immutable base plus sorted delta
intervals. Delta ranges are expressed in base-byte coordinates and carry the
source encoding, BOM, newline mode, and expected old-byte digest. Overlapping
or reordered edits are rejected until an explicit rebase operation exists.
Variable-length edits never silently reinterpret CRLF, UTF-8, or a partial tail.
A PieceTree or LSM-like staging store may be evaluated only behind the same
interface if it wins on representative edit and viewport workloads.
The terms “zero-copy”, “O(1) physical addressing”, “O(log N) end-to-end edits”,
and “120 FPS” are hypotheses, not acceptance criteria. Variable-length line
replacement has a budgeted worst case proportional to the full source bytes at
commit, and VS Code message boundaries can copy data. Every candidate records p50/p95 stage latency, commit
latency, bytes rewritten, peak RSS, cancellation latency, frame time, and
recovery results for short-line, long-line, malformed, CRLF, and partial-tail
corpora. A slower or less reliable experiment stays disabled.

The catalog starts as a small versioned SQLite sidecar owned by
globalStorageUri; workspace associations use storageUri and workspaceState.
DuckDB is an optional later adapter for measured analytical queries, not a
required startup dependency. Source provider databases are opened read-only
and are never copied into product truth or modified. The sidecar needs versioned
migrations, bounded WAL and busy handling, crash recovery, stale-index detection,
and a full rebuild path. WAL protects the sidecar's own transactions; it does
not make a source-file replacement atomic with the catalog or guarantee
durability across power loss.

The normalized record keeps provenance and confidence rather than pretending
that different providers have one native schema:

    source, provider, nativeId, parentNativeId, kind, createdAt, updatedAt,
    status, sourcePath, byteStart, byteEnd, rowOrdinal, confidence,
    redactionState, sourceGeneration, baseGeneration, stagingGeneration

The normalized entity is a projection record. Operation and snapshot receipts
carry the three generation fields separately; consumers must not infer one
generation from a projection row.

Raw payloads stay lazy. A provider adapter is versioned and can return
unsupported when its observed shape changes. A Codex adapter may consume a
read-only snapshot of thread and spawn-edge metadata; a Claude adapter must
treat observed local shapes as compatibility inputs until a public contract
exists. No adapter reads credentials, prompts, or message bodies by default.

### User surface and authority lock

The companion navigator uses a collapsed Activity Bar container with a native
TreeView for session and relation navigation. A Panel is reserved for dense
diagnostics or a timeline. A webview is used only for projections that native
TreeView cannot express. The editor view has explicit states:

    readOnly -> staging -> committing -> readOnly
                        -> conflict
                        -> unavailable
                   committing -> unknownCommit -> reconciling
                                            -> resolved
                                            -> conflict
                                            -> unavailable

The state is visible, keyboard reachable, and announced through the host UI.
unknownCommit and reconciling prohibit automatic retry and keep the authority
lock fenced until a reconciliation receipt resolves the outcome.
Layout polymorphism can choose a table, drawer, or timeline from the same
immutable view model, but it cannot change the mutation authority. A detail
drawer may stage a scalar replacement; a structured editor may stage a larger
AST-aware patch. Both produce the same coordinator intent and diff preview.

### MCP boundary

Phase one exposes no write tools. If a read-only MCP provider is added later,
its tools are bounded queries over the same catalog and immutable snapshots:

    list_sessions, get_session, list_relations, read_slice, search_index

Each call has cancellation, result-size and traversal budgets, a capability
scoped source allowlist, a stable snapshot token, and redaction. It cannot run
commands, open arbitrary paths, or return secrets. The transport and process
owner are explicit (stdio or a documented local HTTP transport); stdout is
protocol-only, stderr is bounded, and the provider has a timeout and output
cap. Every response carries an operationId and fence token. A late or
uncancellable response is discarded and cannot retain the UI authority lock.
Phase two may add stage_patch, returning a diff and precondition receipt without
touching the source. Phase three may add an explicitly user-confirmed
commit_staged_changes bound to the exact current diff and receipt, subject to
the journal, readback, and conflict gates. An external caller cannot forge the
confirmation or reuse it after the staging generation changes.
No append or repair tool is planned until a separate source-adapter contract
proves framing, validation, and recovery.

The integration is opt-in and lazy. Discovery is activated by an explicit
command or view request, not extension startup. The manifest declares the
Restricted Mode policy; metadata-only discovery can be offered there, while
external paths, source disclosure, staging, and any MCP process are denied
until Workspace Trust and a per-source allowlist are present. Responses use
opaque source identifiers unless the user explicitly requests a path. The MCP
provider is a separate failure domain where practical; a hung or late request
cannot retain the UI authority lock.

## Staged delivery gates

1. **P0 contract freeze:** publish the normalized entity and operation schemas;
   add synthetic fixtures for parent/child edges, generations, malformed lines,
   stale writes, and redaction. No runtime integration.
2. **P1 read-only catalog:** implement one provider adapter and a bounded
   Activity Bar TreeView. Verify cancellation, snapshot consistency, source
   provenance, restricted-mode behavior, and bounded cold-start cost.
3. **P2 staging prototype:** add immutable base plus delta intervals, a diff
   preview, authority-lock transitions, idempotency, and crash-recovery tests.
   The source remains unchanged.
4. **P3 export experiment:** enable only for synthetic fixtures and an explicit
   editable-copy workflow. Exercise stale generations, permissions, disk full,
   rename failure, leftover temporary files, watcher overflow, and readback.
   Replacing the original is a later capability with its own approval and
   recovery gate.
5. **P4 read-only MCP:** expose the bounded query facade under explicit opt-in;
   run tool validation, access control, output-size, timeout, and cancellation
   tests. No source write capability.
6. **P5 measured write/MCP review:** consider staged patch and commit tools only
   after an independent security review, representative performance results,
   public ownership, rollback documentation, and a human acceptance receipt.

Each future capability can be disabled independently. A committed source is
not reversible by reverting this ADR; rollback requires a preserved baseline or
export copy and an explicit inverse operation with a new generation. Failure
disables the capability and keeps the existing JSONL viewer usable through the
portable read path.

## Failure and recovery matrix

| Failure | Required result |
| --- | --- |
| stale generation or digest | reject with conflict; base remains unchanged |
| duplicate operation id | return the recorded outcome; never apply twice |
| crash before intent | no source change; startup records an abandoned request |
| crash after temp write | validate or delete only the owned temp file; do not infer commit |
| crash after replacement before readback | report unknown commit; reconcile source and temp identities and require human resolution |
| replace or permission failure | retain base and staging; surface retry or export-copy action |
| disk full after replacement | report unknown commit; preserve the currently observable source and journal for reconciliation |
| disk full or quota breach | abort and retain base; clean bounded temporary state |
| watcher overflow or rename | invalidate snapshot and require reconciliation |
| MCP timeout or late response | cancel the request and release the authority lock |
| malformed or oversized input | keep raw evidence unchanged; stage a separate rejected/import copy |
| untrusted workspace or path escape | deny the capability before opening the source |
| source changes between check and use | reject or reconcile by handle identity and digest; never apply a stale patch |
| temp collision or stale temp cleanup | require an owned operation fence; quarantine unknown files |
| journal or WAL corruption | disable writes, retain unresolved replacement intents, and rebuild the catalog from source evidence |
| ACL, antivirus, or metadata failure before replacement is observed | retain the original source and return an explicit export-copy path |
| ACL, antivirus, or metadata failure after replacement is observed | report unknown commit and retain the currently observable source for reconciliation |

Automatic quote repair, object flattening, or “self-healing” source mutation is
not permitted. A repair preview can be a derived scratchpad with a new source
identity and an explicit export action.

## Official platform references

- [JSON Lines format](https://jsonlines.org/)
- [VS Code contribution points](https://code.visualstudio.com/api/references/contribution-points.md)
- [VS Code Tree View API](https://code.visualstudio.com/api/extension-guides/tree-view.md)
- [VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview.md)
- [VS Code Workspace Trust](https://code.visualstudio.com/api/extension-guides/workspace-trust.md)
- [VS Code MCP servers](https://code.visualstudio.com/docs/agent-customization/mcp-servers.md)
- [VS Code activation events](https://code.visualstudio.com/api/references/activation-events.md)
- [MCP Tools security considerations](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
- [MCP transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [SQLite write-ahead logging](https://sqlite.org/wal.html)
- [Node.js file system APIs](https://nodejs.org/api/fs.html)
- [Windows ReplaceFileW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew)

These references define platform constraints and security expectations. They do
not authorize a write path or guarantee performance for this extension.

## Scope and rollback

This ADR adds planning and contract boundaries only. It does not add an MCP
server, database reader, file watcher, write command, PieceTree, Monaco bundle,
telemetry, network service, persistent opt-in flag, or release permission to
the current candidate. Revert this ADR and its roadmap link if ownership,
public contracts, measurements, or recovery evidence cannot be supplied.
