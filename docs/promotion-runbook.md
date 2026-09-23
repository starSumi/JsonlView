# Promotion Runbook

This runbook keeps a reviewed update synchronized without turning a file save
into an irreversible public publish. The product checkout is the build source;
the companion `JsonlView-harness` checkout retains release evidence. Generated
manifests and candidates belong outside the product checkout.

## Sequence

1. Freeze one reviewed commit, build the native addon once, and pass that exact
   external `--native` candidate to both `package:vsix:candidate` and
   `package:npm`. Build the production JavaScript/CSS once into an external
   directory and pass that same `--dist` to both commands. Keep the full native
   provenance, exact npm `.tgz`, and both archive manifests beside the external
   artifacts. A
   second native or bundle build is a different release candidate even when
   behavior appears unchanged.
2. Install the exact VSIX candidate into the portable VS Code installation
   (the `--vsix` path must be the same file later supplied to the release gate):

   ```powershell
   pnpm sync:local -- --publisher <publisher> --version <version> --vsix <candidate.vsix> --install
   ```

   Read back the extension id, version, path, and bundle digests. Reload the
   affected VS Code window; `reloadRequired` is not proof that the window has
   reloaded.
3. Run `release:preflight -- --public` with the approved npm name, native
   provenance, npm manifest, exact `.tgz`, optional staging candidate, and VSIX
   manifest/artifact. A dirty,
   private, unlicensed, misidentified, or unproven candidate stops here.
4. Generate a read-only, target-separated plan. It never invokes a registry,
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
5. With separate authorization for each target, publish the exact frozen
   candidate to GitHub, publish the exact npm tarball (`npm publish <candidate.tgz>`)
   rather than repacking its directory, and publish the exact VSIX to Open VSX
   and Marketplace. Record each target as
   `pending`, `published`, `readback`, or `failed`; never collapse them into one
   success. Read back the exact ref/version and artifact integrity after every
   target. A successful npm publish does not prove GitHub or Open VSX changed.

## Safety boundary

`promotion-plan.mjs` is intentionally a plan/gate, not a publisher. It refuses
source or candidate drift and emits no credentials or absolute checkout paths.
The local sync command is the only routine write to the developer machine.
Public promotion remains an explicit operator or protected-CI action because
the targets have independent authentication, rollback, and readback semantics.

Never run a public command from a dirty development checkout, and never place
`.env`, `.npmrc`, tokens, or generated candidates in this repository.
