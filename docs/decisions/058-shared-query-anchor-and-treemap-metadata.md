---
id: "058-shared-query-anchor-and-treemap-metadata"
path: "docs/decisions/058-shared-query-anchor-and-treemap-metadata.md"
title: "Shared Query Anchor And Treemap Metadata"
kind: "decision"
status: "accepted"
owner: "product"
tags: ["bounded-metadata","insights","query","transport","webview"]
evidence: []
revisit: "before a Treemap producer or consumer is connected, or a panel setting changes"
rollback: "revert the task-owned shared contract, layout and anchor composition together"
---
# ADR-058: Shared Query Anchor and Treemap Metadata

Status: accepted for the isolated shared-anchor and metadata candidate.
Host/Insights Treemap integration and the remaining selected UI interactions
have separate, incomplete gates in the [interaction design](../designs/query-studio-and-navigator.md).

## Pressure

A Table-only Studio trigger disappears when another view becomes active.
The selected interaction needs one stable second-row anchor across all five
views. The requested area visualization needs bounded JSONL/Session metadata,
exact weights and a testable pure layout before any Host or UI consumption.

## Invariant

Physical JSONL bytes remain authoritative and read-only. Moving an existing
trigger must not add a query owner or issue a query on opening. Treemap input
is a disposable metadata projection, not filesystem discovery, source content
or authorization. Exact weights remain decimal strings. Finite SVG geometry
does not imply exact representation of every positive relative weight.

## Owner

App composes one existing Studio and retains the existing controller/client/
reducer lifecycle. Controlled presentation owns focus and geometry. Host owns
configuration and authorization. Shared owns Treemap DTOs, strict structural
validation and pure layout; the producer owns label safety and semantic
accounting. Existing Insights owners retain AnalysisIntent admission and scan
budgets under [ADR-046](046-insights-analysis-intent-and-scope.md).

## Alternatives

- A separate Studio/controller per view duplicates query state and admission.
  Reuse the existing instance through the shared header slot instead.
- A disk scanner or source-body DTO exceeds the selected JSONL/Session scope.
  Keep input metadata-only with no runtime I/O in the shared layer.
- Converting weights to JavaScript numbers loses exact integer magnitudes.
  Use bounded decimal strings and BigInt totals, converting only normalized
  geometry to doubles.
- Adding a chart dependency before a consumer exists adds an unproved runtime
  boundary. Keep the selected-level layout dependency-free and independently
  testable; consumer selection remains a later task.

## Decision

### Shared anchor

Compose `TopQueryStudio` once through `WorkspaceHeader.secondary` in App.
Keep Table quick controls conditional on Table. Capture the opening focus
target and generation. Close/Escape restores a still-valid Table cell or the
mounted shared trigger, including a non-Table -> Table transition. Opening
and preset selection remain draft-only; Run uses the existing predicate route.
Pin, geometry and Host defaults follow the selected design but are not made
implemented by this decision. No new SQL evaluator is included.

### Treemap V1 structural contract

`TreemapMetadataV1` has exactly ten fields: `version`, `sourceId`, `documentId`,
`generation`, `fingerprint`, `metric`, `scope`, `root` and `truncated` (nine
named payload fields plus the version field). The source declaration is the
field-count authority; no additional budget, query or path field is accepted.
`version` is 1. The current identity is supplied by the authorized owner;
source/document/generation/fingerprint must all match exactly. This equality
is a currentness check, not an authorization grant or proof of complete
AnalysisIntent equality.

`metric` is `records` or `bytes`. `scope` is one of `source`, `provider`,
`session`, `event-kind` or `field-group`: it names a grouping domain. It does
not mean Current view versus Whole file, imply scan coverage or permit
cross-source access. A future producer must state the source membership and
aggregation interpretation for its selected grouping. Grouped byte weights
cannot be obtained by relabelling examined scan bytes.

Each node has `id`, `label`, `value` and optional `children`; unknown properties
fail validation. All node weights are canonical non-negative decimal integer
strings (`0` or a nonzero digit followed by digits), at most 1024 digits. No
numeric, signed, fractional, exponent, leading-zero or whitespace form is
accepted. The total-node budget is 500 including root. Root is level 1; depth
is at most 500 levels. Children arrays must be dense own-index arrays; holes,
inherited indices, null and undefined entries are rejected. Traversal counts
all descendants against the same budget.

