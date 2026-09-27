# ADR-015: Guard Curated Release Notes in CI

Status: accepted

## Pressure

`CHANGELOG.md` is a human-written release contract. Source changes can land
without a corresponding `Unreleased` entry, while deriving prose directly from
Git history would expose implementation-oriented commit subjects to users.

## Invariant

User-visible implementation changes have a human-readable release note before
they merge. CI verifies presence, not accuracy, completeness, or release
eligibility; publishing remains a separately authorized operation.

## Owner

The product repository owns `CHANGELOG.md`, the guard script, and its CI job.
Implementation-source changes under `src/` or `native/jsonl-core/src/` are in
scope; tests, harness data, and documentation-only changes are not.

## Alternatives

- Keep manual notes without a check: rejected because omissions already occur.
- Generate the user changelog from Conventional Commit subjects: rejected
  because commit intent is not consumer-facing copy, and the existing notes
  intentionally preserve richer product context.
- Add Changesets: deferred because this repository versions one logical product
  and distributes it through coordinated VSIX and npm artifacts; package
  fragments and a version-bump workflow add little value at the current scale.
- Add Git hooks: rejected as the authoritative gate because hooks are local and
  can be bypassed; CI is shared and reproducible.

## Probe

Synthetic Git repositories cover a missing entry, an edit limited to a historic
release, a valid new `Unreleased` bullet, and a test-only change.

## Decision

Keep release notes curated under `## Unreleased`. CI compares implementation
changes with the merge base and requires at least one new bullet in that
section. The check runs with Git's full history available and uses only Node.js
and Git; it adds no runtime or release dependency. Existing Conventional Commit
subjects remain useful machine-readable intent, but do not substitute for a
consumer-facing changelog entry.

## Evidence

The official Keep a Changelog guidance favors a maintained, human-readable
document; Conventional Commits specifies commit-message semantics, not the
quality or completeness of consumer-facing release notes. The current history
already uses Conventional Commit subjects, and the release preflight remains
the authority for candidate integrity and promotion readiness.

## Boundary

The guard does not determine whether a change is user-visible, validate the
truth of an entry, calculate SemVer, generate release prose, bump versions, or
publish artifacts. Internal refactors that touch implementation sources may
need an explicit concise note; this conservative false-positive boundary is
accepted to avoid silently missing product changes.

## Revisit Trigger

Revisit if implementation changes routinely produce non-user-facing false
positives, the product is split into independently versioned packages, or
Conventional Commit-based release automation is adopted.

## Rollback

Remove the CI step and `check:changelog` script entry; retain the curated
changelog and existing release-preflight unchanged.
