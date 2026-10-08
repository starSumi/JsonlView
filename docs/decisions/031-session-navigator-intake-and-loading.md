# ADR-031: Session Loading, Native Metadata, and Source Intake

Status: experimental; supersedes the initial-load, metadata freshness, and
intake UX decisions in ADR-030.

## Pressure

An empty first catalog displayed a misleading zero count and then an update
hint until the user refreshed. Real producer layouts also exposed missing
agent names, duplicate Claude session identities, and large-file omissions.
Uniconized sort commands crowded the narrow view toolbar. A clipboard command
did not provide a visible place to drop files or paste JSONL content.

## Invariant

- A count is shown only after a completed scan. Waiting, loading, error, empty,
  cached, and partial results have distinct presentation. Partial status survives
  catalog reopen; a bounded index count is never a claim about the full archive.
- Provider stores are read-only. Names, IDs, relationships, and provenance come
  from provider metadata; a product label does not overwrite a provider title.
- Shared parent session IDs do not identify Claude child agents. Native layout
  and agent IDs establish child identity; absent parents remain explicit orphans.
- A coherent SQLite read snapshot can be useful while the provider is writing.
  Advisory fingerprint drift does not require quiescence before displaying it.
  Read-only access does not assert that the producer database is immutable;
  locking and change detection stay enabled for active databases.
  Native session links open the current authorized transcript at its start;
  unrelated provider writes mark updates available without blocking that link.
  Generic record anchors retain strict fingerprint checks. Both paths verify
  canonical containment, authorization and catalog generation before opening.
  Location construction uses the same canonical root and target as authorization;
  lexical aliases cannot be persisted as absolute or parent-traversing locations.
  A refresh rebuilds malformed locations left by an older catalog projection.
- File inputs stay file inputs. Pasted content is explicitly submitted into an
  owned temporary preview, never appended to a provider log or saved in the
  navigation catalog. The original pasted bytes are not silently normalized.

## Owner and decision

Native adapters own provider layout, bounded metadata extraction, and deduplication.
The catalog owns persisted snapshot completeness. The tree provider owns loading,
retry, cancellation, and a compact view: label for the name, description for
relative time and relationship, tooltip for full identity and source location.
Root/session icons distinguish topology. Normal availability and repeated IDs
do not consume list width; a short ID is the final unknown-title fallback.

The primary toolbar contains Add Source, Refresh, and one Sort icon. Sort opens
a native QuickPick. Other management commands use the overflow menu. The view
keeps native progress and per-source status; one failed source does not hide
another source's successful result. A failed initial scan can be retried from
its warning state or by reopening the view.

Add Source opens a lazy, theme-aware WebviewPanel for file/folder selection,
dropping sources, and explicit multiline JSONL paste. A TreeView cannot expose
this multiline/drop-zone form, so it remains the navigation surface instead of
becoming a custom tree renderer. Empty-tree guidance uses viewsWelcome, not an
action disguised as a data node. OS drops enumerate DataTransfer items; the
`files` MIME wildcard is not treated as a guaranteed item key.

The opt-in navigator also places a compact Webview View before the native tree.
It keeps a dashed local-file drop target and a visible file-picker button above
the session list. The same host-side URI validation and explicit source
authorization apply to both entry points; the persistent view does not read the
clipboard or stream file contents through the Webview. It accepts VS Code
Explorer URI drops; when the host does not expose a dropped file as a URI,
clicking the target opens the file picker. The richer panel remains the explicit
multiline-paste surface.

The intake form has a host-enforced 1 MiB / 10,000 record text limit. Larger
existing files use the existing bounded reader without copying file bodies
through the Webview. Temporary previews are separately owned, capped, and
cleaned by their controller. Cancellation discards pending intake work. The form
uses no remote content, source-code execution, or automatic clipboard reads.

## Alternatives and deferred work

- Requiring all source files to remain unchanged for a whole metadata scan was
  rejected: active sessions can starve first load even though a short database
  read transaction already gives a coherent thread/edge snapshot.
- Scanning every JSONL under an agent home was rejected: history and telemetry
  are not project sessions; file limits can exclude the actual transcript tree.
- Replacing the native tree with a permanently mounted Webview was rejected:
  only the explicit multiline intake form needs a custom surface.
- Streaming arbitrary clipboard sizes, JSON-array conversion, a custom virtual
  filesystem, append-to-source, MCP ingestion, and terminal pipe transport are
  separate experiments. Clipboard strings are not intrinsically streams, and
  replacing commas is not a JSON parser. No constant-memory or zero-copy claim
  follows from using a stream API after a whole string is already allocated.
- Dragging tree nodes to rewrite agent parentage is outside the read-only
  contract. A general TTL/LRU daemon is unnecessary for this bounded intake.

## Evidence

- [VS Code Views UX](https://code.visualstudio.com/api/ux-guidelines/views)
  recommends descriptive labels, few actions, native trees, and no action nodes.
- [Tree View guide](https://code.visualstudio.com/api/extension-guides/tree-view)
  defines primary/secondary view actions, welcome content, and view progress.
- [VS Code Webviews UX](https://code.visualstudio.com/api/ux-guidelines/webviews)
  reserves custom surfaces for needs beyond the native APIs.
- [Webview Views](https://code.visualstudio.com/api/extension-guides/webview#webview-views)
  documents the persistent Webview View provider lifecycle used for the compact
  source drop target.
- [Webview security](https://code.visualstudio.com/api/extension-guides/webview#security)
  requires minimal capabilities, a restrictive CSP, and validated user input.
- [Claude subagents](https://code.claude.com/docs/en/sub-agents) documents separate
  agent transcripts under the parent session's subagents directory.
- [SQLite isolation](https://sqlite.org/isolation.html) defines read snapshots;
  [WAL](https://sqlite.org/wal.html) distinguishes commit from checkpoint.
- [SQLite URI parameters](https://sqlite.org/uri.html) warns that `immutable=1`
  disables locking and change detection and is unsafe if the file can change.
- [Node.js realpath](https://nodejs.org/api/fs.html#fsrealpathsyncnativepath-options)
  resolves symbolic links; [path.relative](https://nodejs.org/api/path.html#pathrelativefrom-to)
  computes a path between its inputs without asserting filesystem identity.
- Codex state columns and graph edges remain version-specific implementation
  observations, not a public extension API; optional columns are schema-checked.

## Probe and validation

Synthetic fixtures cover a delayed first scan, first-load failure/retry, mixed
source results, partial-count persistence, active database commits, provider
agent names, shared parent session IDs, and large Claude transcript prefixes.
The isolated host must load both provider layouts without a manual refresh,
render child nesting, show three compact actions at a narrow width, and open
the source form with keyboard-accessible paste input. Real-store probes report
only aggregates and never copy private conversations into fixtures or reports.

## Boundary and rollback

The feature remains opt-in. No MCP transport, provider mutation, automatic
network request, or release promotion is added. Disable the Navigator to stop
scans, close the intake controller to clean owned previews, or revert the
scoped implementation. Provider logs and databases are never deleted. A failed
cleanup retains unknown or locked files rather than deleting unrelated data.
An abrupt Extension Host exit can leave an owned temporary preview behind;
normal controller cleanup is not a crash-recovery guarantee.

Revisit after representative source sizes demonstrate a need for pagination,
connection reuse, or streaming intake beyond the current explicit limits.
