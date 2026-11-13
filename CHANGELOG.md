# Changelog

## Unreleased

- Preserve case-distinct manifest keys in Windows packaging, validate legacy ADR
  headings, and keep architecture alias and DOM smoke string handling literal.
- Consolidate the current studio milestone with reviewed dependency updates:
  React Virtual 3.14.25, VSCE 4.1.0, Biome 2.6.4, pnpm setup 6.1.1, and paired
  CodeQL 4.39.3 actions. Retain the compatible napi-derive 3.6.8/runtime 3.12.7
  pair; the isolated derive 3.7.0 update requires a coordinated native migration.
- Refresh the test and packaging dependency graph to remove reported high and
  critical advisories, including the runtime package's older test worker pool.
- Track the AppShell transition separately: Import-origin guidance for original
  file views and the detail Navigator entry still need the next milestone.
- After an editor-area Import opens a temporary preview, offer explicit Save As or Keep Temporary Only and publish success before the choice resolves. Explain session-only recovery in Recent Previews; Collection filing remains a separate user action.
- Preserve cancellation ownership when duplicate request IDs are rejected,
  unregistered control actions finish, or cancelled IDs are reused before an
  older handler settles. Admit requests before changing rebuild sequences,
  lineage, graph, or first-request observations. Exercise the current Rebuild control in host smoke
  checks, cover multibyte UTF-8 split reads, and require module review and the
  standalone MCP CLI tests in CI.
- Centralize versioned cross-process contracts and fail-closed message directions,
  add explicit request/reply/broadcast delivery and versioned source intake, and
  extract Node-testable host controllers with scanner and predicate boundary
  coverage. Keep heavy I/O timeouts scoped to affected tests. Migrate OTLP
  settings to the canonical `jsonlView.telemetry.otlp.*` prefix with deprecated
  aliases, and load exporter modules only after opt-in and endpoint validation.
- Close ACP profile selection with extension deactivation, reject late launches,
  and await bounded local process-tree shutdown on Windows and POSIX, including
  descendants that ignore graceful termination. Keep optional side-agent
  delivery outside the shutdown wait and suppress its late UI effects.
- Group ACP, Raw Export, Reveal Text, Trajectory, MCP sidecar, Integrated
  Session, Follow, Observability, and Diagnostics modules under private domain
  folders while preserving shared contracts, generic runtime, and existing
  composition roots.
- Share one package-owned MCP protocol core between the independent private
  CLI/library and the extension sidecar, with paired adapter conformance tests.
- Reveal Collection session references in Agent Sessions through reverse drag
  and drop, retaining current source authorization and generation checks.
- Keep Collection archive intent metadata-only by default, with an opt-in Agent Sessions filter for currently linked archived session references.
- After a temporary JSONL/NDJSON preview is saved and its open attempt settles,
  offer one prompt to add a source, file the copy into a Collection or dismiss.
  Keep verified copies and report retained source permission if later filing
  fails. Collection onboarding requires explicit read-only permission and
  leaves newly registered files outside automatic scans until explicit Refresh,
  Add Source or extension restart. Log only allowlisted failure metadata.
- Honor explicit Refresh admission of a saved source while a scan is running
  by awaiting one following pass. Skip that pass when Sessions is hidden, the
  window loses focus, or Navigator is disabled or disposed.
- Add existing authorized references directly from empty Collections or their
  add action. Move source intake from the sidebar into a wide editor-area
  Import canvas before the Collections create action, with file, folder and
  paste actions; keep temporary previews and source authorization under their
  existing owners. Handle local `text/uri-list` drops as bounded temporary
  previews.
- Add versioned ACP/MCP adapter and pinned plugin metadata, selectable local ACP v1 profiles, separately modeled runtime targets, and an official MCP SDK interoperability probe; remove the bridge's fake `/mcp` responder and label its remaining route as a private JSON-RPC tunnel.
- Show ACP connection stages and elapsed time in a cancellable notification
  and status-bar entry. Identify handshake, session and response timeouts,
  missing executables and authentication failures without logging private
  adapter errors; suppress results from a superseded connection.
- Allow an existing Collection reference to be filed into another Collection,
  including unavailable references, without probing source data.
- Show a stateful Run query capsule inside Query Studio with a shortcut hint,
  real scanning state and keyboard-reachable Cancel. Prevent repeated Run
  submissions and let Escape cancel a pending query before closing.
- Keep the Agent Sessions heading neutral while automatic polling starts and
  stops with view visibility, window focus, enablement and source authorization.
- Preserve split UTF-8 in ACP transcripts, isolate session updates and bound
  outgoing messages. Stop MCP reads when the client disconnects or output
  fails, and discard oversized input through its newline.
