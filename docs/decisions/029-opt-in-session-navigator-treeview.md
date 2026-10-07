# ADR-029: Opt-In Session Navigator TreeView and Local Catalog

Status: experimental (provider-native details superseded by ADR-030)

## Pressure

Local agent histories are producer-owned and heterogeneous. A user should be
able to find session, thread, fork, workflow, task, tool, and subagent metadata
without locating provider directories by hand, while the existing JSONL editor
keeps its startup, read-only, and bounded-rendering guarantees. A companion
surface must not turn private producer layouts into a new product authority.

## Invariant

- The navigator is disabled by default and performs no provider scan while
  disabled or before an explicit user action.
- Sources are explicit `file://` roots stored in user settings; source paths,
  bodies, prompts, credentials, and arbitrary record payloads are not copied to
  the catalog or returned in tree labels.
- Catalog rows are a derived, versioned projection. Provider files remain the
  source of truth and a failed or partial scan never replaces the last complete
  snapshot.
- Every scan, relation traversal, and reveal is bounded by file, byte, record,
  relation, depth, and wall-clock budgets. A late or cancelled result cannot
  mutate the visible tree or the editor's authority.
- Reveal is an explicit host action. It carries an opaque source id, catalog
  generation, native id, and row ordinal into the existing read-only Data
  Studio; the host uses the current document generation for the Webview message
  and cannot write or execute the source.

## Owner

`src/experimental/session-navigator/` owns the provider, normalized snapshot,
SQLite catalog, TreeView lifecycle, and reveal-intent registry. The extension
host owns activation and VS Code handles. The Webview owns only the existing
read-only row selection request. The harness owns synthetic fixtures, host
probes, receipts, and measurements.

## Alternatives

1. Scan Codex or Claude directories during extension activation: rejected
   because it adds startup I/O and silently discloses private state.
2. Put the navigator in the editor Webview or bottom Panel: rejected because a
   native TreeView gives the topology an independent vertical viewport and
   keeps the editor projection separate from discovery.
3. Read provider SQLite databases without a provider adapter: rejected because
   it would couple the tree to an unbounded private schema. ADR-030 adds only a
   bounded, explicitly authorized, read-only Codex state projection.
4. Use DuckDB in the first slice: deferred because the catalog needs bounded
   point lookups and restart recovery before analytical scans justify another
   runtime dependency.
5. Start an MCP process or expose write tools now: rejected until transport
   ownership, trust, cancellation, output caps, and a separate security review
   are complete.

## Probe

The focused suite uses synthetic JSONL files only. It covers source parsing and
de-duplication, metadata redaction, parent/fork/spawn relations, file and byte
budgets, cancellation before I/O, catalog persistence and generation changes,
stale location rejection, and unsolicited reveal generation validation. Host
acceptance still requires an isolated VS Code launch with a temporary
`@@--user-data-dir` and `@@--extensions-dir`, a real Activity Bar TreeView, keyboard
focus, visibility changes, and reveal into a synthetic fixture.

## Decision

Implement a dormant Activity Bar container with a native TreeView. The view is
created lazily and only becomes visible when
`jsonlView.sessionNavigator.enabled` is true. Five explicit commands cover
enable, disable, add source, remove source, and refresh. Refresh is the only
operation that scans sources; a bounded background probe may mark “update
available” while the view is visible, but it never replaces rows or reorders
the tree without an explicit refresh.

Persist the authorized source list in `jsonlView.sessionNavigator.sources` in
the user's VS Code settings. Store only normalized metadata, relation edges,
generation, and relative locations in a versioned SQLite sidecar under
`globalStorageUri`. Use Node's built-in `node:sqlite` API, WAL for the sidecar,
foreign keys, a busy timeout, and a transaction per complete source snapshot.
Provider roots are never returned as tree data; a reveal re-probes the
authorized source, rejects a changed catalog fingerprint, validates that the
resolved path remains inside the configured root and is a regular file, then
opens the existing custom editor.

The generic JSONL provider remains the compatibility fallback. Provider-native
Codex and Claude adapters now build one session entity per provider session
file or state row, retain parent/subagent/orphan metadata, and keep activity
timestamps separate from source folder placement. These adapters are still
experimental observations rather than stable producer contracts. MCP remains a
dormant architecture seam over the same immutable catalog/query contract; this
slice adds no process, transport, network endpoint, tool registration, or write
path.

## Evidence

- [VS Code contribution points](https://code.visualstudio.com/api/references/contribution-points.md)
- [VS Code Tree View guide](https://code.visualstudio.com/api/extension-guides/tree-view.md)
- [VS Code API: TreeDataProvider and createTreeView](https://code.visualstudio.com/api/references/vscode-api)
- [VS Code Workspace Trust](https://code.visualstudio.com/api/extension-guides/workspace-trust.md)
- [SQLite write-ahead logging](https://sqlite.org/wal.html)
- [Node.js SQLite API](https://nodejs.org/api/sqlite.html)
- [Model Context Protocol tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
- [Model Context Protocol transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

These references define platform contracts and security expectations. They do
not establish a provider's private file schema, guarantee scan performance, or
authorize access to a user's local history.

## Boundary

This phase adds a product integration seam and a disabled-by-default read-only
TreeView. It does not add private source fixtures, automatic root discovery,
recursive filesystem watchers, source mutation, staged edits, MCP transport,
telemetry, network access, or release authorization. Provider scans occur only
after explicit authorization and refresh. The extension remains usable when the
catalog is unavailable, corrupt, stale, or disabled.

## Revisit trigger

Revisit after an isolated VS Code host probe proves startup, focus, scroll,
refresh, cancellation, stale-generation reveal, restricted-mode, and restart
behavior on synthetic roots; after each real provider has a pinned observed
shape and redaction review; and after an independent review approves a
read-only MCP transport boundary.

## Rollback

Disable the setting and remove the session navigator registration, or revert the
experimental module, manifest contributions, Webview reveal message, tests, and
this ADR. The stable editor has no dependency on the catalog and published
source files remain untouched. Delete only the extension-owned catalog after a
separate, explicit cleanup action; never delete provider roots.
