# Visual Studio Marketplace publication

The Marketplace adapter is a guarded promotion boundary for the exact VSIX
that already passed the public release preflight. It is read-only by default,
uses the official `@vscode/vsce` publisher API for a write, and queries the
Marketplace public gallery for readback.

## Read-only plan and readback

Keep the VSIX, provenance, preflight, and reports outside the product
checkout. A plan never publishes:

```powershell
pnpm marketplace:publish -- `
  --vsix <external>\Sumi-Sophia.jsonlview-data-studio-<version>.vsix `
  --provenance <external>\vsix.provenance.json `
  --preflight <external>\preflight-marketplace.json `
  --out <external>\marketplace-plan.json
```

The plan inspects the archive identity and SHA-256 and verifies any supplied
provenance and preflight. Plans without both evidence files or against another
Gallery URL are `diagnostic` without making a Gallery request; they are not
eligible for authorization. Release-ready plans query the official extension
gallery. If the exact version is
already present, it reports `already-present` and does not republish it. The
gallery can prove public identity and version presence, but not the digest of
the uploaded VSIX; retain the local archive and provenance for that proof.
The report path must be outside the product tree, cannot pass through a link
or junction, cannot overlap any input, and must not already exist. A report
write failure prints its result to the terminal without replacing evidence.

## Manual Marketplace handoff (current ownership)

The product release operator prepares the Marketplace-specific VSIX and its
provenance. The publisher owner uploads it from
https://marketplace.visualstudio.com/manage/publishers/sumi-sophia using
**New extension > Visual Studio Code**, or the existing extension's update
action. Select only the VSIX whose embedded ID is
`Sumi-Sophia.jsonlview-data-studio`. The Open VSX VSIX has a different
ID (`Sumi-Sophia.jsonl-view`) and must not be uploaded here. After the
upload, the operator reads back the exact Marketplace version; a successful
upload screen alone does not prove the public listing has updated.

## Optional API write

Only run this after the target-specific release review and a fresh explicit
authorization for the Marketplace target:

```powershell
$env:VSCE_PAT = '<short-lived-secret-in-process-environment>'
pnpm marketplace:publish -- `
  --publish `
  --vsix <external>\Sumi-Sophia.jsonlview-data-studio-<version>.vsix `
  --provenance <external>\vsix.provenance.json `
  --preflight <external>\preflight-marketplace.json `
  --confirm-target 'Sumi-Sophia/jsonlview-data-studio@<version>' `
  --out <external>\marketplace-publish.json
Remove-Item Env:VSCE_PAT
```

The PAT is read only from `VSCE_PAT`; it is rejected on the command line and
never written to a report. The adapter refuses a missing or stale preflight,
identity mismatch, digest mismatch, dirty candidate, or missing confirmation.
`--out` is required for a write. Before contacting the publisher, the adapter
exclusively creates the external report and flushes an attempted-write record.
If the report cannot be reserved, no upload starts. Use a trusted external
directory that other processes cannot replace during publication.
For a write, both the Gallery readback and `@vscode/vsce` upload must target
`https://marketplace.visualstudio.com`; a stale `VSCE_MARKETPLACE_URL` is
rejected even if `--marketplace-url` is explicitly official. A different
`--marketplace-url` is rejected before publication. The adapter
passes the exact archive to `@vscode/vsce` and does not hand-roll an upload
request.

## Failure and recovery states

- `ready-for-authorization`: official read-only plan with matching provenance
  and preflight; no write occurs.
- `diagnostic`: archive/evidence inspection without a Gallery query when
  evidence is incomplete or the URL is custom; not eligible for authorization.
- `already-present`: the exact public version exists, but its digest is
  unverified; do not blindly replace it.
- `version-visible-unverified`: an upload was attempted and the public version
  is visible, but the registry artifact digest still requires comparison with
  the frozen candidate. `ok` remains false; do not automatically retry.
- `ambiguous`: a write failed, or upload returned but Gallery readback failed
  or could not find the version; the retained report records `writeAttempted`
  and, when upload returned, `writeReturned`. Stop and inspect the report and
  public gallery before taking any action.
- `blocked`: a precondition or credential/confirmation gate failed.

There is no automatic retry after a write error and no automatic unpublish.
If the final report update fails or the process stops during an upload, the
report may be incomplete. Treat the outcome as unknown and inspect the public
Gallery before retrying; the adapter prints any available final state to the
terminal.
`ok: true` only means that the read-only plan is eligible for authorization;
it never claims publication or a verified remote artifact.
Marketplace, Open VSX, npm, and GitHub remain independent promotion targets;
success on one target is not evidence that another target changed.

## Identity and secret boundary

`Sumi-Sophia.jsonlview-data-studio` is pinned in the release contract.
`--publisher`, `--extension-name`, and mismatching identity environment
overrides are rejected. Changing the public identity requires a separately
reviewed migration, not a publication-time flag.
`VSCE_PAT` is a CI secret or short-lived operator secret. Do not put `.env`,
PATs, generated VSIX files, or evidence reports in this repository.