- Replace the record lineage list with a causal rail, source-backed metadata
  badges, shared-parent tool branches, bounded previews and return navigation.
  Explicit lookup checks one neighboring window within 500 records and a 1 MiB
  read allowance, with cancellation and source/profile freshness checks.
- Add an explicit machine-scoped opt-in OTLP/HTTP exporter for bounded
  query-duration metrics. Export remains disabled by default; disabling or
  changing the endpoint destroys the old transport and blocks follow-up POSTs.
- Keep local coding-agent candidates discoverable and addable after a source is
  authorized, while preserving explicit authorization and scan boundaries in
  Session Navigator.
- Open Query Studio from one neutral Play icon, replacing the former sliders
  entry and duplicate toolbar submit button. Keep search Enter submission and
  the Studio's Run action, keyboard shortcuts and focus restoration.
- Restore the funnel field-filter icon and original three-column chooser icon,
  preserving the field tree, query conditions and accessible names.
- Move record lineage into the Detail Drawer using only the accepted filtered
  and sorted page. Preserve exact record selection, mark missing or ambiguous
  evidence explicitly, and retire the independent Graph workspace tab.
- Report a source change during a queued Graph read as stale, and distinguish
  a refused bounded read from an empty graph.
- Preserve a successful Collections result when journal cleanup fails or its
  COMMIT response is lost, preventing a false failure prompt from causing a
  duplicate retry. Retained cleanup work is recovered separately.
- Keep accepted Collections commands in a shared SQLite journal so another
  window's cleanup cannot erase pending work. Import visible legacy commands
  without changing their identity or writing Memento; preserve metadata and
  verified migration backups when recovery cannot proceed.
- Retain legacy session identities during Collections v3 migration so original
  accepted commands and receipts remain replayable after reopening metadata.
- Preserve a freshly published Graph when a superseded node-reveal observation
  completes late; only the owning publication may invalidate its references.
- Bound Graph source reads to a shared 4 MiB allowance across index scanning,
  reference reconstruction and row hydration; reject changed source observations
  without whole-source fingerprint reads, and honor queued deadlines/cancellation.

- Rename Collection references with local aliases, record or clear session-local
  archive intent, and explicitly rebind references while preserving their links.
  Retain source authorization, lower Sessions behavior, legacy metadata backups
  and original command receipts; registered file references open through the
  existing source gate.

- Export a selected record, inclusive ordinal range or all matches of the last
  delivered query as exact raw full records in physical order. Bound scanning
  and output, preserve existing destinations, and inspect durable operations
  before explicit retry, including after a verified source is reopened.
- Refuse read-only text handoffs after a detected boundary rewrite, including
  short-file changes with unchanged filesystem timestamps, with bounded reads.
- Add a current-document Graph hierarchy from a bounded background physical
  prefix, with provider-evidenced relations, explicit partial/stale states and
  confirmed physical-record reveal. Keep cross-source graphs unsupported.

- Confirm internal Navigator reveal against the rendered physical row, retain
  bounded timeout and generation guards, and keep filtered targets explicit.
- Open complete records up to 1 MiB as native read-only text from the detail
  toolbar, with opaque URIs, current source checks and bounded output budgets.

- Reject malformed ACP result/error envelopes before releasing pending requests,
  so invalid adapter replies settle the prompt instead of leaving it hanging.
- Connect ACP v1 adapters with correctly typed MCP environment entries and
  supported authentication advertisements. Handle tool permission requests
  with a cancellable, once-only native picker and preserve unknown-RPC errors.
- Export an open source as an exact, SHA-256-verified raw JSONL copy through a
  cancellable command. Copy all physical rows up to 1 GiB, preserve existing
  destinations and reject changed or closed source snapshots.
- Recover accepted Collections commands with their original identity after an
  interrupted result, and preserve idempotent receipts across metadata migration
  and reopening. Keep intentional same-name creations distinct.
- Harden the pure Graph model with explicit Host authorization and physical
  evidence bindings for cross-source edges, current generation checks, bounded
  projection kinds and complete late-layout identity checks. Preserve actual
  engine content-end references with delimiter lengths recorded separately.
- Combine display columns and row-value filters in a bounded, expandable field
  tree, retain exact array-index paths, and use a Play glyph for Run Query.
- Add a bounded, read-only trajectory slice contract with explicit unknown
  semantics, metadata-bound cursors and safe errors; keep physical record
  queries compatible.
- Separate modern MCP request metadata from legacy initialization and prevent
  adapter exception diagnostics from entering protocol errors.
- Keep the Sessions title's LIVE/PAUSED indicator bound to attention-gated
  polling: pause and cancel probes when Sessions is hidden, the window loses
  focus, Navigator is disabled or authorization is empty; resume with one probe.
