# Continuous improvement loop

This file is the product-facing maintenance contract. It keeps recurring work
small, observable, and reversible; operational output belongs in the companion
`JsonlView-harness` checkout.

## Priority order

1. **P0 — correctness and safety on every change.** Pull requests run the
   contract check, TypeScript check, unit/integration tests, build, and native
   Rust checks including `cargo clippy --all-targets --locked -- -D warnings`.
   A failure blocks promotion. The Windows native job validates
   the locked Cargo manifest, rebuilds the addon
   from the checked-out Rust source into an isolated runner directory, and
   validates and loads only that rebuilt candidate. The benchmark runs against
   that candidate, and
   the candidate plus its source/toolchain/binary digest report are checked in
   the runner workspace and handed to an external harness/release environment;
   public CI deliberately does not upload installable bundles or VSIX
   candidates. The quality lane still exercises the extension manifest and
   `.vscodeignore` on every change. A byte mismatch against a trusted historical
   binary is recorded rather than treated as a failure because compiler and
   linker versions can legitimately change machine-code bytes; ABI, behavior,
   and candidate-contract mismatches block the job.
2. **P1 — dependency freshness every week.** Dependabot watches the npm,
   GitHub Actions, and native Cargo manifests. The scheduled workflow queries
   the npm registry for direct JavaScript dependencies and uploads a bounded
   JSON report. The checker requests the compact `/latest` document and uses a
   bounded exponential retry for transient registry failures; a final outage
   is reported as `degraded` and fails the maintenance job after its artifact
   is uploaded, so an outage cannot look like a healthy freshness result. Cargo
   updates remain reviewable Dependabot changes rather than being silently
   rewritten. No job mutates `package.json`, lockfiles, or Cargo manifests
   without a reviewed change and a new compatibility/security check.
3. **P1 — benchmark trend every week.** A fixed synthetic mixed workload is
  measured with the same scanner setting. The report records open, first-page,
  full-index, reverse-page, memory, runtime, fixture hash, lockfile hash, source
  revision, and an explicit benchmark workload version. Bump that workload
  version when the fixture generator, runner, measurement semantics, or
  aggregation changes; this intentionally invalidates older baselines. History
  is restored and written under the runner's
   temporary directory, outside the checkout, so it cannot make the measured
   source tree appear dirty. The workflow runs a second sample and fails its
   smoke check unless that sample finds a comparable baseline. A baseline is
   used only when the workload, fixture, and platform/architecture are
   comparable; CPU and OS details remain visible for review. It is evidence,
   not a claim of universal performance or a release gate.
4. **P2 — release gate promotion.** Once enough trend history exists, define
   explicit regression thresholds and make the release workflow consume the
   report. Until then, keep the maintenance job non-destructive and visible.

## Ownership and rollback

- Product source owns scripts and workflow definitions.
- `JsonlView-harness` owns retained reports, screenshots, fixtures, and release
  evidence; generated artifacts default to the operating-system temporary
  directory. Public CI keeps native addons, VSIX files, and other installable
  bundles in the runner workspace only. A protected release environment may
  export a provenance record after the source, identity, license, and
  authorization gates pass; that record is not a release artifact or a
  substitute for a clean-candidate release record.
- Freshness checks can be rerun after a registry outage; a failed lookup is
  reported as degraded and never mutates dependencies. The check covers direct
  manifest dependencies only; lockfile transitive updates and vulnerability
  advisories remain separate review work. Benchmark history can be moved or
  deleted without affecting the product, because the scheduled workflow keeps
  it external to the checkout and uploads it only as short-lived evidence.

To reproduce the native gate on a Windows host, use the project wrapper with
temporary output and target directories. The wrapper applies the same path
remapping used by CI:

```powershell
$env:JSONLVIEW_NATIVE_OUTPUT_DIR = '<temp>\native-build'
$env:JSONLVIEW_NATIVE_TARGET_DIR = '<temp>\cargo-target'
pnpm native:build
node scripts/verify-native-provenance.mjs --candidate $env:JSONLVIEW_NATIVE_OUTPUT_DIR --skip-committed --out '<temp>\native-provenance\provenance.json'
```

The report contains the repository revision and cleanliness observation, the
sorted native source-input manifest, lockfile and binary SHA-256 digests,
toolchain versions, ABI/capability values, and bounded behavior vectors. It
intentionally distinguishes byte identity from semantic identity: a different
compiler or linker may produce different bytes while still passing the
contract and behavior gate.

## Acceptance

The loop is considered active when the PR workflow is green, its Windows lane
has a passing source-to-binary provenance report, the scheduled workflow
produces both JSON maintenance artifacts, and a reviewer can compare at least
three like-for-like benchmark samples before enabling a regression threshold.
