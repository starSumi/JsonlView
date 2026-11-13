---
id: "070-graph-authorization-and-snapshot-identity"
path: "docs/decisions/070-graph-authorization-and-snapshot-identity.md"
title: "Graph Authorization and Snapshot Identity"
kind: "decision"
status: "accepted"
owner: "product"
tags: ["graph","security","identity","profiles"]
evidence: []
revisit: "before expanding the current-document caller or adding asynchronous layouts"
rollback: "disable a future Graph caller first, then revert the pure model changes and its tests together; no source or persistence migration is required"
---
# ADR-070: Graph Authorization and Snapshot Identity

## Pressure, invariant and owner

At adoption the bounded Graph v2 application model had no production caller. Its previous
input shape could retain cross-source observed or inferred edges without Host
authorization, treat an edge generation as unrelated text, and accept a late
layout from a different source/profile snapshot. Closing these contract gaps
precedes any Graph UI integration; it does not establish an installed UI or an
external attack path.

The product shared model owns bounded projection and identity comparison. The
future Host adapter owns source authorization, current indexed physical record
references, profile evidence and publication freshness. Graph input is data and
cannot grant itself permission. This is a C2 application contract change, not a
new wire protocol or a persistent/public Graph format.

## Decision and compatibility

`buildBoundedGraph` takes an optional, separately supplied
`GraphAuthorizationContext`. Every cross-source edge, including user, observed
and inferred provenance, requires explicit current source-generation grants for
the edge owner and both endpoints, `authorizeCrossSourceEdge` returning exactly
true, and `verifyEvidence` returning exactly true. An owner in a third source
also makes an edge cross-source. Missing, stale, duplicate or malformed grants,
missing current source generations, and callback exceptions fail closed with
bounded diagnostics and partial coverage. Input properties claiming grants or
authorization are ignored. Any supplied edge generation must equal its owner
source's unambiguous current generation, including single-source edges.

Cross-source evidence contains a nonempty bounded field-path list and a
physical `RecordRef` bound to the edge owner source and current generation.
The model validates canonical bounded decimal coordinates, delimiter/parse
state and byte-span consistency, and copies only known fields. The Host
verifier must establish that the reference is an actual current indexed record
and that those field tokens support that relation; structural validation does
not prove source contents. Both Host ports receive the exact edge identity,
endpoints, projection kind, raw kind and provenance that will be published, so
changing a relationship's kind cannot preserve an older verification request.
The display-only canonical path is never a lookup
authority. Callbacks consume prevalidated Host facts synchronously, without
source reads; normalization and callback admission consume the same existing
deterministic work budget. Grants apply to this build only. A future adapter
must reauthorize and recheck source identity before publishing or revealing.

Nodes may carry an optional physical `RecordRef` obtained from the current Host
engine for that qualified source. Provided stale or malformed references are
rejected. Catalog-only nodes remain metadata without a physical locator; their
`available` catalog status is not a reveal capability. No ordinal or byte offset
may be guessed from `nativeId`, and the model performs no source read or reveal.
Host reveal must still use the existing authorized current-generation chain.

Node projection kinds are `session`, `subagent`, `event`, `tool`, `unknown`;
edge projection kinds are `parent`, `calls`, `responds`, `references`, `unknown`.
Unknown producer kinds map to `unknown`, retaining bounded `rawKind` separately.
Kinds reject C0/DEL controls and remain text, never markup, paths or executable
content. A future renderer must use a text sink. Optional node kinds default to
`unknown`, preserving metadata-only construction. The pure input and layout
identity now require a canonical decimal `snapshotRevision` and bounded opaque
`profileVersion`; there are no production consumers to migrate.

Async layout freshness compares graph generation, snapshot revision, profile
version, the complete unique source-generation set, layout generation, request
ID and viewport dimensions. Source set order is irrelevant; missing, duplicate,
changed or additional sources are not current. These checks do not themselves
grant source access or establish current live Host state.

## Alternatives, probe and evidence boundary

Authorizing only at source intake would retain permission after revocation.
Trusting input evidence paths or a producer relationship without Host binding
would let data become policy. A Host-owned port with deny-by-default behavior
keeps permission outside the projection and follows the established
[OWASP authorization guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html).
No new grant store, external Graph authorization surface or UI is introduced.

Synthetic tests cover separate-context authority, exact source grants, stale
edge/record generations, malformed and absent evidence, Host verifier denial
and exceptions, duplicate scopes, deterministic work exhaustion, qualified IDs,
unknown kinds, physical-reference copying and all late-layout identity fields.
Type checks and product contract/document gates complement those focused tests.
The original evidence is L2 model behavior only. ADR-071 adds the first bounded
current-document Host caller with real engine/profile tests and corrects the
reference content-end span semantics. That caller emits only evidence-bound
observed relationships; it does not validate arbitrary inferred edges or enable
cross-source access. Static rendering and Host integration tests do not prove
installed Graph rendering, interaction, layout quality or user acceptance.

## Revisit and rollback

Before the first production caller, review its Host source mapping, evidence
verification, revocation/publication gate, bounded layout implementation and
discoverable left-side interaction entry. User review selects the Graph UI
variant independently. Disable that future caller before reverting this model,
the authorization/reference helpers and tests together. Source bytes and stored
Collections metadata are unaffected.
