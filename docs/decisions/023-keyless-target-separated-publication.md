# ADR-023: Keyless and Target-Separated Publication

## Pressure

The project has three public distribution surfaces with different identities,
authentication contracts, and rollback behavior: the npm package, Open VSX,
and the Visual Studio Marketplace. A single publication workflow or a
long-lived registry token makes it too easy to reuse an artifact or credential
outside the target for which it was reviewed.

## Invariant

- A publication job may run only for a reviewed commit on main.
- One native rebuild and one production bundle produce all candidates for a
  release. The pair report and public preflight bind those candidates together.
- npm and Open VSX use OIDC trusted publishing. No npm token or Open VSX token
  is stored in GitHub Actions secrets.
- Marketplace publication remains isolated behind VSCE_PAT until its
  publisher API supports the same trusted-publisher contract. The secret is
  read only from the protected environment and is never accepted on a command
  line.
- A successful write is not a successful release until the exact public version
  and artifact are read back.

## Decision

Use two manual, target-separated workflows:

- .github/workflows/npm-publish.yml owns npm publication and explicit npm
  dist-tag promotion. It runs on windows-latest, checks the current commit's
  CI and CodeQL results, builds the paired candidates, runs both public
  preflight gates, then publishes the exact npm tarball.
- .github/workflows/extension-publish.yml owns VSIX candidate creation and
  independent Open VSX and Marketplace jobs. Open VSX uses
  npx ovsx@1.2.0 publish <exact.vsix> --trusted-publishing; Marketplace uses
  the existing release adapter and VSCE_PAT.

Both workflows are restricted to refs/heads/main, use contents: read, and run
under protected environments named npm-publish and extension-publish. The npm
environment's trusted publisher registration must use the exact workflow
filename npm-publish.yml; the Open VSX registration must use the exact filename
extension-publish.yml and environment extension-publish. Workflow jobs request
id-token: write only where an OIDC exchange is made.

The npm promote operation is intentionally explicit. It accepts a version,
dist-tag, prior run id, and artifact name, downloads the non-secret release
evidence, and refuses to retag unless both target preflight reports are green,
bound to the current commit, and bound to @sumi-labs/jsonl-view at that
version. This gives npm dist-tag a narrow, auditable purpose rather than a
general bypass around the release gate.

## Alternatives rejected

1. One workflow with all registry credentials: rejected because target
   identity and failure recovery would share a permission boundary.
2. A long-lived npm or Open VSX token in repository secrets: rejected because
   the registries provide workload identity federation for GitHub Actions.
3. Publishing directly from a dirty checkout or repacking a directory at the
   upload step: rejected because the repository's candidate scripts already
   bind source, native provenance, exact archive bytes, legal inventory, and
   target identity.
4. Treating Marketplace visibility as a digest proof: rejected because the
   existing Marketplace adapter records version visibility as an ambiguous
   readback until the exact package bytes are compared.

## Ownership and configuration

| Surface | Owner in this repository | External configuration | Credential boundary |
| --- | --- | --- | --- |
| npm | npm-publish.yml and prepare-npm-package.mjs | npm Trusted Publisher: GitHub Actions, starSumi/JsonlView, npm-publish.yml, environment npm-publish | OIDC; npm publish and npm dist-tag permissions are independent |
| Open VSX | extension-publish.yml and package-vsix-candidate.mjs | Open VSX trusted publisher: GitHub Actions, starSumi/JsonlView, extension-publish.yml, environment extension-publish | OIDC; no OVSX_PAT |
| Marketplace | extension-publish.yml and marketplace-publish.mjs | Protected GitHub environment secret VSCE_PAT | Secret is environment-scoped and process-only |

Branch protection, required reviewers, environment reviewers, and the trusted
publisher registrations are external GitHub/registry state. This change does
not claim those settings are configured until an authenticated readback records
them. The repository currently has no independent collaborator, so the human
owner remains the final promotion authority.

## Validation and rollback

The package job requires successful quality, native-windows, and CodeQL checks
for the exact commit, then runs contract, type, test, native, candidate, pair,
provenance, and preflight checks. Publication jobs upload non-secret evidence
and read back the target registry. A failed or ambiguous write is terminal
until the public registry is inspected; automatic retries are not allowed.

Rollback is target-specific: disable the affected workflow or trusted
publisher, revoke the Marketplace secret if exposed, and stop future tags.
Existing immutable npm/VSIX versions are not overwritten. A later reviewed
version is the normal forward correction; npm dist-tag promotion may move a
tag only when its evidence remains bound to the reviewed commit.

## Evidence

- npm Trusted Publishers: https://docs.npmjs.com/trusted-publishers
- npm dist-tag: https://docs.npmjs.com/cli/v11/commands/npm-dist-tag
- npm publish: https://docs.npmjs.com/cli/v11/commands/npm-publish
- Open VSX trusted publishing: https://github.com/eclipse-openvsx/openvsx/wiki/Publishing-Extensions
- GitHub Actions OIDC: https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/configuring-openid-connect-in-cloud-providers

## Revisit trigger

Revisit when Marketplace offers an equivalent trusted publisher, when a
registry changes its OIDC audience or workflow matching rules, or when GitHub
branch/environment readback confirms a different required-review topology.