Source, document, generation and node IDs are 1 through 256 characters and
reject slash, backslash and C0/DEL control characters. These are opaque
identifiers, not path locators; a colon is not separately forbidden. Labels are
nonempty, at most 256 characters, without C0/DEL controls. Fingerprints are
nonempty, at most 512 characters, without those controls. Those string guards
cannot prove arbitrary text has no sensitive content. The future producer
must derive safe display labels, stable unique node identities and an approved
fingerprint from metadata; it must not forward raw prompts, record bodies or
arbitrary file paths in those fields.

The guard checks neither parent/child arithmetic nor ID uniqueness. Parent
weights may differ from child sums in structurally valid input. `truncated` is
only a required boolean; false does not prove complete source coverage, and
true carries no omitted-count or denominator. Accounting, overlap/deduplication,
omitted groups, coverage and producer provenance remain unresolved before a
runtime consumer. This candidate does not infer them from a valid shape.

### Pure selected-level geometry

`layoutSquarifiedTreemap` lays out one supplied level, with at most 500 nodes;
it is not a recursive tree renderer. It preserves exact values and input order
in the result while using descending positive areas to place rectangles.
Zero weights have zero geometry. Sub-pixel relative weights may underflow to
zero geometry while retaining their exact label value.

Bounds use finite `x`, `y`, `width` and `height`, with non-negative dimensions.
For each positive extent `d` at origin `o`, `o + d` must be finite and
`abs(((o + d - o) / d) - 1) <= 8 * Number.EPSILON`. This rejects origins that
cannot represent the requested extent. For positive-area, nonzero-total work,
normalization by `max(width, height)` must retain nonzero normalized area and
at least one positive item area. Otherwise layout throws rather than emitting
a false empty/overlapping picture. Zero-size bounds or zero total return zero
geometry within the preceding bounds validation. This is a numerical
representation contract, not a CSS-pixel minimum or an arbitrary finite-number
guarantee. Very small or large representable squares are supported.

Row placement and consumption use the same normalized geometry and shared
projected endpoints. Tests must check pairwise overlap, bounds and union
coverage, not area sums alone. Layout never reads sources, checks permissions,
starts work, registers protocol messages or stores results.

## Probe

Query tests cover all five trigger contexts, no open-time GET_ROWS, exactly one
Run route, valid grid restoration and cross-view Close/Escape fallback. Treemap
tests cover exact decimal forms and limits, stale identity, unknown fields,
root-inclusive budgets, dense children and opaque IDs. Geometry tests include
narrow/transposed viewports, tiny/huge squares, zero and extreme weights,
unrepresentable origins and underflow rejection. Preserve input immutability,
determinism, bounds, overlap and coverage checks.

## Evidence

Source and focused tests establish candidate-level behavior only. Integrated
mandatory gates and independent review are required after candidate correction.
No Host Treemap producer or Insights consumer is connected by this contract.
No native-host interaction, benchmark, release or publication follows from
pure contract/layout tests. Current source and test files remain the executable
authority; external receipts remain validation evidence rather than runtime
or build inputs.

## Boundary

This is a C2 shared-contract change. The Treemap module is additive and is not
added to the main Webview message union. Its barrel export alone creates no
wire route. No new dependency, source scanner, file mutation, setting store,
SQL language, graph database or embedded Navigator architecture is selected.
Future runtime integration must bind complete analysis intent, cancellation,
deadline, scan budget and semantic provenance through existing owners.

## Revisit trigger

Revisit before connecting a Treemap producer/consumer, changing byte accounting,
parent/child semantics, truncation, identity, maximum budgets or numeric layout
domain. Revisit panel defaults when configuration delivery or close/focus rules
change. A new visual composition needs its own selection and native-host check.

## Rollback

Remove task-owned Treemap contracts/guard/layout and their additive barrel
export together, preserving independent unrelated shared contracts. Restore
the previous App/header composition with its matching focus tests if necessary.
Retain this decision as historical if superseded. No source or provider data
migration is needed because this candidate adds no persistent runtime state.
