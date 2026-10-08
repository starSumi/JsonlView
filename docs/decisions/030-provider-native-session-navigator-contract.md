# ADR-030: Provider-Native Session Navigator Contract

Status: experimental

## Pressure

Codex stores rollout files under creation-date directories while its state
database records later activity, names, and spawn edges. Claude stores project
sessions and subagents in a different JSONL layout. Treating every JSONL line
as a tree node loses the session boundary and makes a recently active session
hard to find.

## Invariant

- A provider remains the owner of its IDs, titles, timestamps, relationships,
  transcript files, and state databases. JsonlView never writes those sources.
- The product catalog is a metadata-only projection. It may store a product
  label, source fingerprint, generation, relative reveal location, and bounded
  previews, but not credentials or unbounded message bodies.
- The default order is effective activity descending with a stable native ID
  tie-breaker. A rollout folder date is a source location, not an activity
  timestamp.
- A missing parent is retained as an explicit orphan root. A provider title is
  distinct from a product title and is never overwritten by a product rename.
- Provider adapters open local state read-only. The generic JSONL adapter is an
  explicit compatibility source; provider-native adapters fail closed with a
  bounded warning when their metadata source is unavailable or incompatible.
- When the Navigator is enabled, it detects the provider-owned default roots
  ('CODEX_HOME' or '~/.codex', and 'CLAUDE_CONFIG_DIR' or '~/.claude') without
  scanning arbitrary home-directory files. Custom roots remain explicit.
- Windows junctions are resolved before containment checks, so an explicitly
  authorized Codex home can safely follow its own canonical rollout paths;
  unrelated drives and roots remain rejected. State-file roots resolve to the
  containing home for reveal only.

## Owner

The session-navigator native-provider module owns Codex and Claude metadata
adapters. The catalog store owns the product projection, generation, sort
policy, and product labels. The tree provider owns the Activity Bar surface
and explicit authorization. The JsonlView editor owns transcript rendering
and remains the only source-content surface.

## Decision

Use a skinny session index with these projections:

    provider, nativeId, vendorTitle, productTitle, titleSource,
    firstMessagePreview, startedAt, activityAt, parentNativeId,
    relationship, project, sourceFingerprint, generation, relativePath

The displayed title is productTitle, then vendorTitle, then a bounded provider
preview, then Untitled session plus a short id. The subtitle and tooltip carry
the provider, stable ID, relative activity, relationship, and source details.
Sorting can be changed to activity, created time, or title and is persisted as
a user setting.

The Codex adapter resolves the provider-owned home and, when present, the
provider-owned `CODEX_SQLITE_HOME` separately. It reads threads and
thread_spawn_edges from its state_*.sqlite companion in read-only mode. It orders the bounded
thread query by recency before applying the entity limit, uses recency_at or
updated metadata before created metadata, and filters rollout locations to the
canonical authorized root. The Claude adapter creates one session entity per
authorized session file, uses provider session IDs rather than message UUIDs,
recognizes subagents as a relationship, and keeps missing parents as orphans.
Both adapters expose only bounded metadata and reveal the selected rollout
through the existing read-only custom editor.

An explicit stateRootUri overrides the detected SQLite home for that source.
This experimental slice resolves environment/default locations; it does not
interpret Codex's layered config.toml sqlite_home setting. Such a configured
override must currently be supplied as stateRootUri. The title index remains
under the transcript home even when SQLite storage is separate. Removing a
detected source persists a product-owned exclusion; authorizing it again clears
the exclusion. Automatically detected locations are not pinned into user
settings, so environment changes can be resolved on the next discovery.

The Activity Bar is the topology surface. A command, editor-title action, and
Webview header button all focus the Navigator explicitly. Explorer/editor
actions open one JSONL file as Data Studio and do not add a persistent source.
Tree root drops and clipboard paths produce an authorization candidate and
require an explicit provider choice and confirmation; no dropped bytes are
written to the catalog. A future JSONL text paste remains an ephemeral
preview, not a session source.

## Alternatives

1. Sort by the YYYY/MM/DD rollout directory: rejected because it is creation
   placement, not recent activity.
2. Rebuild a full archive or daemon: rejected because this product is a
   bounded local viewer and must not become another writer of agent history.
3. Put topology in the Data Studio Webview or bottom Panel: rejected because
   the native TreeView provides a separate vertical navigation viewport while
   the editor remains the data projection.
