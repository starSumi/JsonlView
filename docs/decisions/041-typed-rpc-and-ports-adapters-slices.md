# ADR-041: Typed RPC And Ports-Adapters Slices

Status: accepted

## Pressure

JsonlView has two active runtimes: the VS Code Extension Host and a sandboxed
Webview. The product also has provider-specific session formats, filesystem
indexing, and an optional native scanner. Existing protocol validation, request
tracking, and provider presentation are correct but still expose large module
boundaries. The next refactor must make ownership explicit without changing the
wire shape, lifecycle semantics, or release composition root.

## Invariant

- JSONL bytes remain the physical authority; indexes, caches, and UI state are
  disposable projections.
- The Extension Host owns filesystem access, provider discovery, generation
  fencing, cancellation, and VS Code APIs.
- The Webview owns interaction state and bounded presentation only. It never
  imports Node, VS Code, filesystem, or native binding modules.
- Provider adapters normalize source-specific records into shared domain and
  presentation contracts. Provider-specific parsing stays inside its adapter.
- The root package remains the composition and release unit until an independent
  consumer, build graph, and provenance contract are demonstrated.

## Owner

- `src/shared/`: versioned protocol and serializable domain contracts.
- `src/extension/`: host-side transport endpoint, application use-cases, and
  lifecycle/cancellation coordination.
- `src/webview/`: feature owners, protocol client, and presentation state.
- `src/experimental/` and `src/adapters/` when introduced: explicitly bounded
  provider or filesystem adapters, each with one source owner.
- `test/`: behavior and contract evidence; focused policy tests stay beside a
  pure owner when that improves discoverability.

## Alternatives

- Next.js-style `api/route/service` folders: rejected because the product has no
  HTTP request lifecycle and those names hide the Extension Host/Webview seam.
- A global `services/` directory: rejected because it creates an unowned
  dependency bucket and obscures use-case boundaries.
- Immediate pnpm or Cargo workspace extraction: rejected until a second runtime
  consumer and independent build/provenance evidence exist.
- A new protocol version for each extraction: rejected; a refactor preserves the
  current wire contract and only changes the version after an explicit migration
  decision.

## Probe

Each vertical slice must identify one user-visible capability, its owner, input
and output contracts, cancellation behavior, and rollback commit. The slice must
pass focused characterization tests before merge, then the full typecheck, build,
contract, changelog, public-surface, and diff gates. A slice touching transport
must also prove direction-specific malformed-message rejection, request identity,
generation fencing, and cancellation without unbounded pending state. Application
use-cases must enforce the invariants that apply independently of the transport
caller; shared predicate AST validation remains owned by the transport/engine
contract.

## Decision

Adopt a staged hybrid architecture:

1. **Typed transport.** Keep `ProtocolEnvelope` as the wire envelope. Centralize
   request/response validation and cancellation semantics behind a small shared
   transport contract; the Extension Host and Webview may provide different
   implementations, but neither bypasses the contract.
2. **Application use-cases.** Extract named operations such as loading a bounded
   record page or resolving a provider source behind ports. Use-cases receive
   ports and cancellation signals, and do not import VS Code or React.
3. **Adapters.** Keep filesystem, provider, and native scanner details behind
   ports. Adapters may depend on domain contracts; domain and use-cases may not
   depend on adapter modules.
4. **Feature-first Webview.** A feature owns its model, controller, view, and
   focused tests. Compatibility barrels remain thin and contain no parsing or
   lifecycle owner.
5. **Vertical migration.** Migrate one capability at a time, retaining the
   existing facade and wire shape until the new owner has equivalent evidence.

## Evidence

The first provider-specific presentation slice is the Claude event builder in
`src/webview/providers/claude-event-builder.ts`. The typed transport and bounded
record-page application use-case are now merged behind the existing facades.
Transport validation covers every host-to-Webview message variant, and the
application port rejects out-of-budget page requests before reaching a reader.
The candidate-bound harness run records the structural checks; the paired
workload measurement below is retained as a separate harness artifact so the
product does not depend on harness storage at runtime.

For the fixed synthetic mixed-profile corpus (100,000 records, 47,167,597
bytes), a single paired Node-scanner run on Windows x64 / Node v24.15.0 measured
the candidate runtime snapshot at 28.047 ms for the first 100 rows, 143.657 ms
for complete indexing, 11.341 ms for a reverse page, and 44.4 MiB peak RSS
delta. The comparison snapshot measured 28.564 ms, 143.685 ms, 11.369 ms,
and 43.0 MiB. Both runs produced the same boundary digest and the candidate
bundle was 803,065 bytes versus 800,640 bytes. This is one local paired
measurement, not a cross-platform or statistically bounded performance claim.

## Normative References

- [JSON Lines specification](https://jsonlines.org/) defines the source format
  boundary and record framing assumptions.
- [VS Code Webview API](https://code.visualstudio.com/api/references/vscode-api#Webview)
  defines the host-to-Webview message surface.
- [VS Code Webview guide](https://code.visualstudio.com/api/extension-guides/webview)
  defines the sandbox and lifecycle constraints for the presentation runtime.
- [VS Code custom editor guide](https://code.visualstudio.com/api/extension-guides/custom-editors)
  defines the document/editor integration contract used by the product.

## Boundary

This decision does not authorize a package split, network service, provider
write, transcript mutation, native zero-copy path, or public release. It applies
to the current modular monolith and its local read-only indexing workflows.

## Revisit Trigger

Revisit when a second runtime consumes a stable engine or protocol package, when
the current composition root creates a measurable build or release bottleneck,
or when a staged slice changes latency, memory, bundle size, or installed-host
behavior beyond its recorded budget.

## Rollback

The application slice is pinned at `670cd6a` (rollback parent `04c0a61`) and the
transport hardening slice at `cd733e1` (rollback parent `3b626cd`). Revert one
vertical slice at a time and keep the prior facade and harness receipt. Do not
delete the old contract or rewrite historical evidence. A candidate-bound run is
invalidated when source, package, lockfile, or gate input hashes change; create
a new run instead.