- Extract the workspace body into a render-only WorkspaceSurface while keeping
  state, IPC, query, hydration and transaction ownership in App.
- Add an independent native Collections board for user-owned collection names
  and source references. Collection CRUD and membership preserve the separate
  read-only Agent Sessions projection, source bytes and authorization. Keep
  native OS/Explorer drop intake and an Import/Paste Add Source QuickPick
  independent of collection membership.
- Refresh materialized collection reference rows without root-resetting their
  TreeView handles during Sessions updates.
- Combine row order into one toggle and field conditions plus row types into
  one Filters disclosure. Keep Save As and Columns in one responsive More
  Actions group, and protect the table with container-aware detail sizing.
- Adapt table query controls to their local container, presenting Save As and
  Columns inline above 540px and inside native More Actions at narrower widths.
- Let interactive requests run before queued profile probes and Insights scan
  slices, avoid repeated head detection while indexing is incomplete, and add
  bounded local read-call, byte, and longest-wait diagnostics.
- Assemble VSIX candidates from an explicit public staging allowlist, require
  package localization and legal files, and exclude internal decision records
  and harness material while keeping npm packaging independent.
- Verify published Open VSX and npm artifacts against candidate SHA-256 digests, redact common POSIX absolute paths without matching URL paths, and bound/cancel portable MCP stdio queries.
- Move the query execution DTO to its canonical shared contract owner while
  preserving the v1 wire shape and deprecated compatibility facade.
- Keep the existing Query Studio trigger in the shared second toolbar row
  across all five views while reusing the current bounded query controller.
- Add bounded metadata-only Treemap contracts and a pure selected-level layout
  with exact decimal weights; Host aggregation and Insights rendering remain
  separate integration work.
- Add bounded GET_ROWS timing receipts for queue wait, index work, reads,
  parsing, projection, and snapshot checks; keep overlapping phase semantics
  explicit and timing out of the ROWS payload.
- Adapt BFCL v3-shaped JSONL records through bounded row summaries and show a
  BFCL-specific Insights view scoped to the current query page, without mixing
  in unrelated generic aggregates; retain Generic JSONL observations as the
  fallback for other data.
- Render OpenTelemetry File Exporter rows as bounded semantic projections:
  signal, time/severity, nested records, service, operation, trace/error and
  duration columns; add envelope-aware detail and current-page Insights while
  preserving one physical JSONL row per source line.
- Make Navigator source intake actionable for OS file and folder drops: single
  JSONL files open bounded temporary previews with Recent Previews / Save As,
  unsupported drops fall back to the native picker, compact Paste opens the
  editor explicitly, and agent connectors without detected local homes stay
  hidden.
- Add owner-boundary TypeScript path aliases across source imports, derive the
  same aliases in Vitest and esbuild, and keep Webview architecture checks
  aware of aliased imports.
- Enforce erasable TypeScript syntax and explicit declaration contracts, add
  Rust 2024 precise lifetime capture, and gate the opt-in React Compiler with
  a bounded Activity detail surface and compiler-aware execution identity.
- Refactor bounded Webview projections and provider presentation into explicit
  feature/provider seams while preserving the single reducer, protocol client,
  query controller, generation barriers, and compatibility entry points.
- Extract the table query toolbar into a render-only feature seam while keeping
  query state, protocol ownership, and cancellation boundaries in App.
- Include the extension localization manifest in staged VSIX candidates so
  Restricted Mode descriptions resolve after installation.
- Keep the current descending page when an append response races a click before the Webview commits the new rows.
- Keep the search field fully visible when status information reduces toolbar space.
- Show Rebuild only while the displayed snapshot is invalidated, with its label on wide panes and its icon on narrow panes.
- Render legacy Kimi agent message envelopes and nested tool commands through the Kimi semantic presentation instead of the malformed journal fallback.
- Bound test execution to two isolated thread workers while preserving the complete test set and default timeouts.

