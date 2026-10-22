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
  cancellation, message validation, and delivery to the Webview.
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
- src/shared/ owns versioned contracts and typed transport messages.
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
- Do not make CI or cloud jobs depend on a developer PATH or FNM_DIR.
- The Vitest suite uses two isolated thread workers to bound process-startup
  and temporary-I/O contention. Keep default test timeouts, file isolation,
  and the complete test set; native addon compatibility remains part of the
  full suite. This follows Vitest's performance guidance for thread pools.

## Mandatory Commands

Run these commands for a normal product change:

    pnpm check:agent-spec
    pnpm check:docs-index
    pnpm check:contract
    pnpm check:typescript-gates
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

- pnpm test -- <pattern> for a focused behavior change.
- pnpm native:check, pnpm native:fmt, pnpm native:clippy, and pnpm native:test
  for native changes.
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
  trace context; src/extension/error-metadata.ts owns fixed error classification.
- Optional dataset detection settles with bounded terminal metadata for failure,
  deadline, cancellation, or disabled detection. It must not block Generic
  loading indefinitely or publish into a retired source/profile generation.
  Lifecycle failure logs accept fixed stages and allowed error metadata; raw
  exception messages and source content are excluded from Output and console.
- Session Navigator catalog children use bounded query pages and explicit tree
  continuation branches, separate from provider scan continuations. Bind each
  branch to its source, generation, parent, sort, and lifecycle epoch; discard
  late reads after invalidation and keep title cursor comparison in SQLite's
  selected collation.
- Pasted previews have a session-owned metadata-only index, a 20-preview cap,
  and temporary/saving/saved-copy states. Closing a tab preserves recovery in
  Recent Previews for this session; no restart recovery is promised. Save As
  copies exact UTF-8 bytes to a new local file with exclusive creation, never
  moves the temporary source, and never cleans the saved destination. Cleanup
  drains writes and removes only identity-unchanged owned temporary files.
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
standalone Add Source Webview's inline stylesheet.

Within the Webview, keep App.tsx as the composition root, put record-query
policies in features/record-query, provider-specific event projections in
providers, and interaction lifecycles in focused hooks when they own cleanup
and keyboard/pointer behavior. Keep reducer orchestration and provider
arbitration at their current owners; extract pure policies without moving
transaction boundaries or adding a second store or speculative registry.

The MCP navigation capability remains disabled by default, while the separate
Rust query adapter is available only through an explicit command or a client
launch of the packaged stdio server. Source IDs are resolved by the host and
all tool output is bounded. Staged mutation is similarly opt-in only after the
setting, workspace trust, source authorization, and explicit user gesture gates
are all satisfied.
The native `McpManager` remains dormant until that explicit diagnostic action;
it supports `2026-07-28` with `2025-11-25` and `2025-06-18` compatibility
fallbacks while leaving transport ownership to the host.

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
