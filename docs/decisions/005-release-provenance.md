# ADR-005: Release Provenance

Status: accepted

## Pressure

Generated VSIX/npm/Open VSX artifacts can drift from source, include transient
files, or be published under the wrong identity.

## Invariant

Every public artifact is traceable from an exact commit and tree through tag,
package contents, digest, authorization, and remote readback.

## Owner

The product owns reproducible build/package commands. `JsonlView-harness` owns
release evidence, screenshots, reports, and operational records.

## Alternatives

- Publish directly from a dirty development checkout: rejected because artifact
  provenance cannot be reconstructed.
- Allow `--allow-dirty` on a public npm candidate: rejected even when a local
  operator requests it; that flag is limited to explicitly non-public staging.
- Treat a successful CLI command as proof: rejected because registries and
  archives can normalize or serve a different file.

## Probe

Build from a clean candidate, inspect VSIX and npm file lists, scan secrets and
licenses, re-walk and re-hash the exact staged candidates, publish only after
authorization, then read back each remote version and digest.

## Decision

Use a frozen candidate, a separate staging directory for npm metadata, explicit
artifact inventories, an exact-file rehash gate, and a post-publication readback. Keep Marketplace,
GitHub, npm, and Open VSX statuses separate.

## Evidence

Release scripts and `JsonlView-harness/report/release-*` evidence. The harness
must label unavailable reviewers, stale historical tags, and unverified
platforms instead of collapsing them into success.

## Boundary

A clean local artifact does not prove a Marketplace listing, cross-platform
native behavior, or a complete online vulnerability database.

## Revisit Trigger

Revisit when a new registry, signing requirement, package identity, native
target, or CI builder is added.

## Rollback

Do not republish a bad artifact under the same version. Unpublish or deprecate
where the registry permits, publish a corrected version, and retain the prior
evidence and hash.
