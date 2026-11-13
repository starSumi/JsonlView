---
id: "084-private-mcp-cli-and-protocol-owner"
path: "docs/decisions/084-private-mcp-cli-and-protocol-owner.md"
title: "Private MCP CLI and Canonical Protocol Owner"
kind: "decision"
status: "accepted"
owner: "product"
tags: ["mcp", "protocol", "package", "runtime"]
evidence: ["source:packages/mcp-server/package.json", "source:packages/mcp-server/src/mcp-read-only-server.ts", "source:src/extension/mcp/", "source:test/extension/mcp/core-parity.test.ts", "source:packages/mcp-server/test/cli.test.mjs"]
revisit: "before publishing the MCP package or changing its source-grant contract"
rollback: "restore extension-owned protocol adapters and keep the MCP workspace package private"
---
# ADR-084: Private MCP CLI and Canonical Protocol Owner

## Context and decision

The extension already starts an explicitly configured MCP stdio sidecar for an
authorized source. The workspace also needs an independent MCP CLI/library for
local tools and integration tests. D-03 accepted both surfaces after mapping
their source and query owners. Implementing both protocols independently let
tool schemas, JSON-RPC errors, lifecycle behavior, stdio limits and trajectory
serialization drift apart.

Keep the standalone package at `packages/mcp-server`, and make its framework-
neutral source the single owner of MCP JSON-RPC, stdio framing, configuration
limits and trajectory wire contracts. The extension sidecar imports that same
implementation. Its source adapter remains extension-owned and checks the
current product authorization before reads; the standalone library accepts
only the explicit source grants supplied by its caller. Neither surface gets a
second protocol implementation or a broader source grant from sharing code.

The CLI and library remain private workspace capabilities. The package keeps
`private: true`; no package publication, registry mutation or end-user install
is part of this decision. The stable local executable is `jsonlview-mcp`, with
`--source <opaque-id>=<absolute-file-path>`, bounded budget/concurrency options,
and root/runtime library exports. Source paths are local launch bindings and
can be visible through process inspection; MCP tools receive source IDs and
reject path-shaped arguments, while the current adapters project results
without source paths.

## Owner and verification contract

| Concern | Owner | Evidence |
| --- | --- | --- |
| MCP JSON-RPC server, stdio framing, limit parser and trajectory wire schemas/serializers | `packages/mcp-server/src/` | Extension facades resolve to the package-owned exports; paired tests compare protocol metadata, schemas, errors and stop behavior. |
| Extension source grants and product query integration | `src/mcp-server.ts`, `src/extension/mcp/trajectory-tools.ts`, `src/extension/rust-query-bridge.ts` | The sidecar receives the active authorized source; identity and authorization are rechecked at the product boundary. |
| Standalone explicit file grants and portable query integration | `packages/mcp-server/src/mcp-server-runtime.ts`, `packages/mcp-server/src/cli.ts` | Synthetic stdio tests cover initialization, listing, bounded reads, invalid grants, EOF, signals and cancellation. |
| Build integration | `esbuild.mjs`, package TypeScript build | The extension bundle contains the shared source; `verify:mcp-client` checks the built stdio sidecar against the official SDK client. |

The root `src/shared/contracts/trajectory-slice.ts` remains the product-facing
facade to the canonical package wire contract. Product trajectory scanning and
standalone trajectory scanning remain separate adapters; cross-surface tests
compare their bounded results on the same synthetic source without conflating
their persistence or provider owners.

## Qualification and release boundary

The package is typechecked, built and exercised through child-process stdio in
the current Windows development environment. The workspace's generic runtime
also has a Linux process-tree smoke, but that does not qualify the standalone
CLI's full OS behavior. No minimum Node version or cross-platform support
matrix is claimed by this private package. Assign and validate those contracts,
review license/dependency provenance, inspect the exact tarball, and obtain
registry readback before any separate publication decision.

The package has no runtime dependency list today. Its compiler target and the
extension bundle target describe emitted syntax; they do not by themselves
declare a supported Node version. The package's README and `private` marker
must remain aligned until a reviewed publication change updates the supported
runtime, OS matrix, install contract and rollback evidence together.
