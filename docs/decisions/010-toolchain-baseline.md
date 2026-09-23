# ADR-010: Development Toolchain Baseline

## Pressure

The project uses TypeScript, React, native napi-rs code, and Vitest in one
validation loop. The current Vitest 5 and `@types/node` 26 releases have a
higher Node floor than the older test baseline, so an unrecorded upgrade would
leave local and CI results dependent on whichever Node executable happens to be
first on `PATH`.

## Invariant

Dependency upgrades must be reproducible under the Volta pins and the frozen
lockfile. A test or typecheck result from an unsupported Node runtime is not
release evidence.

## Owner

The product checkout owns `package.json`, `pnpm-lock.yaml`, CI versions, and
this decision. The companion harness owns historical benchmark samples and
machine-specific runtime observations.

## Alternatives

- Keep Vitest 4 and Node 20 compatibility: rejected because it preserves the
  older validation stack without a current compatibility need.
- Upgrade only type definitions: rejected because coverage and test execution
  would remain on a separate major line.
- Pin Node 24.15.0 with a Node 22.12.0 floor: selected; it matches the tested
  toolchain while retaining a documented lower bound for contributors.

## Probe

In an isolated checkout, run frozen install, typecheck, all Vitest tests with
coverage, build, native checks/tests, and a production dependency audit under
Node 24.15.0. Repeat the same commands in the product checkout after the lock
file is updated.

## Decision

Use Vitest `5.0.0`, `@vitest/coverage-v8` `5.0.0`, and `@types/node` `26.5.1`.
Pin Node `24.15.0` and pnpm `10.26.0` in Volta and CI. Document Node `22.12.0`
as the minimum development runtime. Do not add a runtime engine claim for the
extension host; VS Code compatibility remains controlled by `engines.vscode`.

## Evidence

The isolated upgrade probe passed frozen install, 38 test files (311 passing,
one todo), coverage, build, Rust checks/tests, and `pnpm audit --prod` under
Node 24.15.0. The product checkout must retain the command output and exact
lockfile revision in its release evidence.

## Boundary

This baseline governs development and CI only. It does not promise that every
older Node version can build the project, and it does not change the Node
runtime supplied by VS Code for the packaged extension.

## Revisit Trigger

Revisit when the Volta major, TypeScript compiler, Vitest, or VS Code extension
host contract changes, or when a supported contributor environment requires a
lower Node floor. Re-run the isolated compatibility probe before changing it.

## Rollback

Restore the previous lockfile and test baseline in one reviewed change if a
reproducible incompatibility appears. Keep the failed probe and affected
runtime visible; do not silently downgrade only in CI.
