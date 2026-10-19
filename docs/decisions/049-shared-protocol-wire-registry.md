# ADR-049: Shared Protocol Wire Registry

Status: accepted for the next implementation slice

## Pressure

Source intake, Navigator guidance, and the JSONL editor now cross the same
Extension Host/Webview boundary. Keeping their result vocabulary in feature
modules would allow a successful file write to be mistaken for registration,
catalog availability, or an open editor. It would also make stale generation,
unknown readback, and direction errors hard to distinguish.

## Invariant

- `src/shared/protocol/` is the single product-owned registry for versioned
  wire shapes and lifecycle discriminants. Existing imports from
  `src/shared/types.ts` remain source-compatible during migration.
- `src/shared/transport/` owns envelope stamping/validation, request
  correlation, generation and epoch gates, and cancellation. It does not own
  source registration or Navigator policy.
- A Save As result reports `fileSaved`, `sourceRegistered`, `catalogState`, and
  `openState` independently. A write does not imply configuration readback, a
  metadata projection, an entity scan, or an editor open.
- Navigator results separate enablement, authorization, authorization
  persistence readback, and open-or-guide action. `unknown` is retained until
  the authoritative state is read; it is never converted to success.
- Result payloads carry bounded stable error and stage codes, not exceptions,
  source bodies, credentials, provider-private fields, SQLite handles, or UI
  component properties.
- Optional envelope direction is checked when present. Legacy envelopes without
  direction remain valid, while known request and response directions are
  rejected when explicitly reversed.

## Owner and change class

The shared protocol owner maintains the wire registry, bounded guards,
compatibility exports, and contract tests. Feature owners consume the shapes
without redefining them. This is a C2 shared-contract and lifecycle change.

## Alternatives

- Moving all existing record and query types at once was rejected: it would
  create a broad import migration without improving the current wire. The
  registry is introduced as a facade and new types are added behind it.
- Reusing the existing free-form `ERROR.code` string for every lifecycle fact
  was rejected: it cannot express independent outcomes or unknown readback.
- Returning one boolean such as `saved=true` was rejected: it collapses the
  write, config, catalog, and open failure domains.
- Putting provider names, SQLite schema, or Webview component props in the
  shared layer was rejected: those belong to adapters, catalog ports, or UI
  state respectively.

## Decision

The registry exposes `NavigatorBridgeResultV1` and
`SourceRegistrationFactsV1`, stable stage/error unions, bounded guards, and
message-direction helpers. The existing protocol version and transport
envelope stay unchanged except for an optional direction discriminator. New
host-to-Webview result discriminants are `NAVIGATOR_STATUS` and
`SOURCE_REGISTRATION_RESULT`; existing requests remain valid.

The Navigator result uses orthogonal facets: enablement, authorization,
authorization readback, open state, and an action (`focus-add-source`,
`focus-sessions`, `request-enable`, `request-authorization`, `open-source`,
or `none`). The source result requires failure metadata for failed, cancelled,
conflict, and unknown states. Guards enforce bounded IDs and URIs, finite
epochs, known codes, and cross-field success invariants.

## Probe and validation

Contract tests cover successful and guided Navigator outcomes, persisted
authorization readback, cancellation/denial/failure/unknown paths,
independent Save As outcomes, required unknown readback, direction reversal,
and malformed success claims. Existing transport and message-validation tests
remain the compatibility gate. Full product validation still requires the
consumer tasks and installed-host evidence.

## Evidence

- `src/shared/types.ts` remains the compatibility source for the existing
  version-1 envelope and record/query unions.
- `src/shared/transport/` retains envelope validation, request IDs,
  generation/epoch handling, and cancellation ownership.
- `src/extension/message-validation.ts` retains bounded query and scan budgets.
- The VS Code Webview message boundary requires explicit validation and does
  not grant source permissions or provider access by itself.

## Boundary and rollback

This ADR adds no source writes, catalog scans, Navigator enablement, network
transport, or provider adapter. Roll back by removing the new registry exports
and result message cases while retaining the existing envelope and transport
validators. Consumer implementations must stop emitting the new result types
before that rollback.

## Navigator visibility state

NAVIGATOR_VISIBILITY is a bounded { visible: boolean } host broadcast,
separate from Navigator authorization and open-result status. It uses an empty
request ID with the current document generation and epoch, so normal stale
message gates apply without completing a pending request. Each editor receives
the latest value after READY and on later TreeView visibility changes.

## Revisit trigger

Revisit when a second wire consumer needs a new direction, when a source or
Navigator result requires a field outside the bounded vocabulary, or when
measured compatibility evidence justifies a protocol-version migration.
