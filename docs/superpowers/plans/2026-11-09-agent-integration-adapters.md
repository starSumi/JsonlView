---
id: "2026-11-09-agent-integration-adapters"
path: "docs/superpowers/plans/2026-11-09-agent-integration-adapters.md"
title: "Agent Integration Adapters Implementation Plan"
kind: "guide"
status: "accepted"
owner: "product"
tags: ["acp", "mcp", "plugins", "runtime"]
evidence: []
revisit: "after implementation gates or a compatibility boundary changes"
rollback: "revert the integration adapter change set and retain the prior local read-only path"
---
# Agent Integration Adapters Implementation Plan

> **For agentic workers:** Execute inline task-by-task with checkpoints. The
> primary agent owns integration and final verification.

**Goal:** Add a versioned adapter/catalog boundary for ACP, MCP, provider
plugins and execution targets; let users select among explicit ACP profiles;
make runtime targets and bridge claims testable and truthful.

**Architecture:** Keep protocol selection independent from process placement.
Static adapter metadata describes compatibility but does not execute code or
grant access. The Extension Host owns user selection and trust; the runtime
package owns argument-safe local/WSL/SSH process construction; existing MCP
server ownership and read-only source fences remain unchanged.

**Tech Stack:** TypeScript 7, Node.js 24.15.0, pnpm 10.26.0, Vitest 5,
`@modelcontextprotocol/sdk` 1.32.2 for a host-side interoperability probe.

**Spec:** `docs/decisions/080-agent-integration-adapters.md`

## Global Constraints

- Do not launch a process or listener during extension activation or catalog discovery.
- ACP v1 stdio is the supported client contract; do not label the current manager ACP v2 compatible.
- MCP 2026 stateless requests and MCP 2025 initialize-based SDK probes remain separate.
- Commands are invoked with argument arrays and `shell: false`.
- Existing MCP source allowlists, output caps, cancellation and read-only behavior remain in force.
- Plugin and skill manifests are metadata/content; discovery never executes or enables them.
- Preserve the legacy `jsonlView.acp.command`, `args`, and `timeoutMs` settings.
- Do not push any branch or change remote refs.

---

## File Structure

- Modify `packages/runtime/src/index.ts`: target union, pure launch builder,
  UTF-8-safe line decoder, and unsupported-target rejection.
- Modify `packages/runtime/test/runtime.test.ts`: target matrix, argument
  boundary and split-UTF-8 behavior.
- Create `packages/runtime/src/adapter-catalog.ts`: versioned provider-neutral
  descriptors and validation for protocol, transport, execution-target and
  pinned plugin metadata.
- Create `packages/runtime/test/adapter-catalog.test.ts`: descriptor schema,
  unsupported version and invalid combinations.
- Create `src/extension/acp/agent-profiles.ts`: validate ACP profile settings
  and adapt the existing single-command setting to one implicit profile.
- Create `src/extension/acp/agent-profile-picker.ts` and modify
  `src/extension/acp/session-manager.ts`: select trusted local profiles and
  use the shared runtime process factory for ACP child lifecycle.
- Modify `src/extension/extension.ts` and
  `test/extension/acp/diagnostic-routing.test.ts`:
  choose an explicit profile when multiple are configured, then use the
  existing trust, progress, cancellation and no-replay lifecycle.
- Modify `package.json`: expose profile configuration schema and add the SDK
  only as a development dependency for compatibility verification.
- Modify `apps/bridge/src/index.ts`; create `apps/bridge/test/bridge.test.mjs`:
  remove fake MCP success and verify unsupported route behavior.
- Create `scripts/mcp-client-smoke.mjs`: connect the official SDK v1 client to
  the built JsonlView stdio server and run initialize, list, bounded query, and
  close against a temporary synthetic JSONL source.
- Modify `package.json`, `docs/mcp-local-plan.md`, `AGENTS.md`,
  `docs/decisions/README.md`, and generated docs indexes as required by source
  contracts and documentation checks.

## Tasks

### Task 1: Add the versioned provider-neutral adapter catalog

**Files:** Create `packages/runtime/src/adapter-catalog.ts` and
`packages/runtime/test/adapter-catalog.test.ts`; modify `packages/runtime/src/index.ts`.

**Interface:** `validateAgentAdapterDescriptor(value: unknown): AgentAdapterDescriptor`
accepts only `jsonlview.agent-adapter.v1`; descriptor fields include `id`,
`protocol`, exact protocol version list, `transports`, `executionTargets`,
declared capabilities, and provenance. `validatePluginCatalogEntry` accepts
only immutable source metadata and always returns `enabled: false`. Neither
contract contains executable commands, environment values, secrets, or grants.

- [x] Test valid ACP stdio/local and MCP transport/target descriptors, including
  unsupported schema, version, transport, target, executable and secret fields.
