# Product Documentation

This directory is the public documentation surface for JsonlView. It describes
the product contract, architecture decisions, format/profile behavior,
security boundaries, and reliability gates. It must remain readable from a
clean product checkout without access to a developer machine or the harness.

## Ownership

- `decisions/` contains durable product decisions and their rollback triggers.
- `reliability/` contains local extension SLI/SLO and release-gate policy.
- `security/` contains the threat model and security control map.
- `assets/` contains reviewed public screenshots used by the README.
- Root documents cover format boundaries, the roadmap, and publication flow.

The sibling `JsonlView-harness` owns synthetic fixtures, benchmark records,
host acceptance evidence, screenshots awaiting review, release readbacks, and
postmortem instances. Harness state is never a product runtime dependency or
a release input.

## Reading order

1. Start with the repository `README.md` for product scope and user flow.
2. Read `format-and-profile-boundaries.md` for source and projection rules.
3. Read `decisions/README.md` before changing a shared boundary.
4. Read `reliability/service-levels.md` and `security/threat-model.md` when a
   change affects performance, failure handling, paths, or data exposure.

Claims about measured performance, installed-host behavior, or release output
must link to a pinned harness record rather than copying local paths or raw
logs into this directory.
