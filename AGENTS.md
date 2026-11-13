# JsonlView Working Agreement

## Scope and Ownership

JsonlView is a read-only VS Code JSONL/NDJSON data studio with optional Agent
semantic profiles. This file governs the product checkout: source code, tests,
build scripts, CI workflows, public documentation, and decision records.

The product owns runtime behavior, source contracts, package manifests, and
reproducible build commands. An external validation workspace owns synthetic
fixtures, screenshots awaiting review, benchmark runs, host acceptance
receipts, and release readbacks. Those are evidence inputs, never product
runtime dependencies. Do not add state/, showcase/, private transcripts,
machine paths, credentials, or generated release candidates to this checkout.

The source JSONL file is always the authority; indexes, queries, schema
summaries, timelines, and session catalog rows are disposable projections.

## Runtime Model

- src/extension/ owns VS Code lifecycle, commands, source generations,
  cancellation, request handling, path/trust authorization, and delivery to the
  Webview. Pure message-shape and format guards belong to shared/contracts/.
- src/extension/acp/ owns ACP sessions, profiles, progress, and operation
  lifetime; raw-export/ owns source export and recovery transactions;
  reveal-text/ owns registered read-only text providers; trajectory/ owns
  bounded trajectory lookup; and mcp/ owns the extension sidecar protocol.
  integrated-session/ owns document session coordination and its profile
  policy; follow/ owns follow policy and recovery; observability/ owns host
  logging, telemetry projection, and lifecycle/error evidence; diagnostics/
  owns bounded host diagnostic envelopes and optional side-agent dispatch.
  These are private domain folders, not separate packages. Keep
  extension.ts and src/mcp-server.ts as composition roots, shared contracts in
  src/shared/, and generic process lifecycle in packages/runtime/. Add folders
  for cohesive multi-module owners, not isolated helpers.
  Keep directly owned feature tests in the matching test/extension/<owner>/
  folder; leave cross-feature integration tests in test/extension/.
- packages/mcp-server/src/ owns the canonical MCP JSON-RPC/stdio/configuration
  and wire-contract implementation shared by the private CLI/library and the
  extension sidecar. Keep product source authorization/query adapters in the
  extension and standalone explicit-file grants in the package runtime.
- src/application/ owns bounded use cases and ports. It must not import VS
  Code APIs, Webview code, or provider-private storage.
- src/engine/ owns bounded reads, byte/record indexes, parsing, schema, and
  query execution. It never writes the source file.
- src/profiles/ owns additive Agent and dataset semantics. Profiles preserve
  unknown records and expose evidence paths for derived fields; bounded dataset
  adapters keep JSONL physical rows and raw values authoritative. Keep producer
  schema recognition separate from bounded semantic projection within this
  owner, and preserve unknown or malformed records for generic inspection.
- src/webview/ owns bounded UI state and rendering. It never receives or
  retains the complete source file.
- src/shared/contracts/ owns serializable contract shapes and stateless format
  guards, organized by identity, envelope, record, query, navigation, intake,
  and errors. Keep src/shared/types.ts as a compatibility re-export barrel.
  src/shared/transport/ owns envelope creation/stamping, request-ID
  correlation, and CancellationRegistry lifetime only; it must not become a
  second owner of contract shapes or authorization policy. The extension owns
  filesystem path sandboxing and workspace-trust authorization. Direction
  mappings fail closed for unknown message types and remain exhaustive when a
  request or host message variant is added.
  Cancellation cleanup requires both the request ID and the exact acquired
  AbortSignal. A handler without a registration, or a late handler whose ID
  has been reused, cannot retire another operation's cancellation owner.
  Acquire the registration before invalidating projections, recording a first
  request or observation, or advancing a rebuild sequence; rejected duplicate
  IDs must not change another operation's lifecycle state.
