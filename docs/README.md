# Product Documentation

This directory is the public documentation surface for JsonlView. It describes
the product contract, architecture decisions, format/profile behavior,
security boundaries, and reliability gates. It must remain readable from a
clean product checkout without access to a developer machine or an evidence
workspace.

## Ownership

- `decisions/` contains durable product decisions and their rollback triggers.
 - `reliability/` contains local extension SLI/SLO and release-gate policy.
 - `security/` contains the threat model and security control map.
 - `operations/` contains the stable incident-response and postmortem policy;
   incident instances and raw evidence remain external.
- `assets/` contains reviewed public screenshots used by the README.
- Root documents cover format boundaries, the roadmap, and publication flow.

An external validation workspace owns synthetic fixtures, benchmark records,
host acceptance evidence, screenshots awaiting review, release readbacks, and
postmortem instances. Its state is never a product runtime dependency or a
release input.

## Reading order

1. Start with the repository `README.md` for product scope and user flow.
2. Read `format-and-profile-boundaries.md` for source and projection rules.
3. Read `designs/theme-adaptation.md` for the accepted host-theme and Webview
   interaction baseline.
4. Read `decisions/README.md` before changing a shared boundary.
5. Read `reliability/service-levels.md` and `security/threat-model.md` when a
   change affects performance, failure handling, paths, or data exposure.
6. Read `operations/postmortem-policy.md` when a failure needs corrective
   action or recurrence prevention.

## Design baselines

- [Theme adaptation design](designs/theme-adaptation.md) records the accepted
  Neutral Contrast direction, Compact Focus density guidance for dark host
  themes, semantic VS Code token contract, and visual acceptance boundary.
  It is product documentation, not runtime configuration or harness evidence.

Claims about measured performance, installed-host behavior, or release output
must link to an immutable external evidence receipt containing an ID, source
revision, digest, boundary, and reproduction command. A receipt is an audit
pointer, not a build input or runtime dependency.
