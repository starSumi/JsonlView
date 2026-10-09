# ADR-035: Runtime-Bounded Decomposition And Toolchain Ownership

Status: accepted

## Pressure

The product combines a VS Code Extension Host, a sandboxed Webview, a bounded
JSONL engine, provider profiles, a read-only Session Navigator, and an optional
napi-rs scanner. Several modules are large, but the current VSIX/NPM packaging
and two esbuild entrypoints are coherent. The host has moved from Volta to fnm.

## Invariant

- JSONL bytes remain the source authority; indexes and catalog rows are
  disposable projections.
- Extension Host lifecycle, generation fencing, cancellation, and IPC remain
  host-owned; Webview receives bounded projections only.
- Engine, provider adapters, and native scanner keep one owner each.
- The root package remains the VSIX/NPM composition root until an independent
  consumer, build graph, and release contract are proven.
- Node selection is owned by the project .node-version for fnm; pnpm remains
  owned by packageManager; CI selects Node explicitly and does not depend on
  a Windows PATH or FNM_DIR.

## Alternatives

- Immediate pnpm workspace/packages split: rejected for now. The extension and
  Webview share a versioned protocol and one release archive; a package split
  would add build, dependency, and provenance surfaces before a second
  consumer exists.
- Nix as the authoritative Windows toolchain: rejected. The native target,
  VSIX packaging, and installed-host acceptance require the Windows Node/Rust
  toolchain already exercised by CI. Nix may be reconsidered as an optional,
  non-authoritative analysis shell after a Windows parity probe.
- Repository-wide FSD or full Hexagonal rewrite: rejected. Use vertical slices
  in Webview and selective ports around Engine I/O; keep runtime boundaries
  explicit.
- Large-file threshold as an automatic split: rejected. A split requires a
  semantic seam, a named owner, characterization tests, and rollback.

## Decision

Use a runtime-bounded modular monolith with facade-preserving extraction:

1. Eliminate the Session Navigator provider/factory cycle by separating file
   scanning, provider factory dispatch, and provider implementations.
2. Extract pure Engine runtime/refresh guards, hydration/projection, row-query,
   and problem/detail services behind JsonlFileEngine.
3. Extract Integrated Session profile detection, insights, and recovery while
   keeping one engine replacement owner.
4. Split Webview presentation by bounded utilities and provider adapters, then
   move protocol/recovery hooks out of App.tsx without changing the wire
   contract.
5. Split Navigator refresh, authorization/intake, reveal, and tree rendering
   coordinators behind the existing TreeDataProvider facade.
6. Keep native/jsonl-core as one crate until a new capability creates a real
   pure-core/N-API seam; retain the JS ABI validation and fallback adapter.

Biome is introduced as a low-noise linter gate. It checks changed TypeScript,
TSX, and JavaScript files against the baseline; formatter and assist are
disabled until formatting ownership and a repository-wide migration budget are
approved. Existing violations are not mass-rewritten.

## Probe and validation

Every extraction must preserve the public facade and pass focused behavior,
typecheck, build, contract, and relevant failure/cancellation tests. Before
and after measurements must cover first-page latency, bounded memory, bundle
size, and native fallback where the slice touches those paths. A changed row
identity/offset, dropped raw value, stale response, budget overrun, or
packaging/provenance drift rejects the slice.

## Boundary and rollback

This ADR authorizes internal, reversible module extraction and toolchain
metadata migration. It does not authorize a public release, Nix adoption,
multi-package publication, source mutation, or a new network service. Revert
one slice or the toolchain metadata change independently; retain the baseline
tag baseline/pre-architecture-20261009 as the rollback point.

## Revisit trigger

Reconsider packages/workspaces when a second runtime or product consumes a
stable engine package, or when independent build/test/release ownership pays
for the added graph. Reconsider Nix only after native Windows parity,
developer onboarding, CI, and provenance evidence exist.
