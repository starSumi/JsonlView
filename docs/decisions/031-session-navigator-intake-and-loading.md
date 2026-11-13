---
id: "031-session-navigator-intake-and-loading"
path: "docs/decisions/031-session-navigator-intake-and-loading.md"
title: "Session Loading, Native Metadata, and Source Intake"
kind: "decision"
status: "experimental"
owner: "product"
tags: ["freshness","loading","session-navigator"]
evidence: []
revisit: "when loading or freshness behavior changes"
rollback: "restore the previous intake behavior"
---
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
  navigation catalog. The submitted Unicode string is encoded as UTF-8 without
  changing CRLF, whitespace, record order, or a trailing delimiter. Clipboard
  strings do not carry an original filename or filesystem provenance.

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
single-file temporary previews, and explicit multiline JSONL paste. A TreeView cannot expose
this multiline/drop-zone form, so it remains the navigation surface instead of
becoming a custom tree renderer. The persistent source-drop view supplies empty
state guidance; the native tree does not add an action disguised as a data node.
OS drops enumerate DataTransfer items; the
`files` MIME wildcard is not treated as a guaranteed item key.

The opt-in navigator also places a compact Webview View before the native tree.
It keeps a dashed local-file drop target and a visible file-picker button above
the session list. A single `.jsonl` or `.ndjson` drop opens a bounded temporary
preview and never changes the authorized-source setting; Recent Previews exposes
the existing Save As action. Files and Folder remain the explicit source
authorization routes. URI drops and browser File objects use the same host-side
validation and UTF-8/size/record limits. Folders, unsupported files, and drops
whose path is not exposed open the native picker. The persistent view never reads
the clipboard or writes source content into the navigation catalog.

The intake form has a host-enforced 1 MiB / 10,000 record text limit. Larger
existing files use the existing bounded reader without copying file bodies
through the Webview. Temporary previews are separately owned, capped, and
cleaned by their controller. Cancellation discards pending intake work. The form
uses no remote content, source-code execution, or automatic clipboard reads. The
persistent source-drop view is the single intake guidance surface while the
Navigator is enabled; the enabled Sessions tree does not repeat this copy
through `viewsWelcome`. The Sessions view remains visible while disabled and
uses an empty native tree with welcome Enable and Settings actions. Its message
must be empty so VS Code can display welcome content.

### Current-session preview lifecycle

`SessionPreviews` owns temporary files and an in-memory index containing only
an opaque ID, creation time, record count, UTF-8 byte count, source URI, typed
status, and optional saved-copy URI. Neither this index nor clipboard contents
are written to the catalog, memento, Output, or console. Recent Previews is a
separate native TreeView in the same container, available without Navigator
enablement or provider discovery. Its entries represent scratch files, never
agent sessions. Open revalidates the owned file identity; Save As uses the same
owner as the Viewer action. A saved copy can be opened separately.

The finite state machine is `temporary -> saving -> saved`. Cancellation or
failure restores the prior stable state; another Save As is allowed from
`saved`. Concurrent and reentrant saves share one operation. `saved` means a
separate permanent copy exists: the original URI remains temporary and the
Viewer continues to say Temporary preview. Cold READY delivers metadata through
the validated document/generation/epoch envelope before normal interaction.
The Viewer supplies no destination path; only the native save dialog does.

Save As accepts a new local destination outside the owned temporary directory.
It revalidates source identity, reads at most the bounded preview size, creates
the destination exclusively, writes the exact bytes, flushes, and verifies the
result. Existing files, including the source, cannot be overwritten. A failed
write removes only a destination still matching its empty creation identity.
Partial writes and external changes cannot be distinguished reliably, so any
changed destination is retained and the failure notification explains that an
incomplete file may remain. Failure-time attributes are never adopted as new
cleanup ownership. Cancellation or a stale owner
before dispatch writes nothing. A dispatched write finishes even if its tab
closes, and normal controller disposal drains it before temporary cleanup.
Save success survives a failure to open the permanent copy and is reported as
saved with an open failure, rather than deleting the user's copy.

Closing a tab or intake panel leaves owned previews available through Recent
Previews during the current Extension Host session. The cap is 20 previews,
including previews with a saved copy. Reaching the cap refuses the next import
with an explicit message; no unsaved preview is evicted. Normal controller
disposal attempts non-recursive cleanup only for identity-unchanged owned files.
Missing, externally edited, replaced, or locked files are retained or reported
unavailable. Saved destinations are outside cleanup ownership. There is no TTL,
LRU, persistent preview index, reload recovery, or crash recovery guarantee.

The editor remains a `CustomReadonlyEditorProvider`. VS Code offers no close
veto or save hook on that provider; a dispose callback runs after close. The
product therefore uses an explicit temporary marker, manual Save As, and
current-session Recent recovery, without pretending that the document is dirty
or intercepting normal close commands.

### Remembered Navigator enablement

Opening Sessions while disabled asks through a native Enable / Settings /
Cancel prompt. Enable writes the existing global
`jsonlView.sessionNavigator.enabled` setting, then re-reads its effective value
to respect workspace overrides. Future opens skip this prompt while enabled.
Settings and Cancel do not change settings, discover sources, scan, or open a
catalog. Enabling the built-in Navigator grants no source permission: the
source-drop surface continues to guide source authorization separately, without
a repeated empty-source modal on every open.
Only sources explicitly recorded in the existing sources setting are scanned.
Detected provider homes remain candidates until selected for authorization;
granting one source records that source without enabling the Navigator or
granting other detected homes. Previously enabled installations with no
explicit sources now use the same source-drop authorization guidance.

Table query controls still operate on the current file through bounded scans;
column selection changes projection. The production Table query is not wired
to the Navigator catalog. Enablement is not a claim of cross-session search or
measured performance improvement.

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
- [Custom readonly editor API](https://code.visualstudio.com/api/references/vscode-api#CustomReadonlyEditorProvider)
  defines only open and resolve operations; editable save hooks belong to a
  different provider contract.
- [Save dialog API](https://code.visualstudio.com/api/references/vscode-api#window.showSaveDialog)
  selects a destination URI or returns undefined; the extension owns the write.
- [Node.js file open flags](https://nodejs.org/api/fs.html#file-system-flags)
  defines exclusive creation with `wx` / `wx+`.
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
Focused regressions also cover cold preview metadata, validated Save As
requests, exact Unicode/CRLF bytes, cancellation, existing targets, partial
write rollback and target replacement, concurrent/reentrant saves, late native
dialogs, disposal during a dispatched write, current-session reopen, the cap,
and disabled Navigator choices without catalog or provider IO.

## Boundary and rollback

The feature remains opt-in. No MCP transport, provider mutation, automatic
network request, or release promotion is added. Disable the Navigator to stop
scans, dispose the session controller to clean owned previews, or revert the
scoped implementation. Provider logs and databases are never deleted. A failed
cleanup retains unknown or locked files rather than deleting unrelated data.
An abrupt Extension Host exit can leave an owned temporary preview behind;
normal controller cleanup is not a crash-recovery guarantee.

Revisit after representative source sizes demonstrate a need for pagination,
connection reuse, or streaming intake beyond the current explicit limits.
