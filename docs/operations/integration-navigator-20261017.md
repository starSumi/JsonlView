# Navigator Integration Task Brief (2026-10-17)

## Goal

Integrate the shared navigator lifecycle contract, Host authorization bridge,
and Webview detail action on top of product revision f81d8b1. The integrated
path must preserve the existing direct session/file leaf open behavior while
making the navigator handoff observable and fail-closed.

## Scope and owners

- T01: shared lifecycle wire registry (1a356571), owner src/shared/protocol/.
- T02: Host navigator authorization/readback bridge (b327904), owner
  src/extension/ and navigator application boundary.
- T04: Webview detail action (724f400), owner src/webview/.
- This branch is the integration owner. It may resolve integration conflicts
  and add focused contract tests, but must not silently redesign a task lane.

## Invariants

1. enabled -> authorization -> open-or-guide remains explicit. Enabling the
   Navigator does not authorize a source; authorizing a source does not scan a
   disabled Navigator.
2. Only a Host readback-confirmed result can put the UI into authorized or
   opened state. A Webview handoff is not an authorization result.
3. An opened result carries both targetDocumentId and sourceId. The UI drops a
   result for another document or generation.
4. Cancel, deny, unavailable, stale, timeout, or Host failure produce no
   config mutation and no catalog scan. Existing direct session/file leaf
   activation still opens the JSONL document.
5. The source JSONL remains authoritative; catalog and authorization state are
   metadata projections only.

## Integration order

Cherry-pick T01, then T02, then T04. Resolve conflicts against the baseline
contracts and the current product AGENTS.md; preserve the task-lane behavior
unless a test demonstrates an incompatible contract.

## Validation

Run focused navigator/protocol/Webview tests first, then the repository gates:
pnpm check:agent-spec, pnpm check:docs-index, pnpm check:contract,
pnpm check:biome, pnpm typecheck, pnpm test, pnpm build, and
pnpm verify:execution-identity. The integration branch must also pass
git diff --check. Results are L1/L2 evidence only unless a real VS Code host
observation is separately recorded.

## Rollback and unknowns

Rollback is the parent baseline f81d8b1 by removing this integration branch;
do not reset shared worktrees. If T01/T02/T04 cannot satisfy the invariants
without changing their architecture, stop and report the incompatibility.
No installation, packaged artifact, or L3 host acceptance is implied by this
brief.