- Collapse query toolbar action labels to icons when the toolbar is narrow, preserve accessible names and active counts, and identify observed problems clearly in the status strip.
- Coalesce eligible forward-page hydration reads into a bounded, snapshot-clamped window while preserving direct reads for small or observable scans.
- Add a development-only, exact-env-gated query observation tap with a fixed metadata allowlist, bounded non-blocking delivery, terminal failure closure, and aggregate-only CDP temporal-association measurements; explicitly make no causal attribution claim, keep host and Webview clocks separate, and leave production behavior unchanged.
- Keep the compact query-rail scrollbar transparent until hover or keyboard focus.
- Keep the data-grid horizontal scrollbar implicit until hover or keyboard focus, and visible in forced-colors mode.
- Skip table cells and unused conversation/dataset scenes during bounded full Insights aggregation.
- Request conversation and dataset row scenes only for views that consume them, reuse the physical query viewport on view changes, and inspect detection samples without materializing display rows.
- Collapse workspace tab labels only on narrow workspace panes while preserving accessible names, keep Follow identifiable, and reflect either visible Navigator child view in the header glyph.
- Move the Session Navigator SQLite catalog behind a complete application port, centralize provider loading and reveal policies, bound reveal intents, and invalidate stale continuations while retaining cached sessions.
- Bind Kimi probe handoffs to their observed fingerprint, close replacement generations inside SQLite transactions, and preserve Claude terminal pages.
- Adapt Kimi KAP server v1 journals alongside persisted wire sessions, merge matching session identities in authorized homes, and project server events with bounded metadata and exact source evidence.
- Detect metadata-anchored Kimi agent-core wire files across the bounded sample, including human-domain message and turn events, and project their session, message, request, usage, token, and task semantics without exposing request prompts or task output tails.
- Add bounded Rust JSONL record queries to the product command and expose the
  same read-only data plane through an opt-in MCP stdio server and configured
  ACP agent sessions. Keep source paths host-owned and transport connections
  explicit.
- Add a metadata-only side-agent handoff for activation contribution conflicts,
  with VS Code Chat and clipboard fallback when no side-agent consumer is
  installed.
- Add a transport-neutral Rust MCP manager for explicit diagnostic actions,
  with bounded metadata-only requests and `2026-07-28`, `2025-11-25`, and
  `2025-06-18` protocol compatibility. No Copilot or provider-specific bridge
  is required.