- Conversation and dataset scene projections are optional bounded row data,
  never a second query or source identity. Preserve physical records, reading
  anchors and exact selected-record details across display modes. Dataset
  aggregates state sample scope and inspection limits; declared token counts
  and observed array lengths remain separate. Row projection capability is
  orthogonal to physical query identity; view changes reuse the existing query
  controller and preserve viewport state. Legacy callers retain default scene
  projections, while metadata-only inspection skips display-row materialization.
  See ADR-048.
- native/jsonl-core/ is an optional accelerator with a portable fallback.

The runtime has no required network listener, hosted control plane, source
mutation path, arbitrary command execution, or provider database write. An
explicitly launched dist/mcp-server.cjs stdio process is an opt-in read-only
adapter; it requires an allowlisted source environment and is never started by
activation. ACP is similarly explicit and provider-neutral.
ACP v1 session MCP stdio entries use typed environment-variable arrays. Supported
authentication methods are advertisements, not a login requirement. Agent RPCs
receive protocol replies; tool permissions use a native once-only picker and
default to cancellation on dismissal, cancellation or close. Never infer or
persist an authorization, and never select an option the agent did not offer.
Validate an ACP response envelope and bounded error before removing its pending
request or timer; malformed replies reject all outstanding work and close the
owned process without throwing from the transport listener.
ACP UTF-8 pipes preserve characters across chunk boundaries; outbound lines
respect the same 1 MiB cap, and updates belong to the active session only.
Explicit ACP diagnostics show native cancellable stage progress and elapsed
time, with a status-bar entry while notifications are hidden. Retire superseded
progress and suppress its late result. Log only fixed stages, allowed error
metadata, timeout limits and numeric RPC codes; keep stderr and RPC error
bodies out of Output. A prompt timeout means submission may already have taken
effect and must never trigger automatic resending. See ADR-079.
MCP stdio EOF or output failure stops admission, cancels owned reads and
suppresses late publication. Oversized input stays discarded until its newline.
Activation conflicts may publish a metadata-only diagnostic through the
optional `jsonlView.sideAgent.receiveDiagnostic` command only after an
explicit user action. The dispatch is provider-neutral and may include a
Rust-generated MCP request plan. Delivery failure falls back to a bounded
clipboard path, and never changes activation safety or includes source data.

## Toolchain

- Use the fnm-selected Node version from .node-version and the pnpm version
  from package.json.
- The development toolchain requires Node >=22.12.0; the repository pins
  Node 24.15.0.
- Install with pnpm install --frozen-lockfile.
- Dependency maintenance keeps the Biome schema aligned with its pinned CLI,
  pairs CodeQL init/analyze revisions, and reviews locked Rust license notices
  before promotion. A dependency-only PR still updates this build contract.
- Root and runtime tests use Vitest 5.0.3 with its matching coverage provider;
  root Vite is pinned to 8.2.4 for the supported test-toolchain peer boundary.
- Do not make CI or cloud jobs depend on a developer PATH or FNM_DIR.
- The Vitest suite uses two isolated thread workers to bound process-startup
  and temporary-I/O contention. Keep default test timeouts, file isolation,
  and the complete test set; native addon compatibility remains part of the
  full suite. This follows Vitest's performance guidance for thread pools.
