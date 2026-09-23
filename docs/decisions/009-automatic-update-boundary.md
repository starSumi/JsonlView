# ADR-009: Automatic Update Boundary

## Pressure

The development VSIX is installed from a local file, while users expect a
marketplace-installed extension to receive updates without reinstalling a
second artifact. A proposal to add a self-updater would make the extension
download and install executable code outside the editor's normal trust and
update path.

## Invariant

An installed extension must update only through the configured VS Code
extension gallery or an explicitly managed private gallery. A local candidate
is test evidence, not an update channel. The product must never download,
replace, or execute a VSIX from an unverified URL at activation time.

## Owner

Release automation owns publishing signed, reviewed candidates to each target.
VS Code owns client-side update discovery and installation. The harness owns
release evidence and target readback.

## Alternatives

- Add an activation-time GitHub/HTTP self-updater: rejected because it creates a
  second installer, expands the network and code-execution threat surface, and
  cannot provide the gallery's publisher/trust semantics.
- Keep distributing local VSIX files: retained only for development and
  air-gapped validation, not for routine user updates.
- Publish through VS Code-compatible galleries: selected as the default path;
  each gallery remains an independent target with its own identity and
  readback.

## Probe

For every release, verify the exact publisher/id/version in the candidate,
publish only the frozen artifact, and read back the version and digest from the
target gallery. On a development install, record `reloadRequired` separately
from an actual window reload.

## Decision

JsonlView will not contain a self-updater. Public users receive updates from a
configured gallery after the extension is installed there. Local development
continues to use the explicit `sync:local` lane and must be reloaded after an
install. Private deployments may configure a private gallery, but that
infrastructure is outside the product extension.

## Evidence

The repository's promotion preflight and plan-only coordinator tie the local,
VSIX, npm, GitHub, and Open VSX candidates to one source revision and digest.
The VS Code custom-editor implementation already runs inside the editor's
extension lifecycle; adding a parallel installer would bypass that boundary.
VS Code's marketplace documentation also states that a VSIX install disables
automatic updates for that extension by default, while gallery-installed
extensions can be updated when the client policy enables it. The client may
delay installation after publication (the documented default is two hours),
so the product makes no fixed-time update promise. See the official
[Extension Marketplace](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace)
and [Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
documentation.

## Boundary

This decision does not promise that every gallery has identical update timing
or platform coverage. It also does not make a proprietary or unlicensed
checkout publishable; identity and license review remain release gates.

## Revisit Trigger

Revisit only if a target gallery is unavailable for the supported user base or
if a documented enterprise gallery contract requires a product-owned update
client. Any revisit must include a threat model, signature/provenance design,
rollback path, and an end-to-end test before implementation.

## Rollback

Disable the affected gallery publication or release a corrective version. Do
not overwrite an installed extension or rewrite a public version in place.