- Keep ascending row order available while reverse indexing is incomplete, expose order as a radio group, and use host semantic tokens for selected options and workspace tab indicators.
- Match compact header rules to the nested query controls, and keep Navigator intake actions legible in forced-colors and very narrow sidebars.
- Keep compact query controls on a single horizontally scrollable rail so Columns stays reachable without wrapping into another header row.
- Recognize one-object-per-line ShareGPT and VirtualHome datasets with bounded detail projections while preserving the physical row and explicit top-level-array fallback.
- Adapt the pinned `sft-master` conversation and keyword-result JSONL families through strategy-owned projections, including human/assistant, prediction, and target detail sections.
- Add explicit read-only Gemini, OpenCode, and AgentsView source choices without home-directory scanning, and expose the disabled MCP capability for inspection.
- Gate staged mutation behind an opt-in setting, workspace trust, source authorization, and an explicit user gesture.
- Register the V2 four-plane architecture, Rust/native rules, and read-only MCP/audit plan with evidence-gated experiments for sparse indexes, staging, OTel, ML, and provider-neutral agent parsing.
- Project nested provider-neutral agent envelopes through bounded message, reasoning, tool, result, usage, and media-reference views while keeping unknown data in Raw.
- Extract detail splitter interactions, profile-query reconciliation, and Kimi event section projection into focused internal modules while preserving App composition, reducer ownership, and provider arbitration.
- Organize detail-splitter geometry and interaction under a feature boundary, and execute native pnpm binaries directly for nested packaging commands.
- Split the Webview stylesheet into fixed-order feature modules and add complete-block regression coverage without changing style declarations.
- Return the Session Navigator Webview to idle when a diagnostic notification is dismissed, and keep duplicate requests busy until the active operation settles.
- Add a bounded Conversation display for existing profiles, preserving physical record selection, query state and raw details. Compact the workspace controls into two rows while retaining temporary-preview Save As.
- Adapt persisted Kimi Code messages and loop events, with hidden and encrypted content kept opaque. Discover Kimi sessions through a separately authorized, metadata-only Navigator source.
- Add bounded dataset observations for targets, message roles, explicit loss weights, sequence lengths, declared counts, categories, and inert media references. Keep loaded-page samples distinct from whole-file analysis.
- Mark pasted files as temporary previews, recover them from Recent Previews during the current VS Code session, and offer exact-byte Save As without overwriting existing files. Remember explicit Session Navigator enablement and keep source authorization separate.
- Populate default columns and cell values when a fresh file opens with last-line-first row order already selected.
- Preserve a selected dataset record's prompt, output, title, and tags when an ordinary nested payload contains similarly named fields.
- Keep column visibility changes local when the current page already contains the required values; fetch missing fields through the existing bounded query.
- Record bounded query start and settlement metadata in the local Output channel, distinguishing empty results, cancellation, stale work, and failed delivery without logging query text or source content.
- Add a pure, accessor-safe OTLP metric projection for settled queries with finite labels; keep exporter setup, settings, network access, and shutdown flush gated.
- Bound optional dataset detection with explicit failed, timeout, cancelled, and disabled outcomes. Preserve Generic JSONL loading, discard late results, and report the terminal stage and recovery action.
- Show QA fields and classification labels in Generic detail previews, preserve zero and empty label values, and disclose message groups longer than the 32-entry preview.
- Keep lifecycle failure logs to fixed stages and allowed error metadata, without copying exception messages, paths, or source content into Output or console.
- Show prompt/completion, preference prompts, token data, and knowledge metadata in Generic JSONL detail previews. Render batch output once while preserving explicit tool results and the source record in Raw.
- Add metadata-only dataset head provenance for bounded LLaMA-Factory shape inspection, with profile-epoch-safe publication, Generic JSONL fallback, and a Profile status indicator.
- Observe stalled document creation before editor resolve, and clean up its watchdog on completion, failure, or cancellation while preserving late results and existing startup outcomes.
- Make every indexed Session Navigator root and nested child reachable through bounded continuation branches. Discard invalidated page reads and preserve non-ASCII title order across catalog pages.
- Use exclusive physical cursors for adjacent ordinal pages in either order. Preserve partial windows and bounded scan identity through append recovery and column refresh; keep direct page jumps at their logical matching rank.
- Give Insights an explicit Current view or Whole file scope, share Table query conditions, label bounded scan coverage, and discard results from superseded query or profile intents.
- Report one verifiable, path-free execution identity from the Extension Host, Webview startup receipts and packaged build manifest. Verify the complete runtime binding and completed bundle bytes, reject stale dist or changed build inputs, and discard late requests or recovery publications when document generation or epoch has advanced. Report build optimization separately from the actual host extension mode.
- Trace startup stages across the extension host and Webview with generation-safe acknowledgements, a bounded startup watchdog, and first-row diagnostics for stalled loads.
- Preserve an unfinished page navigation across live index updates and profile refreshes, including sorted pages and empty-page recovery.
- Group search, row-type and field filters, and column visibility in the table toolbar, with explicit current-file query scope and bounded scan status. Combine multiple row types with OR and field conditions with AND; keep nested content paths in on-demand column choices.
- Preserve the physical reading anchor through manual Rebuild with Follow disabled, including delayed browser scroll clamping.
- Keep Tree's selected-record content preview visible by default above the JSON fields, including text, Markdown, JSON, and code presentation controls.
- Resume viewport following when scrolling to the current source tail, and dismiss Back to bottom without requiring a click.
- Keep live source updates independent of table scrolling. Preserve history anchors and clicked-row detail while reading, show new activity, and return to the latest page on demand.
- Restore single-record detail scrolling. Selecting another row starts at the top; safe generation recovery preserves that record's scroll and expanded content without reopening a closed drawer or retrying a failed detail request.
- Future staged evolution work will be recorded here.
- Expose bounded file navigation actions on Agent source nodes while keeping session-only actions scoped to entities.
- Keep append-invalidated snapshots readable while preserving the selected row and detail drawer until an explicit rebuild.
- Keep one Agent Sessions Activity Bar entry and remove the duplicate JSONL editor title action.
- Preserve the current snapshot while a moving JSONL source settles, then adopt a validated generation atomically without closing the detail drawer.

## 0.2.9 - 2026-10-12

- Keep the Data Studio action available from any editor title bar while
  preserving a higher-priority JSONL session action.
- Add bounded, source-safe Session Navigator actions for opening, revealing,
  copying paths or session IDs, and opening the native timeline without
  mutating provider-owned files.
- Separate display-budget status from provider content and add bounded Claude
  projections for nested memory and known file-tool inputs while keeping Raw
  authoritative.
- Isolate event presentation, bounded content analysis, and the Integrated
  Session profile behind facade-preserving modules with colocated coverage.
- Establish product documentation ownership, machine-readable metadata, and an
  evidence-gated roadmap for staged vertical migration and future format
  adapters.
- Record the native scanner measurement boundary and portable fallback trigger
  conditions so optional acceleration remains evidence-driven.
- Keep provider adapters and observability surfaces bounded, read-only, and
  separate from harness reports and host evidence.
- Refresh the public release contract with explicit deferred tags, rollback
  conditions, and the next-stage data-format discovery boundary.

## 0.2.8 - 2026-10-10

- Render Codex function-call output once, project Claude top-level tools and
  prompt attachments, and render Pi thinking, text, tool calls, tool results,
  diffs, and patches through bounded shared detail components while preserving
  each source payload in Raw.
- Keep record, cell, and scroll selection stable across pointer focus, keyboard
  navigation, empty grid space, append invalidation, and manual rebuilds;
  preserve the selected detail drawer by physical record identity.
