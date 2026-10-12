# ADR-042: Documentation ownership and external evidence

Status: accepted

## Context

Product documentation and validation-workspace documents serve different
lifecycles. Product records define runtime contracts, supported commands, and
architecture decisions. Validation records contain synthetic fixtures,
screenshots, benchmark receipts, host acceptance, and release readbacks.
Embedding a validation checkout path in product code or a durable product
decision makes the product depend on an operational workspace and creates a
privacy and reproducibility hazard.

## Decision

- Product `AGENTS.md`, source, tests, and decision records describe stable
  product ownership and public contracts only.
- The external validation workspace owns synthetic evidence, screenshots,
  benchmark runs, host checks, and release readbacks. Its paths are not product
  API, runtime configuration, or source truth.
- Product benchmark helpers accept an explicit `JSONLVIEW_ARTIFACT_DIR` (or an
  explicit `--artifact-root`) and reject output outside that root. They never
  infer a sibling validation checkout.
- The `agent-spec-lint` and decision-index checks keep product machine guidance
  synchronized with source changes. The validation workspace may run these
  checks, but it does not redefine their product contract.

## Evidence

- [JSON Lines specification](https://jsonlines.org/)
- [VS Code custom editor guide](https://code.visualstudio.com/api/extension-guides/custom-editors)
- [VS Code Tree View guide](https://code.visualstudio.com/api/extension-guides/tree-view)
- The repository `AGENTS.md`, `config/agent-spec.json`, and
  `scripts/check-agent-spec.mjs` are the product-side implementation of this
  boundary.

## Consequences

Product tests use temporary external-artifact roots and synthetic data. Harness
wrappers must provide their output root explicitly. Existing historical evidence
remains immutable in the validation workspace and is referred to by receipt id,
not by a product filesystem path.

## Revisit trigger

Revisit when a supported host integration needs a documented artifact export
protocol or when the validation workspace becomes an independently distributed
tool with a versioned contract.

## Rollback

Revert this decision and the corresponding explicit-root checks together; do not
restore an inferred sibling checkout path.
