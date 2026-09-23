# ADR-008: Promotion Synchronization

## Pressure

Product changes need a predictable path from source to the locally used VS Code
extension and, when explicitly approved, to GitHub and package registries.
Those surfaces have different owners, credentials, failure modes, and
readback semantics. Treating a source edit as an automatic public publish can
ship a dirty or misidentified artifact and cannot roll back a partially
completed multi-target promotion.

## Invariant

Every reviewed update is traceable to one frozen source revision and one
verified candidate set. Local installation is independently verified. Public
targets are promoted separately, with explicit authorization and a
target-specific post-promotion readback. A failed target remains visibly
failed or pending; it is never reported as an all-target success.

## Owner

The product checkout owns deterministic build, candidate, and verification
scripts. The local operator owns the portable VS Code installation. The
companion `JsonlView-harness` owns retained release evidence and the external
promotion state manifest. GitHub Actions may publish only from a protected,
reviewed tag and cannot manipulate a personal VS Code installation.

## Alternatives

- Bind every file save or watch build to `npm publish` and `git push`: rejected
  because those are irreversible external writes without a review boundary.
- Use one unconditional script that publishes GitHub, npm, Open VSX, and
  Marketplace as a transaction: rejected because the targets are independent
  and do not share rollback or authentication semantics.
- Treat a successful CLI exit or an old harness report as proof of promotion:
  rejected because registry normalization, stale reports, and partial failure
  can produce a different live state.

## Probe

Freeze the revision, build the native and JavaScript payload once, record
identity and source-state hashes, inspect the candidates, and re-hash them
before promotion. Install the VSIX with the actual portable `code.cmd`, read
back its id/version/path and bundle digests, and require a window reload.
Publish each external target only after its own authorization, then read back
the exact version, artifact digest, and repository/ref state.

## Decision

Use two layers:

1. A product-side prepare/verify layer creates immutable, external candidates
   and provenance. It is safe to run repeatedly and never publishes.
2. An operator/ protected-tag promotion layer consumes those candidates. A
   local sync explicitly installs the reviewed VSIX; GitHub, npm, Open VSX,
   and Marketplace are separate promotion lanes with independent status and
   readback. Re-running the same version with the same digest may be skipped;
   a different digest for an existing version is a hard failure.

The normal order is local acceptance, candidate verification, GitHub/ref
promotion, and then independently authorized registry promotions. A release
manifest is written outside the product checkout with an atomic replace and
records `pending`, `published`, `readback`, or `failed` per target.

## Evidence

`scripts/package-vsix-candidate.mjs`, `scripts/prepare-npm-package.mjs`,
`scripts/release-preflight.mjs`, the protected CI workflows, and the
`JsonlView-harness` release records provide the implementation and readback
surfaces. The current local publisher/package metadata and registry state must
be re-probed for every release; historical evidence is navigation only.

## Boundary

Local installation proves neither that a running window has reloaded the new
extension nor that a public registry accepted an artifact. A green CI build
does not prove credentials, target ownership, cross-platform native behavior,
or a complete vulnerability scan. Public promotion remains unavailable while
the candidate is dirty, private, unlicensed, misidentified, or lacks a
verified remote and authorization.

## Revisit Trigger

Revisit when a new distribution target, signing requirement, native platform,
trusted-publishing provider, release workflow, or VS Code installation model
is added, or when a target offers a transactional promotion API.

## Rollback

Preserve the last verified artifact and the per-target state manifest. Do not
force-push or unpublish as routine recovery and never overwrite an existing
version with a different digest. Publish a corrective version where the
target permits it, disable or deprecate the affected release, and record the
exact readback and operator decision.