- Add bounded Session Navigator pagination with transactional SQLite generation
  swaps, parent-edge reconciliation, cancellation, non-progress guards,
  durable catalog reuse, stat-only fingerprint probes, and explicit loading,
  retry, partial-index, and pending-Rebuild states.
- Add provider-native Codex and Claude projections with activity-first sorting,
  native titles, child-session and orphan relationships, junction and home-alias
  resolution, bounded sidecar metadata, default-root detection, and read-only
  custom source intake with a keyboard-accessible drop target and paste preview.
- Add an opt-in pi coding-agent adapter for the standard agent home and
  `PI_CODING_AGENT_DIR`/`PI_CODING_AGENT_SESSION_DIR` overrides, preserving
  bounded titles, activity times, and cross-file fork relationships without
  copying transcript bodies.
- Add a disabled-by-default, transport-independent MCP navigation contract
  negotiating 2026-07-28 and 2025-11-25 with one bounded read-only metadata
  query, while keeping v2 wire integration separate from the legacy SDK line.
- Register a dedicated bounded JsonlView Output channel and recoverable
  commands to explain or copy the last diagnostic, with best-effort VS Code
  Chat handoff from the Navigator.
- Add a no-op-by-default OTLP observability contract that rejects source bodies,
  paths, prompts, credentials, and arbitrary JSON.
- Extract engine fingerprinting, Navigator scanning and provider dispatch, and
  the extension Insights query behind existing facades without changing
  generation fencing, cancellation, read-only ownership, or VS Code IPC.
- Establish the fnm-owned Node pin, runtime-bounded decomposition plan, and
  changed-file Biome lint gate; let VS Code's native Open With own JSONL editor
  selection while retaining the Navigator action.
- Keep the source file authoritative while adding a synthetic immutable provider
  index contract, staged-mutation benchmark with byte oracle and p50/p95
  receipts, and a dormant opt-in read-only navigation facade; none reads a
  producer store or enables source mutation.
- Make Windows native release builds reproducible with MSVC `/Brepro`, and make
  VSIX candidate archives reproducible when `SOURCE_DATE_EPOCH` is fixed with
  the selected epoch recorded in provenance.
- Improve interaction coverage for menu dismissal, paging, semantic views, and
  nested details, and add a synthetic Codex rollout Insights showcase for
  category and time distributions.

## 0.2.7 - 2026-10-06

- Improve interaction coverage for menu dismissal, paging, semantic views, and
  nested record details.
- Make VSIX candidate archives reproducible when `SOURCE_DATE_EPOCH` is fixed,
  with the selected epoch recorded in candidate provenance.
- Add a synthetic Codex rollout Insights showcase covering category and time
  distribution views.

## 0.2.6 - 2026-10-06

- Place the bounded indexing status before the toolbar at wide widths while
  preserving accessible status semantics and narrow-container reflow.
- Use explicit sort-shape icons in one row-order toggle so the control is not
  confused with search-match navigation or page movement.
- Refresh the homepage showcases with curated Codex rollout, structured record
  detail, and Claude timeline views while keeping source sessions out of the
  product tree.
- Record a staged read-only agent-history adapter roadmap; private state, source
  mutation, network access, and MCP exposure remain outside the product contract.
- Reconcile the visible page after clearing search even when the host omits the
  Page input blur event.
- Include discovered nested schema fields in the structured filter field list
  while preserving the bounded table projection.
- Navigate table cells and view tabs with the keyboard without opening a
  record until Enter or Space. Keep focus inside narrow-screen record details
  and return it when closing them.
- Keep column and filter menus within short or narrow editor viewports.
- Retain page recovery parameters while indexing finishes, avoiding repeated
  empty-page requests after rebuilding.
- Clear stale records when a replacement snapshot opens and prevent Follow
  from retaining another document's records.
- Switch the table between forward and reverse record order and restore the
  selected order when reopening the view. Keep the controls disabled with an
  explanation while indexing or rebuilding.
- Explain hydration-bounded physical pages without implying that their order
  is incomplete, and allow the current partial-result notice to be dismissed.
- Select nested object fields such as `$.message.role` as table columns.
- Keep the default table columns when opening a view in reverse order before
  its first row projection is available.
- Continue reverse paging beyond 2,048 rows. When a filtered physical-order
  scan reaches its allowance, offer Next only for further matches already
  found in the examined range and keep the partial-result notice visible.
- Close the column and filter menus when clicking or moving focus outside them,
  or pressing Escape; Escape returns focus to the menu control.
- Fall back to the Node scanner after a packaged native scanner failure and
  avoid retrying the failed native scanner in the same extension-host process.
- Replace the repeated file name with a compact responsive workspace header
  that keeps controls, record metrics, update state, and progress visible as
  the editor narrows.
