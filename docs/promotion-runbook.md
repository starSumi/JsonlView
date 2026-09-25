# Promotion Runbook

This runbook keeps a reviewed update synchronized without turning a file save
into an irreversible public publish. The product checkout is the build source;
the companion `JsonlView-harness` checkout retains release evidence. Generated
manifests and candidates belong outside the product checkout.

## Sequence

1. Put the release change on its own branch, open a pull request, and require
   the repository checks before merging to `main`. Freeze the reviewed merge
   commit, build the native addon once, and pass that exact
   external `--native` candidate to both `package:vsix:candidate` and
   `package:npm`. Build the production JavaScript/CSS once into an external
   directory and pass that same `--dist` to both commands. Keep the full native
   provenance, exact npm `.tgz`, and both archive manifests beside the external
   artifacts. A
   second native or bundle build is a different release candidate even when
   behavior appears unchanged.
2. Package one VSIX per declared target from `config/release-targets.json`:

   ```powershell
   node scripts/package-vsix-candidate.mjs --target open-vsx <shared-inputs> --out <open-vsx.vsix>
   node scripts/package-vsix-candidate.mjs --target marketplace <shared-inputs> --out <marketplace.vsix>
   node scripts/verify-vsix-targets.mjs `
     --open-vsx <open-vsx.vsix> `
     --marketplace <marketplace.vsix> `
     --out <external>\vsix-pair.json
   ```

   Open VSX keeps `Sumi-Sophia.jsonl-view`; Marketplace uses
   `Sumi-Sophia.jsonlview-data-studio`. The verifier must prove that every
   non-identity entry is byte-for-byte equal. Never patch either archive by
   hand.
3. Accept both registry candidates sequentially. Install the exact Open VSX
   candidate, retain its local-sync manifest, then explicitly uninstall or
   disable it before installing the Marketplace candidate and retaining a
   second manifest. Restore the Open VSX candidate as the final local state for
   an Open VSX-managed workstation. Never enable both IDs together.

   Install each exact candidate into the portable VS Code installation
   (the `--vsix` path must be the same file later supplied to the release gate):

   ```powershell
   pnpm sync:local -- --target <open-vsx|marketplace> --version <version> --vsix <candidate.vsix> --install
   ```

   Read back the extension id, version, path, and bundle digests. Reload the
   affected VS Code window; `reloadRequired` is not proof that the window has
   reloaded.
4. Run the full preflight once for each VSIX target. Each run must consume the
   same persisted pair report and name the other target's exact VSIX:

   ```powershell
   pnpm release:preflight -- `
     --public `
     --approved-npm-name @sumi-labs/jsonl-view `
     --vsix-target <open-vsx|marketplace> `
     --vsix-pair-report <external>\vsix-pair.json `
     --paired-vsix-artifact <other-target.vsix> `
     --provenance <full-native-report.json> `
     --npm-manifest <npm.provenance.json> `
     --npm-candidate <npm-staging-directory> `
     --npm-tarball <exact-candidate.tgz> `
     --vsix-manifest <selected-vsix.provenance.json> `
     --vsix-artifact <selected-target.vsix> `
     --out <external>\preflight-<target>.json
   ```

   A dirty, private, unlicensed, misidentified, pair-mismatched, or unproven
   candidate stops here.
5. Generate one read-only plan per VSIX target, pairing it with that target's
   retained local-sync manifest. It never invokes a registry,
   GitHub, VS Code, or shell publication command:

   ```powershell
   node scripts/promotion-plan.mjs `
     --preflight <preflight.json> `
     --local-manifest <local-sync.json> `
     --vsix-manifest <vsix.provenance.json> `
     --npm-manifest <npm.provenance.json> `
     --out <external>\promotion\promotion-<version>.json
   ```

   Add `--local-reloaded` only when a human has just verified the active
   window. The resulting plan must say `readyForPromotion: true`; otherwise
   fix the listed blocker and regenerate it.
6. With separate authorization for each target, publish the exact frozen
   candidate to GitHub, publish the exact npm tarball (`npm publish <candidate.tgz>`)
   rather than repacking its directory, and publish each exact VSIX only to its
   bound registry. Record each target as
   `pending`, `published`, `readback`, or `failed`; never collapse them into one
   success. Read back the exact ref/version and artifact integrity after every
   target. A successful npm publish does not prove GitHub or Open VSX changed.
7. Read back the Git tag and release assets, confirm GitHub's `/releases/latest`
   points to the new version, and verify the repository sidebar after an
   anonymous hard refresh. Then download each registry artifact and compare its
   digest with the frozen candidate.

The two extension IDs share commands, settings, and `jsonlView.editor`; they are
not supported as a co-install. When changing registry source, disable or
uninstall the old ID before installing the other. A co-install test is a failure
mode check, not a supported configuration.

## Safety boundary

`promotion-plan.mjs` is intentionally a plan/gate, not a publisher. It refuses
source or candidate drift and emits no credentials or absolute checkout paths.
The local sync command is the only routine write to the developer machine.
Public promotion remains an explicit operator or protected-CI action because
the targets have independent authentication, rollback, and readback semantics.

Never push a release directly to an unprotected `main`. Never run a public
command from a dirty development checkout, and never place
`.env`, `.npmrc`, tokens, or generated candidates in this repository.