- [x] Test pinned plugin metadata, mutable revision, duplicate identities and
  path traversal rejection; entries stay disabled.
- [x] Run focused catalog tests; 7 tests passed, and build the runtime package.

### Task 2: Make runtime target launch construction explicit and UTF-8 safe

**Files:** Modify `packages/runtime/src/index.ts` and
`packages/runtime/test/runtime.test.ts`.

**Interface:** Export `createRuntimeLaunch(target, spec)` returning an exact
`{ command, args, cwd, env }` child-process launch. Support local, WSL
distribution and SSH host. Reject bridge until a named, tested protocol
transport exists. The process line reader uses `StringDecoder('utf8')` so a
multibyte code point split over chunks remains intact.

- [x] Test local launch preserves command and arguments without joining them.
- [x] Test WSL adds the distribution and `--` wrapper arguments and refuses an
  unmapped guest working directory.
- [x] Test SSH rejects whitespace/control-invalid host tokens and quotes
  remote command arguments without local shell use.
- [x] Test bridge rejection occurs before process creation.
- [x] Test split UTF-8 code points and final lines without a trailing newline.
- [x] Run focused runtime tests and build; 9 runtime tests passed after bounded
  message queue coverage was added.

### Task 3: Add multi-agent ACP profiles with legacy migration behavior

**Files:** Create `src/extension/acp/agent-profiles.ts` and
`test/extension/acp/agent-profiles.test.ts`; modify `package.json`,
`src/extension/extension.ts`, and `test/extension/acp/diagnostic-routing.test.ts`.

**Interface:** `readAcpAgentProfiles(configuration)` returns validated,
stable-ID profiles from `jsonlView.acp.profiles`; when absent, it maps the
legacy command/args/timeout settings to one profile. Each profile explicitly
pins ACP v1, stdio and local execution. Profiles contain no env secret values
or plugin code. The session manager delegates its process lifecycle to the
shared runtime factory. If more than one is configured, the explicit ACP
diagnostic action shows a native Quick Pick before process launch; cancellation
starts nothing. Selected profile uses the current trusted-workspace,
progress, permission, cancellation and no-replay guards.

- [x] Test legacy setting maps to one profile and a missing legacy command maps
  to an empty list.
- [x] Test duplicate IDs, malformed commands, invalid argument arrays and
  out-of-range timeout values are rejected with bounded errors.
- [x] Test multiple valid profiles require selection and a canceled picker
  causes no ACP child to launch.
- [x] Test selection trust ordering, profile selection, cancellation, legacy
  fallback and session metadata.
- [x] Run focused ACP profile/routing tests; 23 tests passed.

### Task 4: Remove the bridge's false MCP responder

**Files:** Modify `apps/bridge/src/index.ts`; create
`apps/bridge/test/bridge.test.mjs`; modify app scripts/dependencies as needed.

- [x] Test `/mcp` does not return JSON-RPC success or an accepted-method body.
- [x] Test missing credentials and forged Host are rejected; authenticated
  tunnel forwarding remains bounded.
- [x] Test bridge authentication and allowed-host behavior remain enforced on
  any retained custom tunnel route; rejected clients do not start the child.
- [x] Keep custom WebSocket forwarding explicitly labeled as a private raw
  JSON-RPC tunnel, not standard ACP transport.
- [x] Run bridge build and focused tests; 4 tests passed.

### Task 5: Add a real MCP SDK interoperability probe and update contracts

**Files:** Create `scripts/mcp-client-smoke.mjs`; modify root `package.json`,
`CHANGELOG.md`, `docs/mcp-local-plan.md`, `AGENTS.md`,
`docs/decisions/README.md`, and generated `docs/index.json`.

- [x] Probe MCP SDK 1.32.2 against built `dist/mcp-server.cjs` with a temporary
  JSONL source; assert initialize, `tools/list`, one bounded
  `jsonlview_query_records` result and clean close.
- [x] Update the project integration rules to distinguish ACP v1 from v2,
  MCP 2025 SDK interoperability from the 2026 stateless path, protocol
  transport from execution target, and metadata discovery from activation.
- [x] Regenerate and validate the metadata-backed docs index; run
  `pnpm check:agent-spec`, `pnpm check:docs-index`, `pnpm check:contract`,
  and changelog gate after all content settles.
- [x] Run all mandatory product checks, report timeout/failure counts exactly,
  and run the MCP SDK probe after `pnpm build`.

## Closeout Gate

Re-read the plan and ADR, check every task, inspect the complete diff and
`git status`, and verify only the intended worktree branch changed. Do not
claim remote WSL/SSH operation from command-construction tests alone. Integrate
locally only after all required gates and the exact MCP client probe pass; do
not push.
