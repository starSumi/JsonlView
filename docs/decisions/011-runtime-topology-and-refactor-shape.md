# ADR-011: Runtime Topology And Refactor Shape

Status: accepted

## Pressure

JsonlView combines a VS Code Extension Host, a sandboxed Webview, bounded
JSONL indexing and query execution, optional native acceleration, semantic
profiles, and a versioned message protocol. The codebase needs lower change
coupling without weakening source authority, generation checks, cancellation,
or native fallback.

## Invariant

Each mutable fact has one owner. The source snapshot and Engine own physical
truth; the Extension Host owns lifecycle and IPC delivery; the Webview owns
only a bounded rendering projection; profiles own semantic interpretation; the
native scanner owns no truth and must remain disposable. Cross-runtime messages
must remain versioned, generation-bound, bounded, and cancellable.

## Owner

`src/extension/` owns the host lifecycle and recovery boundary. `src/engine/`
owns file access, indexing, parsing, and bounded queries. `src/profiles/` owns
semantic detection and projection. `src/aggregation/` owns bounded summaries.
`src/webview/` owns rendering and local interaction state. `src/shared/` owns
the IPC and projection contracts.

## Alternatives

- Whole-repository Feature-Sliced Design: rejected. FSD is useful for a
  multi-page client UI, but it does not model the two runtimes, the file/engine
  authority, or the native failure domain. A global `shared` layer would also
  become an escape hatch.
- Whole-repository Vertical Slice Architecture: rejected. Use-case slices are
  useful inside the Webview, but applying them across Host, Engine, Profiles,
  and IPC would duplicate lifecycle and contract ownership.
- Full Hexagonal/Clean rewrite: rejected for now. The Engine has a real
  boundary opportunity, but wrapping every existing class in ports would add
  indirection before a measured portability or testability need exists.
- Supervisor-Worker and MCP runtime: rejected for the product runtime. Those
  patterns govern agent/tool orchestration, not the read-only JSONL viewer;
  they remain appropriate for the development workflow and future optional
  analysis tools.

## Probe

Use a staged refactor with the existing tests as the oracle:

1. Preserve the `src/shared/` protocol and existing Extension Host entrypoints.
2. Extract one Webview use case, `record-query` (query, filter, sort, paging,
   partial-result presentation), as a vertical slice without changing the
   wire contract.
3. Extract Engine ports only where a fake reader/scanner or a second runtime
   is a concrete requirement; keep the current Node adapter as the default.
4. Run contract checks, typecheck, unit/integration tests, build, and a real
   Webview/host smoke test before moving another slice.

## Decision

Adopt a **runtime-bounded modular monolith** as the repository architecture:

- Contract-First IPC is the hard boundary between Host and Webview.
- Hexagonal Ports/Adapters are selective and local to Engine I/O and optional
  accelerators.
- Vertical slices are allowed inside `src/webview/` for high-change user
  actions such as query, sorting/paging, profile selection, and follow/rebuild.
- Existing `extension`, `engine`, `profiles`, `aggregation`, and `shared`
  ownership boundaries remain the top-level modules.
- FSD is not a repository-wide rule. Only small FSD-like UI primitives may be
  used where they improve dependency direction inside Webview.
- Supervisor-Worker is the orchestration model for delegated engineering work;
  MCP is a future adapter for external tools, not a replacement for the
  product's current local engine or IPC.

## Evidence

The current source already implements the most important parts of this shape:

- `src/shared/types.ts` defines versioned `ProtocolEnvelope` messages with
  document and generation identity.
- `src/extension/` validates, routes, cancels, and rejects stale responses.
- `src/engine/` owns bounded file reads, segment indexing, hydration, and
  sorting; `src/engine/newline-scanner.ts` contains the native adapter and
  portable fallback.
- `src/webview/state.ts` and `src/webview/protocol-client.ts` keep a bounded
  projection and reject stale or unrelated messages.
- `docs/decisions/002-generations-and-follow.md`,
  `003-native-acceleration.md`, and `004-webview-rendering.md` already encode
  the source-authority, fallback, and rendering boundaries.

The architecture source notes were used as pattern evidence, not as proof of
current implementation. Their claims about ownership, rate-of-change
separation, failure blast radius, vertical slices, selective ports, and
contract-first IPC agree with the current source where the evidence above is
present. Agent Supervisor-Worker and MCP remain workflow/adapter patterns, not
implemented product capabilities.

Phase 2 has now started with a reversible Webview-only `record-query` slice:
`src/webview/features/record-query/` owns the pure GET_ROWS request model,
sorting-window guards, the controlled search/filter controls, record table,
partial-result banner, and pager. `App.tsx` still owns generation,
cancellation, rebuild/viewport recovery, and the `WorkspaceState` projection.
The shared IPC union and Host route were not changed. This is an
implementation checkpoint, not permission to move lifecycle code into the
feature.

The phase began in a deliberately preserved dirty worktree: `src/shared/`,
`src/extension/`, and `src/engine/` already contained unrelated changes. The
Phase 2 patch scope excluded those paths, and the source call chain still shows
the existing protocol and lifecycle owners. Because there was no clean
checkpoint at phase start, this is scope and source evidence rather than a
Git-diff proof of historical authorship. Establish a clean checkpoint before
any Engine Ports phase or further shared-contract change.

## Boundary

This ADR does not authorize a mass move of files, a new state store, a local
database, CRDTs, a durable external-sort service, or an MCP server. It does not
make the Webview authoritative, and it does not turn profile suggestions into
stable producer schemas. Full field sorting, native portability, and profile
coverage remain separate decisions.

## Revisit Trigger

Revisit when a second client runtime must reuse Engine logic, when a measured
test seam is blocked by direct file I/O, when Webview use cases are being
changed by independent teams, or when a real tool/analysis integration needs a
stable MCP boundary. Revisit the selected VSA slices if duplication exceeds
the cost of the shared UI/core boundary.

## Rollback

Each slice must be migrated behind the unchanged public protocol and removed
independently. Revert the slice-local adapter and restore the previous import
path; no source data, snapshot identity, or persisted user state may depend on
the new directory layout.