4. Recursively auto-discover all agent home-directory files: rejected because
   authorization, privacy, and startup I/O would become implicit. The
   accepted rule detects only provider-owned standard roots and requires an
   explicit Navigator opt-in; custom roots still require authorization.

## Evidence

- [VS Code Tree View guide](https://code.visualstudio.com/api/extension-guides/tree-view)
- [VS Code TreeView API and TreeDragAndDropController](https://code.visualstudio.com/api/references/vscode-api#TreeDragAndDropController)
- [VS Code custom editor guide](https://code.visualstudio.com/api/extension-guides/custom-editors)
- [VS Code contribution points](https://code.visualstudio.com/api/references/contribution-points)
- Codex source study: F:/playground/codex/codex-rs/rollout,
  F:/playground/codex/codex-rs/agent-graph-store, and the observed
  state_5.sqlite schema. These are implementation observations, not a
  third-party extension API contract.
- Claude source study: F:/playground/Claude_source. This recovered tree is
  learning evidence only and is not treated as an official Claude contract.
- AgentsView study at F:/playground/agentsview (pinned local checkout
  86a7682c3f78b4ecbc3ce99e2b32d231d3f15646) for normalized session metadata,
  effective activity sorting, provider title provenance, and orphan retention.

The official VS Code references define host contribution and drag/drop
contracts. The local source studies explain observed producer shapes; they do
not authorize access to private state or guarantee future compatibility.

## SQLite lifecycle and future update notifications

The current implementation uses Node's built-in SQLite reader, with one short
read transaction per thread/relationship snapshot. It closes the handle after
each scan and does not checkpoint or change journal mode on provider databases.
An advisory fingerprint includes the main database and optional WAL, because
committed changes may exist only in the WAL before a checkpoint. A changed
fingerprint across a scan rejects that candidate; file metadata is an update
hint, not a transactional change feed or proof that a file is unchanged.

Connection reuse is deferred until measured open costs justify its lifecycle
complexity. A future shared resource must be keyed by the canonical database
file and replacement generation, while authorization and projection remain
scoped to each source. Sharing a handle does not remove SQLite's single-writer
rule. Long read transactions can prevent checkpoints from completing.

Separate watchers for transcript and SQLite locations are an accepted experiment,
not an implementation in this slice. Events must be debounced invalidation
hints followed by bounded reconciliation, with explicit refresh retained.
WAL file changes do not expose row changes or reliable checkpoint notifications.
If a future persistent reader uses PRAGMA data_version, comparisons must stay
on the same connection and reset after reopen. Disable, source removal, database
replacement, and extension disposal must release watchers and handles.

Primary references:

- [SQLite write-ahead logging](https://sqlite.org/wal.html) defines commit,
  checkpoint, reader concurrency, and read-only WAL behavior.
- [SQLite isolation](https://sqlite.org/isolation.html) defines snapshot reads.
- [SQLite PRAGMA data_version](https://sqlite.org/pragma.html#pragma_data_version)
  restricts comparisons to the same connection.
- [VS Code file watcher API](https://code.visualstudio.com/api/references/vscode-api#workspace.createFileSystemWatcher)
  defines create/change/delete notifications and watcher limitations.
- [Node SQLite DatabaseSync](https://nodejs.org/api/sqlite.html#class-databasesync)
  defines the existing read-only connection API; no new native dependency is
  introduced for speculative pooling.

## Boundary

This slice is opt-in and local-only. It adds no network transport, MCP server,
source mutation, provider database writes, recursive watcher, or release
authorization. Standard roots are detected only after the user enables the
Navigator; `CODEX_HOME`/`CODEX_SQLITE_HOME` and Claude config roots are the
only automatic locations. Background probes only mark a source stale and a
visible Navigator performs a bounded metadata refresh. Harness fixtures and
host receipts remain outside the product tree.

## Revisit trigger

Revisit after isolated-host acceptance covers a real state_5.sqlite copy,
Claude subagent fixture, restart persistence, stale reveal rejection, root
drop cancellation, clipboard path validation, restricted workspace behavior,
and bounded scan measurements. A separate security review is required before
any MCP or write capability is added.

## Rollback

Disable the sessionNavigator.enabled setting, remove authorized source
settings, or revert this experimental module and its manifest entries. Product
catalog data is extension-owned and may be deleted only through an explicit
cleanup action; provider files, state databases, and transcript directories
are never deleted by rollback.
