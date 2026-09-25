# ADR-012: Registry Extension Identities

## Pressure

Visual Studio Marketplace extension names are globally unique. The existing
`jsonl-view` name belongs to another publisher there, while
`Sumi-Sophia.jsonl-view` is already the published Open VSX update identity.
Changing that Open VSX identity would strand existing installations because an
extension ID is the publisher and name pair and Open VSX does not rename an
extension in place.

## Invariant

Every registry artifact comes from one frozen source revision, native addon,
and production bundle. Registry coordinates may differ, but commands, settings,
custom-editor IDs, behavior, legal files, and npm identity remain stable. Two
artifacts with shared contribution IDs are alternatives, not co-installable
variants.

## Owner

`config/release-targets.json` owns the registry coordinate map. Candidate and
verification scripts own deterministic target projection. Registry accounts
own final name acceptance and publication; the sibling harness owns readback
evidence.

## Alternatives

- Rename the extension everywhere: rejected because Open VSX cannot transfer
  the old ID's update chain, downloads, or reviews.
- Reuse one VSIX on both registries: rejected because the Marketplace name is
  already reserved by another publisher.
- Patch a packaged ZIP by hand: rejected because it is not reproducible and
  breaks source-to-artifact provenance.
- Rename commands and settings with the Marketplace package: rejected because
  those identifiers are user-facing compatibility contracts, not registry
  coordinates.

## Probe

Query both registries before freezing a release, package each declared target,
inspect both embedded manifests, and compare every archive entry except
`extension/package.json` and `extension.vsixmanifest`. Test the expected failure
when both IDs are installed and verify that removing one restores normal
activation without changing `jsonlView.*` configuration.

## Decision

Keep these stable coordinates:

- Open VSX: `Sumi-Sophia.jsonl-view`
- Visual Studio Marketplace: `Sumi-Sophia.jsonlview-data-studio`
- npm: `@sumi-labs/jsonl-view`

`package-vsix-candidate.mjs --target <open-vsx|marketplace>` reads the checked-in
target map. `verify-vsix-targets.mjs` proves shared payload equality, and the
preflight binds one VSIX to one target. The two VSIX files share a version but
retain separate digests and registry readbacks.

## Evidence

The VS Code extension manifest contract defines the extension ID as
`publisher.name`. Microsoft Marketplace publishing guidance requires a unique
name, and Open VSX management guidance documents republishing under a new name
rather than renaming. Repository evidence is provided by
`config/release-targets.json`, the packaging and verification scripts, CI, and
target-specific release reports.

## Boundary

A search returning no result does not reserve a Marketplace name; only an
accepted upload and subsequent API readback prove ownership. Download counts do
not equal active users. The product does not claim that both registry IDs can be
enabled together, because their static contribution identifiers intentionally
remain the same.

## Revisit Trigger

Revisit if either registry supports verified identity aliases or transfers, if
the Marketplace name becomes unavailable before first publication, or if the
product introduces registry-neutral contribution IDs that make co-installation
safe and useful.

## Rollback

Do not remove the established Open VSX identity. If the Marketplace publication
fails, leave that target failed and continue serving Open VSX and npm. After a
Marketplace release, use unpublish only as a temporary containment measure and
prefer a corrective higher version; permanent removal is not routine rollback.
