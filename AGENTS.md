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
- src/profiles/ owns additive Agent semantics. Profiles preserve unknown
  records and expose evidence paths for derived fields.
- src/webview/ owns bounded UI state and rendering. It never receives or
  retains the complete source file.
- src/shared/ owns versioned contracts and typed transport messages.
- native/jsonl-core/ is an optional accelerator with a portable fallback.

The runtime has no required network listener, hosted control plane, source
mutation path, arbitrary command execution, or provider database write.

## Toolchain

- Use the fnm-selected Node version from .node-version and the pnpm version
  from package.json.
- The development toolchain requires Node >=22.12.0; the repository pins
  Node 24.15.0.
- Install with pnpm install --frozen-lockfile.
- Do not make CI or cloud jobs depend on a developer PATH or FNM_DIR.

## Mandatory Commands

Run these commands for a normal product change:

    pnpm check:agent-spec
    pnpm check:docs-index
    pnpm check:contract
    pnpm check:biome
    pnpm typecheck
    pnpm test
    pnpm build

The CI form of check:agent-spec receives --base <commit> --head <commit>.
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
- Do not silently drop blank, malformed, oversized, unknown, or uncorrelated
  records.
- Do not execute source content, arbitrary JavaScript, or concatenated SQL.
- Keep Webview CSP, nonce, resource roots, and message validation in force.
- Native failures degrade to the portable scanner and never make unchecked
  offsets or unbounded memory trusted.

## Architecture and Parallel Work

The Webview uses feature-first slices. The Extension Host uses
ports-and-adapters. Provider adapters are vertical slices over shared record,
presentation, and transport contracts. Avoid a global services bucket and
avoid premature package or workspace splitting until an independently
buildable boundary and consumer contract exist.

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
