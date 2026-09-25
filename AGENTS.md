# JsonlView Working Agreement

JsonlView is a read-only VS Code JSONL/NDJSON data studio with optional Agent
semantic profiles. The source JSONL file is always the authority; indexes,
queries, schema summaries, and timelines are disposable projections.

## Toolchain

- Use the Volta-pinned Node and pnpm versions from `package.json`.
- The development toolchain requires Node `>=22.12.0`; the repository pins
  Node `24.15.0` because Vitest 5 and `@types/node` 26 no longer support the
  older Node 20 baseline. Keep CI and local probes on that same major line.
- Install with `pnpm install --frozen-lockfile` after the lockfile exists.
- Start a change with `pnpm check:contract` when the repository contract or
  decision records may be affected.
- Validate with `pnpm typecheck`, `pnpm test`, and `pnpm build`.
- Package locally with `pnpm package:vsix`. Publishing requires separate user
  authorization.

## Promotion Synchronization

When a reviewed change is ready for distribution, synchronize the surfaces in
this order and record each readback separately:

1. Put the release change through a pull request and required checks. Protect
   `main` before merge, then freeze the reviewed merge commit, run the release
   preflight, and build the VSIX candidates outside this checkout.
2. Install the candidate with the actual portable VS Code `code.cmd`, verify
   the active extension id/version/path and bundle digest, then reload the
   affected window before calling the local plugin updated.
3. Prepare and inspect the npm candidate; publish only with an explicit
   `--registry=https://registry.npmjs.org --access public` authorization and
   read back the exact package/version.
4. Push the reviewed Git ref and create or update the GitHub release only after
   the remote and commit identities are verified; read back the published ref.
5. Treat Open VSX and Marketplace as independent targets with their own stable
   coordinates, authorization, artifact, and registry readback. Verify the two
   VSIX files differ only in their declared registry identity. Success on one
   surface never implies that another surface was updated.

For routine local updates, use `pnpm sync:local -- --target <open-vsx|marketplace>
--version <version> --install`. The command is intentionally local-only and
must report `reloadRequired` until the active VS Code window is reloaded. The
two target IDs share contribution identifiers and are not supported as a
co-install; uninstall or disable one before accepting the other. Do not replace
this flow with a file-watch hook that publishes a registry or pushes a remote.

The local VSIX identity override (`--publisher`/`--version` on
`package-vsix-candidate.mjs`) is for same-id acceptance installs only; it does
not make a private or unlicensed source checkout publishable. Never put tokens,
temporary credentials, or generated release artifacts in this repository.

## Change Contract

Before editing, classify the highest applicable change class:

| Class | Scope | Required gate |
| --- | --- | --- |
| C0 | Wording or isolated fixture | focused check |
| C1 | One-owner behavior | unit tests, negative case, rollback |
| C2 | Shared contract, lifecycle, format, or concurrency | ADR or update, integration and failure tests |
| C3 | Parser, native code, dependency, security, or performance boundary | official-source refresh, baseline benchmark, fault injection, audit |
| C4 | Release, migration, credentials, or irreversible external action | independent review, provenance, authorization, remote readback |

Every non-trivial task brief must state:

```text
goal / scope / owner / invariant / change class
current source identity / standards or ecosystem checks
accepted alternative / probe and expected metric
failure cases / validation level / known unknowns / rollback
```

Do not claim a library or framework is "best" from version recency alone.
When a change touches a language, runtime, dependency, public format, security
boundary, or performance claim, consult primary current sources and record the
compatibility and maintenance trade-off in `docs/decisions/`.

## Completion Levels

Report the highest level reached; do not collapse them into one `done` state:

- **L1:** compile, format, and focused tests pass.
- **L2:** contract, negative, cancellation, and failure cases pass.
- **L3:** real VS Code host, Webview, or integration behavior observed.
- **L4:** representative performance, compatibility, and resource evidence exists.
- **L5:** packaged artifact, provenance, authorization, and remote readback pass.

The companion `JsonlView-harness` owns synthetic fixtures, screenshots,
benchmarks, operational notes, and release evidence. Keep only intentionally
shipped documentation and approved assets in this product checkout.

## Architecture Boundaries

- `src/extension/` owns VS Code lifecycle, source generations, cancellation,
  message validation, and Webview delivery.
- `src/engine/` owns bounded reads, byte/record indexes, parsing, schema, and
  query execution. It never writes the source file.
- `src/profiles/` owns derived Agent semantics. Profiles must preserve unknown
  records and provide evidence paths for derived fields.
- `src/webview/` owns bounded UI state and rendering. It never receives or
  retains the complete source file.
- `src/shared/` owns versioned contracts. Changes require supervisor review.

## Parallel Work

Writable team lanes use separate Git worktrees and branches. Each worker edits
only its assigned subtree and tests. Workers are not alone in the repository;
they must preserve unrelated changes and must not reset, clean, or rewrite
another lane.

## Correctness

- Use absolute byte offsets. Serialize values that may exceed safe JavaScript
  integer precision as decimal strings across IPC.
- Treat filesystem notifications as invalidation hints and re-check source
  state before incremental work.
- Keep messages bounded and reject stale generations.
- Do not silently drop blank, malformed, oversized, unknown, or uncorrelated
  records.
- Do not execute source content, arbitrary JavaScript, or concatenated SQL.

## Decision Records

Accepted cross-cutting decisions live in `docs/decisions/`. Each record keeps
pressure, invariant, owner, alternatives, probe, decision, evidence, boundary,
revisit trigger, and rollback visible. Volatile machine facts and temporary
credentials belong in the sibling harness, not in an ADR or product source.

When an ADR becomes stale, supersede it explicitly; do not silently rewrite a
historical decision. Use `pnpm check:contract` to verify the required project
contract and ADR shape.
