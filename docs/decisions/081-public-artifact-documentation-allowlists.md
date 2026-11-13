---
id: "081-public-artifact-documentation-allowlists"
path: "docs/decisions/081-public-artifact-documentation-allowlists.md"
title: "Public Artifact Documentation Allowlists"
kind: "decision"
status: "accepted"
owner: "product"
tags: ["packaging", "documentation", "vsix", "npm"]
evidence: []
revisit: "when public documentation, README assets, or package identity changes"
rollback: "restore the prior package file sets and remove artifact README projection together"
---
# ADR-081: Public Artifact Documentation Allowlists

## Context and change class

The VSIX and root npm package both ship the product README, but their existing
file policies also expose internal decision records, metadata, roadmap material,
and unreferenced documentation assets. Public package contents should explain
the supported JSONL and profile boundaries and render the README showcase
without mirroring the full engineering documentation tree.

This is a C2 packaging and public-documentation contract. It changes candidate
staging and package file inventories only; it does not change runtime behavior,
schema, version, installation state, or publication.

## Decision

Both public artifact formats use narrow, explicit documentation allowlists:

- Retain `docs/format-and-profile-boundaries.md` as the one user-facing
  documentation page in each artifact.
- Retain exactly the six image assets referenced by the root README.
- Keep runtime bundles, required native files, project legal notices, and
  third-party license files under their existing owners.
- Exclude decision records, metadata, indexes, roadmaps, reliability/security
  documentation, and assets that the public README does not reference.
- Keep `.vscodeignore`, the root npm `files` field, VSIX staging policy, and npm
  staging inventory aligned with that contract. New README images require an
  allowlist update and a passing drift test; README references do not silently
  expand package contents.

The source README remains unchanged. Artifact builders preserve relative links
to retained docs and images and rewrite links to excluded `docs/...` pages to
the source repository's full commit SHA. Projection requires an HTTPS GitHub
`owner/repository` URL and a 40-character commit SHA. If either is unavailable,
staging fails closed rather than emitting broken package-local links or
including broader documentation. Image links outside the asset allowlist also
fail closed.

## Alternatives

- **Ship all documentation folders:** rejected because package consumers do not
  need internal decision, planning, metadata, and operational records, and broad
  folders make future additions public by default.
- **Derive package assets dynamically from README alone:** rejected because an
  accidental README image edit would silently change the public package
  inventory. The static list and README comparison make review explicit.
- **Remove links to excluded pages from the artifact README:** rejected because
  it discards useful repository context and creates different README prose.
  Commit-pinned links preserve navigation while keeping the package narrow.
- **Add the linked engineering pages to the package:** rejected because it
  recreates broad docs publication and would require maintaining a larger
  public-doc contract.

## Invariants and failure behavior

- The root README and source documentation are never rewritten by packaging.
- Package-local `docs/...` links resolve only to the one retained boundary page
  or one of the six declared README images.
- Links to other repository docs include the exact source commit, not a moving
  branch or `HEAD` reference.
- Missing or invalid repository identity, incomplete commit SHA, and an
  unallowlisted image stop staging before a candidate can be accepted.
- ADRs, roadmaps, metadata, indexes, and unreferenced assets remain absent from
  both VSIX and npm package inventories.

## Validation and rollback

Focused policy tests compare both package allowlists with README asset
references, inspect npm and VS Code file rules, verify stable link projection,
and reject missing source identity or unallowlisted images. VSIX archive policy
continues to enforce required runtime and legal files while rejecting paths
outside its explicit policy. No release candidate is built or published by this
decision.

Rollback restores the previous package file sets and removes the README
projection with the corresponding tests. The source README, user files, and
runtime data require no migration.