- TypeScript source imports use explicit owner aliases declared in
  \`tsconfig.json\` (\`@shared/*\`, \`@application/*\`, \`@engine/*\`, \`@profiles/*\`,
  \`@webview/*\`, \`@features/*\`, \`@widgets/*\`, and workspace \`@runtime/*\`,
  plus the remaining top-level owners). Vitest derives its absolute aliases
  from that map and esbuild pins
  the same \`tsconfig.json\` with the product root as its working directory.
  Same-directory imports stay relative; public Webview facades remain the
  checker-visible entry points, and aliases never change runtime package
  exports.

## Mandatory Commands

Run these commands for a normal product change:

    pnpm check:agent-spec
    pnpm check:docs-index
    pnpm check:contract
    pnpm review:modules
    pnpm check:typescript-erasable
    pnpm check:typescript-gates
    pnpm check:typescript-tests
    pnpm check:biome
    pnpm typecheck
    pnpm test
    pnpm build
    pnpm verify:execution-identity

The CI form of check:agent-spec (the agent-spec-lint guard) receives --base
<commit> --head <commit>.
It fails when a core source or build contract changes without a corresponding
update to this file. Add or remove a mandatory command only by updating this
section and the checker in the same change.

Use narrower gates when appropriate:

- pnpm exec vitest run <test-file> -t <test-name> for a focused behavior
  change; do not pass an extra `--` through the pnpm script runner.
- pnpm native:check, pnpm native:fmt, pnpm native:clippy, and pnpm native:test
  for native changes.
- The optional real-DOM RecordTable smoke requires an explicit Chromium
  executable and an output directory outside this checkout:
  `node test/webview/record-table.dom-smoke.mjs <chromium-executable> <external-output-directory>`.
- pnpm check:changelog -- --base <commit> when implementation files change.
- pnpm package:vsix:candidate and pnpm package:npm only for an explicitly
  authorized release candidate; keep their outputs outside this checkout.
- A package version change is a release-contract change: update CHANGELOG.md,
  rerun the full mandatory commands, and bind every candidate artifact to the
  clean revision before any registry promotion.

## Change Contract

Before editing, classify the highest applicable change class:

| Class | Scope | Required gate |
| --- | --- | --- |
| C0 | Wording or product-local test fixture | focused check |
| C1 | One-owner behavior | unit tests, negative case, rollback |
| C2 | Shared contract, lifecycle, format, or concurrency | ADR or update, integration and failure tests |
| C3 | Parser, native code, dependency, security, or performance boundary | current primary-source check, baseline benchmark, fault injection, audit |
| C4 | Release, migration, credentials, or irreversible external action | independent review, provenance, authorization, remote readback |

Every non-trivial task brief states:

    goal / scope / owner / invariant / change class
    current source identity / standards or ecosystem checks
    accepted alternative / probe and expected metric
    failure cases / validation level / known unknowns / rollback

Do not call a library or framework best from version recency alone. For a
language, runtime, dependency, public format, security boundary, or
performance claim, consult a current primary source and record compatibility,
maintenance, and rollback trade-offs in docs/decisions/.

## Correctness and Security

- Use absolute byte offsets. Serialize values that may exceed safe JavaScript
  integer precision as decimal strings across IPC.
- Treat filesystem notifications as invalidation hints and re-check source
  state before incremental work.
- Keep messages bounded and reject stale generations.
- Internal Navigator reveal uses a correlated single in-flight request and an
  exact document/generation/epoch acknowledgement after DOM visibility checks.
  Keep source/authorization rechecks, cancellation and watchdogs; message delivery
  alone is never `shown`. No external reveal bridge is enabled. See ADR-067.
- Native record text uses the existing detail action, a host-resolved source,
  strict generation and index coordinate checks, and an opaque read-only URI.
  Refuse partial/invalid UTF-8 text, cap each record at 1 MiB and cumulative
  output at 4 MiB, and release references on close or failed opens. Source
  observations must not start whole-file fingerprint work. The text read also
  compares bounded original prefix/tail fingerprints before and after content;
  this does not prove unchanged unobserved middle bytes. See ADR-068.
- Whole-source raw export is an explicit open-document operation, independent
  of query filters and sort. Preserve exact bytes, the 1 GiB budget, source
  identity/authorization checks, cancellation before publication and same-directory
  hard-link no-replace commit. Never remove an unverified destination. See ADR-069.
- Scoped raw export copies complete physical records, including each separate
  delimiter; RecordRef.byteEndExclusive is the content end. Only successfully
  delivered current GET_ROWS/GET_DETAIL results authorize native query/selection
  scopes. Freeze the picker intent and keep output in physical ascending order.
  Persist the immutable Host operation ID, selection digest and source observation
  before scanning, and flush prepared inode/digest evidence before no-replace
  publication. Inspect uncertain operations before any explicit retry; a committed
  receipt prevents recreating an output subsequently removed by its owner.
  Restart recovery uses a fresh current document grant plus the original URI,
  profile revision and exact device/inode/size/mtimeNs/ctimeNs observation; random
  session IDs cannot be reused as durable identity. Retain pending/corrupt journals
  and never evict them to admit new work. See ADR-072.
- Generic dataset previews use fields from the selected physical record. An
  ordinary nested payload must not replace its top-level fields; recognized
  event and tool envelopes retain their profile semantics.
- ShareGPT, VirtualHome, and the pinned `sft-master` conversation/keyword-result
  families are bounded JSONL semantic adapters. They preserve the physical row
  and Raw value; top-level JSON arrays remain an explicit unsupported-framing
  fallback until a structural JSON format adapter exists.
- Display columns are independent of query predicates. Visibility changes stay
  local when the current row projection covers every required column; missing
  fields and projection overflow still require a bounded page refresh.
- Resolve inferred columns after bounded page hydration in either physical row
  order, including the first request on a fresh engine. Preserve explicit empty
  columns, profile defaults, and table-column limits.
- Accepted GET_ROWS operations may emit one local metadata start and one
  settlement event when the existing handler settles. Keep operation outcome
  separate from ROWS delivery, preserve cancellation and identity gates, and
  contain observer failures. Host counters are local correlators, not OTel
  trace context; src/extension/observability/error-metadata.ts owns fixed error classification.
- Optional dataset detection settles with bounded terminal metadata for failure,
  deadline, cancellation, or disabled detection. It must not block Generic
  loading indefinitely or publish into a retired source/profile generation.
  Lifecycle failure logs accept fixed stages and allowed error metadata; raw
  exception messages and source content are excluded from Output and console.
- Collections is a separate user-owned metadata domain in the upper native
  TreeView (compatibility ID jsonlView.sourceDrop). CRUD, archive and explicit
  membership change only the owned metadata database and never mutate Catalog
  rows or source bytes, authorize sources or start scans. By default, archive
  metadata does not filter Agent Sessions. The opt-in
  `jsonlView.sessionNavigator.hideArchivedCollectionSessions` setting hides
  currently linked archived session identities from that projection; collection
  changes refresh the projection without rescanning sources, and unavailable
  metadata leaves sessions visible.
  Native Add Source and OS/Explorer URI drops remain independent intake actions;
  they never silently file a reference. Upper refresh/visibility stays independent
  of lower scan/poll ownership. Resolve reference labels from the current authorized
  catalog, redact unavailable sources and reuse the existing safe reveal chain.
  Empty collections and collection actions offer Add Existing Reference through
  that catalog and the shared metadata journal. The Collections native view has
  no intake drop controller or Add Source title action; the editor-area Import
  canvas and lower Agent Sessions retain those independent entrypoints. See ADR-086.
  An opened temporary preview settles the Import operation before any native
  Save As choice. Notifications do not block later imports or promise persistent
  history; Recent Previews is session-only recovery. Late choices after intake
  cancellation do not start a save. Collection filing remains explicit.
  Persist each accepted collection command with its original UUID, revision and
  payload in the shared SQLite pending table before applying it. Acceptance,
  effect/receipt and exact UUID/hash cleanup use separate immediate transactions;
  once a receipt returns, cleanup failure must retain that successful outcome,
  leave any pending record for recovery and never prompt a new mutation retry.
  Legacy Memento is only a read-only import source and must never be updated.
  Recover pending commands before new mutations; retain
  conflicting/corrupt pending state and refuse implicit rebasing or database reset.
  Migration DDL must pass the same owned-schema check after close and reopen.
  Entry aliases and session-local archive intent follow the durable anchor across
  links and explicit rebinds, including after the last unlink. Redact aliases
  whenever current source authorization is unavailable. Local archive never
  asserts provider state; lower Sessions changes only through the opt-in
  archive projection above. Rebind requires explicit
  target confirmation, current authorized identity and transactional CAS; refuse
  identity collisions without merging. Registered exact-file references use
  @file and the existing source-open gate. Schema v4 retains verified legacy
  backups, v3 attributes, legacy session ID acceptance and all receipt hashes/JSON.
  Conflicts remain readable; each host pauses new writes when its shared recovery
  check observes a conflict. The check is not a global acceptance barrier. Refresh
  retries without guaranteeing reconciliation. No new source intake or source-file writes
  follow from entry metadata. See ADR-073 and ADR-074.
  See ADR-064 and docs/designs/navigator-collections.md.
- Record Lineage defaults to a pure Webview projection over the accepted
  filtered/sorted result page, capped at 500 rows with zero automatic source
  reads or IPC. ADR-078 adds explicit one-flight lookup over one physical window:
  at most 500 records, 1 MiB of precharged content-read requests (including index
  work), and a 1.5 s cooperative deadline on the background FIFO. Only exact
  references issued by the currently delivered page or its published lookup
  results may start lookup; the Host derives the target from profile evidence.
  No client path, identifier needle or byte offset is accepted. Incomplete,
  ambiguous, cancelled, stale and unavailable work cannot issue a match.
  Lookup uniqueness and non-observation apply only to the checked window.
  Invalidate on page/source/profile changes; suppress superseded results.
  The rail may fold verified unbranched metadata into inspectable badges;
  the selected record stays visible. OTLP logs attach by explicit span context,
  never as causal parents. The former Graph workspace tab has
  no shipped Webview caller. The internal Graph Host protocol remains bounded
  by ADR-070/071 and must preserve its existing safeguards if reused.
- GET_GRAPH uses the background FIFO for physical records 0–99, independent of
  table filters, with 100-record/4-MiB/deadline budgets. Its observed-row port
  checks cancellation/deadline at dispatch and before each content read, rejects
  changed path/handle metadata using stat-only checks, and caps the sum of read
  request lengths across indexing, ref reconstruction and hydration at 4 MiB.
  Precharge each read and shorten its length before I/O; failed or short reads
  do not refund the allowance. Budget exhaustion is unavailable, never complete
  empty coverage. Preserve ordinary query snapshot checks and non-preemptive
  active I/O. Only exact provider
  evidence with unique same-context targets creates observed relations; no
  guessed or inferred edges. Host-issued exact current refs and graph request
  receipts gate reveal, and source/profile authorization is rechecked before
  publication and the existing rendered-row acknowledgement. Superseded reveal
  checks cannot invalidate a newer Graph publication. Source-unavailable
  states clear source content. A changed source during a queued Graph read is
  stale; budget or read failures stay unavailable and cannot issue references.
  The canvas owns overflow and the left rail owns
  discoverable actions. Cross-source edges require
  a separately supplied Host authorization context, current grants for all
  involved sources, and verified evidence bound to the owner source, generation,
  physical RecordRef and field paths. Input cannot grant permission. Projection
  kinds are bounded enums with a separate rawKind text value; metadata without
  a current Host RecordRef cannot reveal a physical record. Layout publication
  compares graph/snapshot/source/profile identity as well as request and viewport.
  See ADR-070/071/075; page-model or render-contract tests do not constitute
  installed Lineage UI acceptance.
- Session polling runs only while the lower Sessions TreeView is visible, the
  VS Code window is focused, Navigator is enabled and an authorized source exists.
  Keep the native Sessions view title and description neutral; automatic
  dormancy is not a user-controlled pause. Abort probes on loss of eligibility
  and discard late results. Upper Collections visibility cannot start lower
  polling, and overlapping timer ticks share one active probe.
- Optional profile probes and each Insights scan slice use the engine's
  background FIFO; queued interaction wins at the next operation boundary.
  Keep Insights slices bounded by examined records, preserve global budgets
  and unknown-record coverage, and publish head detection once per unchanged
  generation before the index-complete tail pass. An active read is not
  preempted. Local read diagnostics are bounded metadata, never OS-cause proof
  or Webview payload. See ADR-065.
- Session Navigator catalog children use bounded query pages and explicit tree
  continuation branches, separate from provider scan continuations. Bind each
  branch to its source, generation, parent, sort, and lifecycle epoch; discard
  late reads after invalidation and keep title cursor comparison in SQLite's
  selected collation.
- Collections title Import sits before New Collection and opens one centered
  editor-area intake WebviewPanel; no Add Source Webview View occupies the
  sidebar. The panel exposes Choose files, Choose folder and Paste JSONL, plus a
  wide external-file drop target. Opening it does not discover or scan. File and
  folder selection retain the existing explicit source-authorization flow;
  dropped and pasted JSONL remain bounded temporary previews. Closing the panel
  cancels its pending picker and suppresses late completion. See ADR-086.
- Pasted previews have a session-owned metadata-only index, a 20-preview cap,
  and temporary/saving/saved-copy states. Closing a tab preserves recovery in
  Recent Previews for this session; no restart recovery is promised. Save As
  copies exact UTF-8 bytes to a new local file with exclusive creation, never
  moves the temporary source, and never cleans the saved destination. Cleanup
  drains writes and removes only identity-unchanged owned temporary files.
  After the saved copy's open attempt settles, one optional native prompt owns
  Add as source, Add to Collection and Dismiss. Collection filing requires an
  explicit exact-file permission confirmation. Newly registered saved files
  remain metadata-only during automatic refresh and polling in this host session
  until an explicit Refresh/Add Source action or extension restart. If explicit
  Refresh admits a saved source during an active scan, queue one following
  pass; its waiters settle after that pass, subject to visibility, focus,
  enablement and disposal gates. Report
  retained source permission and possibly pending metadata separately from the
  already verified save; follow-up failure cannot undo it. See ADR-087.
  Native Navigator enablement is remembered separately from source permission;
  cancelling or opening Settings while disabled must not scan or create a catalog.
  Scan only explicitly configured sources; detected homes are candidates until
  separately authorized, and authorizing a source does not enable the Navigator.
  Gemini, OpenCode and AgentsView are explicit generic read-only source choices
  selected through environment roots or Add Source; never recursively scan a
  user's home directory for them.
- Insights results commit only against the current AnalysisIntent v1, including
  normalized query conditions, scope, monotonic intent revision, source identity,
  and the selected profile revision. Display columns remain independent.
- Insights first paint is independent of dataset row projection hydration: render
  the aggregate toolbar and its loading/empty/error state as soon as the current
  query is readable; dataset-specific cards may hydrate or fail in a separate
  bounded status region and must not block the aggregate view.
- Do not silently drop blank, malformed, oversized, unknown, or uncorrelated
  records.
- Do not execute source content, arbitrary JavaScript, or concatenated SQL.
- Side-agent diagnostics are fixed-schema host events only; never invoke a
  command derived from diagnostic data or forward notification/source bodies.
- Keep Webview CSP, nonce, resource roots, and message validation in force.
- Native failures degrade to the portable scanner and never make unchecked
  offsets or unbounded memory trusted.
- The optional CDP query observation tap is development-only and enabled only
  when JSONLVIEW_CDP_QUERY_TAP is exactly 1. It projects a fixed allowlist of
  GET_ROWS metadata into memory with bounded, non-blocking delivery; false,
  rejected, thrown, timed-out, or overflowing delivery closes the tap and
  invalidates the observation without affecting the query. It must not enter
  the Webview protocol or persist raw events. Host and Webview timings are
  separate clocks and require an isolated synthetic VS Code host before they
  can support a performance claim. The paired click/query metric is temporal
  co-occurrence only and does not prove causation. See ADR-055.

## Architecture and Parallel Work

## V2 Architecture Rule Entrypoints

The reviewed architecture inputs are translated into product-owned, evidence-
gated rules rather than loaded at runtime. Read these entrypoints before a
cross-plane change:

- [V2 architecture roadmap](docs/architecture-v2-roadmap.md): four-plane
  topology, delivery stages, hypotheses, and rollback boundaries.
- [Rust native engineering rules](docs/rust-engineering-rules.md): bounded
  `native/jsonl-core/` ownership, typed failures, offset invariants, and
  accelerator promotion gates.
- [Local MCP and audit plan](docs/mcp-local-plan.md): read-only MCP, audit/OTel
  separation, redaction, budgets, and staged mutation phases.
- [ADR-051 plane boundaries](docs/decisions/051-v2-plane-boundaries-and-engineering-gates.md):
  accepted source-authority and evidence rules for V2 evolution.
- [ADR-054 bounded forward-page read window](docs/decisions/054-bounded-forward-page-read-window.md):
  query-local read-ahead limits, eligibility, differential tests, and the
  outstanding representative-workload gate.

The Vault design notes are read-only research inputs. Do not add their paths,
raw bodies, screenshots, or private evidence to the product runtime or package.
Do not promote claims such as zero-copy, 120 FPS, Roaring indexes, PieceTree,
DuckDB, ONNX, or source mutation without the gates in these documents.

The Webview uses feature-first slices. The Extension Host uses
ports-and-adapters. Provider adapters are vertical slices over shared record,
presentation, and transport contracts. Avoid a global services bucket and
avoid premature package or workspace splitting until an independently
buildable boundary and consumer contract exist.

The Webview stylesheet entry is a fixed cascade contract: it imports the
tokens, base, layout, workspace-header, record-query, views, source-intake,
and accessibility modules in that order. CSS migrations move complete
top-level blocks and keep source-intake bridge status separate from the
  editor-area Import canvas's inline stylesheet.
Transient Insights states may add a separately ordered stylesheet module; keep
the existing views.css content immutable, register the import in this cascade,
and update the stylesheet architecture hash test with the module.

Within the Webview, keep App.tsx as the composition root, put record-query
policies in features/record-query, provider-specific event projections in
providers, and interaction lifecycles in focused hooks when they own cleanup
and keyboard/pointer behavior. Keep reducer orchestration and provider
arbitration at their current owners; extract pure policies without moving
transaction boundaries or adding a second store or speculative registry.
The neutral Play icon is the shared Query Studio dialog trigger. Opening or
closing it does not submit a query; search Enter and the Studio Run action
retain the existing query controller and focus-restoration behavior.
The Studio Run capsule uses the current rows pending state and the existing
query cancellation path. Pending Escape cancels; idle Escape closes. Guard
submissions with the protocol client's synchronous rows ownership as well as
rendered availability, and keep the native action button mounted across
Run/Cancel changes so pinned Studio focus remains stable. Keep the status live
region separate from the cancel button, respect reduced motion, and do not
invent scan progress or stronger Host cancellation guarantees.
Field-filter and column-chooser glyph changes preserve their existing native
disclosure, accessible names, field/type tree and selection behavior.
WorkspaceSurface extracts only the existing workspace body JSX and typed render
inputs. App retains reducer/state, IPC client/listener, query controller,
hydration/projection effects, viewport ownership and transaction callbacks.

The MCP navigation capability remains disabled by default, while the separate
Rust query adapter is available only through an explicit command or a client
launch of the packaged stdio server. Source IDs are resolved by the host and
all tool output is bounded. Staged mutation is similarly opt-in only after the
setting, workspace trust, source authorization, and explicit user gesture gates
are all satisfied.
The native `McpManager` remains dormant until that explicit diagnostic action;
it supports `2026-07-28` with `2025-11-25` and `2025-06-18` compatibility
fallbacks while leaving transport ownership to the host.

ACP integration supports explicit local ACP v1 stdio profiles. A single
legacy `jsonlView.acp.command` configuration maps to one profile; multiple
profiles require a native user selection for each explicit diagnostic send.
Every profile records its execution target separately from protocol and
transport. The ACP session manager uses the workspace runtime process factory;
only `local` is enabled until remote process context and lifecycle acceptance
are complete. The current manager is not ACP v2 compatible. MCP 2026-07-28 per-request
metadata and the SDK v1 legacy initialize handshake are independent compatibility
paths and require separate probes. Runtime targets and transports are separate:
local, WSL2 or SSH process placement does not change an ACP/MCP protocol, and
catalog metadata never activates executables or grants credentials. Plugin
entries stay pinned, disabled metadata and skills stay instruction content.
The optional bridge is only an authenticated private JSON-RPC tunnel; it must
not claim `/mcp`, ACP or MCP compatibility until their real lifecycle probes
pass. See ADR-080 and `docs/mcp-local-plan.md`.

ACP session close updates protocol state synchronously and returns a bounded
process-tree settlement promise. Callers replacing a session or deactivating
the extension must await settlement before declaring shutdown complete;
`outcome=unknown` remains explicit evidence rather than a successful cleanup
claim. Optional external side-agent dispatch is outside the shutdown wait, and
late completion cannot emit UI, clipboard, or Output effects.

The additive trajectory slice and spine adapter preserves the physical query
contract. Strict semantic predicates retain unknown actor/error values; source
handles and paths are rechecked before publication, and actual reads including
profile detection and cold continuation reconstruction consume one budget.
Cursors are locators, never grants. Modern stdio requests carry their own MCP
version metadata; legacy initialization stays separate. See ADR-066. An active
read remains non-preemptive, and a bounded warm locator cache does not promise
arbitrary cold continuation performance.

Writable team lanes use separate Git worktrees and branches. Workers edit only
their assigned subtree and tests. Workers are not alone in the repository;
they must preserve unrelated changes and must not reset, clean, or rewrite
another lane.

## Development, Runtime, and Evidence

Development commands, CI workflows, tests, and ADRs live in this product
checkout. Runtime code must not load reports, fixtures, screenshots, local
editor settings, or generated evidence. Evidence may be linked by immutable
revision or receipt identifier, but documentation must not copy machine-local
paths, private conversation bodies, credentials, or raw operational logs.

Product visual design is registered in `docs/designs/`. The accepted theme
baseline is `docs/designs/theme-adaptation.md`; `src/webview/` owns its runtime
implementation and focused interaction tests, while product maintainers own
the document lifecycle. Update the design in the same change when semantic
token roles, selection/focus behavior, scrollbar visibility, responsive
affordances, or host-theme ownership changes. Run `pnpm check:agent-spec` and
`pnpm check:docs-index` for documentation-only changes; implementation changes
also use the mandatory commands below. Design documents must remain free of
harness paths, private transcripts, credentials, and generated screenshots.
The harness may retain review variants as external evidence, but the product
must not load them at runtime.

## Completion Levels

Report the highest completion level reached:

- L1: compile, format, and focused tests pass.
- L2: contract, negative, cancellation, and failure cases pass.
- L3: real VS Code host, Webview, or integration behavior observed.
- L4: representative performance, compatibility, and resource evidence exists.
- L5: packaged artifact, provenance, authorization, and remote readback pass.

## Decision Records

Durable cross-cutting choices live in docs/decisions/. Each record keeps
pressure, invariant, owner, alternatives, probe, decision, evidence, boundary,
revisit trigger, and rollback visible. Volatile measurements and release
readbacks remain external evidence; the product records only the claim,
revision, boundary, and how to reproduce it.

When an ADR becomes stale, supersede it explicitly; do not silently rewrite a
historical decision. Use pnpm check:contract and pnpm check:agent-spec to
verify the project contract and instruction ownership.
