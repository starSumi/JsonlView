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
  --out <external>\marketplace-plan.json
```

The plan inspects the archive identity and SHA-256, verifies any supplied
provenance and queries the official extension gallery. If the exact version is
already present, it reports `already-present` and does not republish it. The
gallery can prove public identity and version presence, but not the digest of
the uploaded VSIX; retain the local archive and provenance for that proof.

## Authorized write

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
It passes the exact archive to `@vscode/vsce` and does not hand-roll an upload
request.

## Failure and recovery states

- `ready-for-authorization`: exact candidate is eligible, but no write occurs.
- `already-present`: the exact public version exists; do not blindly replace it.
- `published-readback`: the write returned or failed ambiguously, and public
  version readback confirms the target.
- `ambiguous`: the write outcome is unknown; stop and inspect the report and
  public gallery before taking any action.
- `blocked`: a precondition or credential/confirmation gate failed.

There is no automatic retry after a write error and no automatic unpublish.
Marketplace, Open VSX, npm, and GitHub remain independent promotion targets;
success on one target is not evidence that another target changed.

## Identity and secret boundary

The default target is `Sumi-Sophia.jsonlview-data-studio`. Override it only for
an explicitly reviewed target with `--publisher` and `--extension-name`.
`VSCE_PAT` is a CI secret or short-lived operator secret. Do not put `.env`,
PATs, generated VSIX files, or evidence reports in this repository.
