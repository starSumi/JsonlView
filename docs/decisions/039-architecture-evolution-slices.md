# ADR-039: Architecture Evolution Slices

Status: proposed

## Pressure

JsonlView is a runtime-bounded modular monolith with a versioned extension
host/Webview protocol. The next refactor steps must reduce change coupling
without making a package split, a second export surface, or a large rewrite the
new source of risk.

## Direction

The proposed next stage uses three small, reversible practices:

1. **Barrel export isolation.** Keep compatibility barrels thin and explicit.
   A barrel may expose a stable public facade, but it must not become a second
   owner of parsing, lifecycle, or provider semantics. New symbols should be
   exported from the owning module first, with compatibility exports measured
   and retired only after consumers migrate.
2. **Test colocation.** Place focused tests beside a pure policy or bounded
   adapter when that improves discovery and ownership. Cross-runtime contract,
   integration, and installed-host tests remain in their existing suites. The
   move is incremental and does not duplicate a test merely to change its
   location.
3. **Staged vertical migration.** Move one user-visible slice at a time from
   contract to owner to presentation, keeping the existing facade and wire
   shape during migration. Each slice records its owner, characterization
   coverage, before/after measurements, and rollback point.

## Guardrails

- JSONL bytes remain the physical authority; indexes, catalog rows, and UI
  projections remain disposable.
- Extension Host lifecycle, cancellation, generation fencing, and IPC remain
  host-owned. The Webview remains a bounded projection and interaction layer.
- A slice must preserve malformed-input fallback, raw values, budgets, and
  stale-response rejection before the next slice starts.
- A package/workspace split, a new network service, or public release needs a
  separate decision and evidence; this proposal does not authorize any of
  those changes.

## Evidence and links

- [ADR-014: Large module boundary governance](014-large-module-boundary-governance.md)
  defines seam-first extraction and characterization requirements.
- [ADR-035: Runtime-bounded decomposition and toolchain ownership](035-architecture-decomposition-and-toolchain-ownership.md)
  records the current modular-monolith boundary and compatibility-barrel rule.
- [ADR-015: Curated release-note CI guard](015-changelog-ci-guard.md) and the
  focused suites provide the current change and validation gates.

## Revisit trigger

Revisit this proposal when a second runtime consumes a stable engine package,
when test ownership becomes ambiguous after a move, or when a staged slice
changes bundle size, request count, memory, or installed-host behavior beyond
its measured budget.

## Rollback

Revert one vertical slice at a time while retaining its characterization tests
and contract evidence. Keep the original facade until the migrated owner has
passed focused, typecheck, build, and relevant host validation.