- Keep verified append snapshots readable for row selection, details, search,
  and paging without Rebuild; show an update indicator and explain when a
  rewritten source prevents loading another record.
- Reveal the selected record after a page change even when its page-local index
  stays the same, so returning to the first page does not retain a stale scroll
  position.
- Reveal keyboard-selected records even when the selection has not changed, so
  Home returns to the first row after scrolling away from it.
- Keep keyboard-selected rows fully visible below the sticky header and reveal
  a selected row again when the source generation changes.

## 0.2.3 - 2026-09-28

- Restore vertical scrolling in Problems and distinguish problem-page entries
  from distinct problem records observed during hydration.
- Automatically request a bounded full-record load when an oversized record is
  selected in an open detail drawer; keep the 16 MiB automatic ceiling, the
  configured full-record limit, and the manual action for fallback.
- Classify Codex `web_search_call` response items as assistant tool calls,
  preserving their status and search action instead of labeling them `other`.
- Bound serialized tool-argument decoding to the syntax-preview budget and keep
  oversized values on the existing generic preview path.
- Add bounded lexical highlighting for Shell, PowerShell, JavaScript/TypeScript,
  Python, Rust, and SQL; recognize explicit `apply_patch` envelopes and highlight
  changed lines with their per-file language while preserving exact source text.
- Use bounded chunked accumulation for display-only JavaScript formatting and
  preserve oversized source unchanged for the outer preview budget.
- Add the Unified Diff `FileChange` screenshot to the product README examples.
- Use a PNG for the performance showcase so VSIX packaging accepts the README image.

## 0.2.2 - 2026-09-26

- Add the light JsonlView product icon to the packaged extension so the
  extension identity remains recognizable in supported registries and editor
  surfaces.

## 0.2.1 - 2026-09-25

- Preserve the existing Open VSX update identity as
  `Sumi-Sophia.jsonl-view` and publish the Visual Studio Marketplace build as
  `Sumi-Sophia.jsonlview-data-studio`, because `jsonl-view` is already owned by
  an unrelated Marketplace publisher.
- Generate both VSIX files from one frozen source, native addon, and production
  bundle. The release gate now proves that all non-identity archive entries are
  byte-for-byte equal and binds each artifact to its declared registry target.
- Keep `jsonlView.*` commands, settings, and custom-editor identifiers stable.
  The two registry builds are alternatives and must not be installed together.
- Record candidate-only native comparisons as not applicable instead of
  reporting an unperformed committed-binary comparison as a failed comparison.
- Require release changes to reach `main` through a reviewed pull request, then
  verify required checks, the GitHub latest pointer, release assets, and each
  registry independently after publication.

## 0.2.0 - 2026-09-23

- Release JsonlView under the MIT License.
- Build npm and VSIX packages from the same frozen JavaScript, CSS, and native
  inputs. The release gate now inspects the exact `.tgz` and VSIX archives,
  checks both embedded identities, and rejects duplicate or unexpected paths.
- Keep sorted views on the nearest valid page after a rebuild shrinks the
  result set; incomplete scans no longer guess a replacement offset.
- Bound array probing, command formatting, diff projection, Claude content
  blocks, syntax highlighting, and Raw rendering before they create large DOM
  trees. Large Raw records now use navigable source chunks while Copy keeps the
  complete hydrated value.
- Bind the rebuilt native addon's SHA-256 to both distribution manifests and
  re-open the finished VSIX to hash the embedded binary before promotion.
- Render Codex `FileChange` unified diffs in a dedicated bounded view with
  numbered context, green additions, red removals, and Raw/Copy preservation;
  support both path-keyed change maps and array-shaped changes.
- Render Codex command arrays as wrapped Shell/PowerShell code and format
  common one-line Code Mode JavaScript objects/statements for display while
  preserving the original command/input for Copy and Raw.
- Add an explicit, separately bounded full-record hydration action for oversized
  details; list hydration remains conservative and never becomes unbounded.
- Refresh React, virtual-list, icon, type, and napi-rs dependencies to current
  compatible releases; keep major-version migrations as separately validated
  work.
- Add a V8 coverage command and CI thresholds focused on product source files.
- Harden scheduled dependency freshness checks with compact registry requests,
  bounded retries, and visible degraded failures.
- Document the marketplace/private-gallery update boundary and reject an
  activation-time self-updater that would bypass editor trust semantics.
- Preserve the active physical page across manual rebuilds, including source
  invalidation, cancellation, shrinking files, and late generation messages;
  keep unfinished page drafts separate from submitted requests.
- Add a plan-only promotion coordinator that joins candidate provenance and
  leaves local VS Code, GitHub, npm, Open VSX, and Marketplace as independent
  authorization/readback lanes.
