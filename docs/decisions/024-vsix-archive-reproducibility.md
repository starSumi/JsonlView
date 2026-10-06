# ADR-024: VSIX Archive Reproducibility

Status: proposed

## Pressure

Two VSIX packages built from the same candidate had identical payload bytes but
different archive bytes. The remaining differences were ZIP entry timestamps.
This obscures whether a release changed its payload and makes exact candidate
readback harder than necessary.

## Invariant

- The VSIX payload and entry set remain unchanged by this decision.
- The packaging helper must preserve the caller environment and must not use the
  current wall clock to invent a release timestamp.
- A release job that needs byte-identical archives must explicitly provide a
  valid non-negative SOURCE_DATE_EPOCH value shared by every packaging run.
- Without that variable, packaging keeps the upstream vsce default behavior;
  provenance records that the reproducibility override was unset.

## Owner

scripts/package-vsix-candidate.mjs owns the child environment passed to the
official @vscode/vsce package. The harness owns repeated-build evidence and
release acceptance records.

## Alternatives

1. Rewrite ZIP metadata after vsce finishes: rejected because it mutates the
   published archive outside the packaging tool and can invalidate signatures.
2. Derive the timestamp from the current wall clock: rejected because it makes
   repeated builds differ by construction.
3. Always select a repository-local timestamp: rejected because local defaults
   should not silently claim a reproducible release unless the release job
   deliberately supplies a shared value.
4. Compare only extracted payloads: retained as a compatibility fallback, but
   insufficient when exact archive identity is required.

## Decision

Pass a validated SOURCE_DATE_EPOCH through the child environment when the
caller supplies it. The helper removes an inherited value only when it is
absent, so an unset default remains explicit and no wall-clock fallback is
introduced. The value and its source (environment or unset) are included in
the VSIX provenance record.

The upstream @vscode/vsce implementation uses this standard variable to set
the yazl ZIP modification time and sort archive entries. JsonlView therefore
uses the upstream mechanism instead of replacing the archive writer.

## Probe

The focused script tests cover explicit and absent environment values and reject
negative, non-numeric, and unsafe integer epochs. An isolated synthetic VSIX
probe using the installed @vscode/vsce produced different SHA-256 values for
two runs without the variable and identical SHA-256 values for two runs with
SOURCE_DATE_EPOCH=1700000000.

## Evidence

- VSCE source (v4.0.0):
  https://github.com/microsoft/vscode-vsce/blob/v4.0.0/src/package.ts
- Reproducible Builds SOURCE_DATE_EPOCH convention:
  https://reproducible-builds.org/docs/source-date-epoch/
- VS Code extension packaging documentation:
  https://code.visualstudio.com/api/working-with-extensions/publishing-extension
- Local repeated-build record:
  JsonlView-harness/state/runs/quality-0.2.7-repro-20261006/reproducibility-evidence.json

## Boundary

This decision governs VSIX ZIP metadata and entry ordering only. It does not
prove native binary reproducibility, source cleanliness, signing, registry
publication, or installed-host behavior. Those remain separate release gates.

## Revisit Trigger

Revisit when @vscode/vsce changes its archive writer or environment contract,
when VSIX signing becomes mandatory, or when fixed-epoch packaging still differs
after the source and toolchain are frozen.

## Rollback

Remove the environment validation and provenance fields, then return to the
previous payload-digest-only gate. No already-published artifact is overwritten.
