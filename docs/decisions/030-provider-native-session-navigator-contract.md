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
- Provider adapters open local state read-only and fall back to the bounded
  generic JSONL adapter only when the provider-native metadata source is not
  available or is not compatible.
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

The Codex adapter reads threads and thread_spawn_edges from an explicitly
authorized state_*.sqlite companion in read-only mode. It orders the bounded
thread query by recency before applying the entity limit, uses recency_at or
updated metadata before created metadata, and filters rollout locations to the
canonical authorized root. The Claude adapter creates one session entity per
authorized session file, uses provider session IDs rather than message UUIDs,
recognizes subagents as a relationship, and keeps missing parents as orphans.
Both adapters expose only bounded metadata and reveal the selected rollout
through the existing read-only custom editor.

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
4. Auto-discover all agent home directories: rejected because authorization,
   privacy, and startup I/O would become implicit.

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

## Boundary

This slice is opt-in and local-only. It adds no network transport, MCP server,
source mutation, provider database writes, recursive watcher, or release
authorization. Background probes only mark a source stale; explicit refresh is
the authoritative reconciliation. Harness fixtures and host receipts remain
outside the product tree.

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