- Recognize Claude Code job timelines (`at/state/detail/text`) as lifecycle
  events, preserving timestamps and state evidence instead of rendering rows as
  `other`.
- Recognize the observed Claude command-history surface with normalized
  timestamps and explicit project/session evidence; keep the profile id stable
  while versioning its projection contract.
- Render Claude assistant and job-timeline text through the bounded Markdown
  container while keeping user prompts, tool output, and ordinary logs in their
  safer Auto/Text paths.
- Add pull-request CI, weekly dependency freshness reports, Dependabot upkeep,
  and an external benchmark trend report with comparable-workload baselines.
- Keep native benchmark probes on the shared ABI contract, record benchmark
  provenance, and run the packaged native smoke on Windows CI independently of
  the registry-backed freshness report.
- Harden pnpm-facing maintenance and promotion CLIs so one forwarded `--`
  separator is accepted while a second separator remains an explicit error.
- Bound sorted query candidates to lightweight index references, rehydrate only
  the visible window, and preserve a logical continuation when page hydration
  reaches its cap; sparse bounded scans no longer advertise a phantom next page.
- Mark filtered results as partial when a record cannot be inspected under the
  record hydration/parser boundary instead of silently treating it as a miss.
- Keep the additive scan-reason value backward-tolerant in the Webview, so a
  stale client shows a generic scan-limit label instead of rendering a blank
  status.
- Route structured tool output through JSON-aware containers, unwrap bounded
  double-serialized documents, and offer conservative Shell/PowerShell/Rust/
  Python/JavaScript code highlighting without changing the copied source.
- Keep the first structured output preview small, while `Show full` can render
  an ordinary object/array up to a separate finite expansion budget; larger
  values remain explicitly Raw-only instead of silently losing content.
- Align the extension engine and VS Code type baseline to the portable VS Code
  1.136 runtime so candidate VSIX packaging validates the actual acceptance host.

## 0.1.6

- Added reviewed product screenshots for the table, tree, schema, and Insights
  views.
- Moved synthetic fixtures and acceptance reports to the companion
  `JsonlView-harness` workspace.
- Added third-party license notices for bundled runtime dependencies.

## 0.1.5

- Removed a private benchmark-sized value from a public test fixture.

## 0.1.4

- Set the VS Code Marketplace and Open VSX publisher identity to
  `Sumi-Sophia`; the generated npm package remains `@sumi-labs/jsonl-view`.

## 0.1.3

- Removed private corpus size and performance metadata from the public
  acceleration roadmap; public claims now point to reproducible synthetic
  benchmark inputs.

## 0.1.2

- Corrected the generated npm package scope to `@sumi-labs/jsonl-view`.

## 0.1.1

- Separated the valid unscoped VS Code extension manifest from the generated
  scoped npm package metadata.
- Added reproducible native release path remapping to keep builder directories
  out of the distributed addon.

## 0.1.0

- Added bounded JSONL byte indexing, lazy hydration, malformed-record retention,
  schema discovery, predicates, pagination, cancellation, and refresh detection.
- Added Codex rollout, Claude Code, generic Agent event, OpenTelemetry,
  software-engineering trajectory, traditional structured-log, and generic
  JSONL profiles.
- Added a virtualized VS Code Webview with table, timeline, schema, problems, and
  detail views, plus source follow and index rebuild workflows.
- Added stable tail-follow handoff: the prior page remains rendered while a
  verified append generation loads, then the new tail replaces it atomically.
- Added opt-in bounded Insights with category and time-bucket charts, filtering,
  cancellation, physical record/byte/time scan budgets, separate examined and
  matched counts, and overflow/truncation reporting.
- Added a resizable record detail pane, collapsible bounded JSON tree, safe JSON
  syntax highlighting, and Pretty/Source switching.
- Pretty and Derived JSON now use a line-numbered, syntax-highlighted fold view;
  Source remains the exact single-line record for provenance checks.
- Added domain event kinds for logs, spans, tasks, actions, observations,
  patches, tests, and results while keeping severity orthogonal.
- Added tolerant BOM recovery with an explicit `NON_STANDARD_BOM` warning.
- Added an experimental napi-rs/memchr newline scanner with ABI/output checks,
  adaptive calibration, and permanent Node fallback after native failure.
- Added bounded Agent content rendering with Auto/Text/Markdown/JSON modes,
  conservative fenced-code and embedded-JSON detection, safe Markdown blocks,
  explicit preview/rich-parsing truncation notices, semantic Codex
  `AgentMessage` Markdown defaults, per-code-block copy/Wrap controls, and
  bounded lexical highlighting for common agent-generated languages.
