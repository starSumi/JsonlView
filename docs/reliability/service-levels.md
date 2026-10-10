# Reliability Service Levels

## Scope

JsonlView is a local VS Code extension. It has no hosted control plane and
does not offer an availability SLA. This document defines engineering SLI/SLO
signals and release error-budget rules for the extension, its Webview, and its
optional native scanner.

## Service-level indicators

| SLI | Measurement owner | Evidence |
| --- | --- | --- |
| Contract correctness | `src/shared/types.ts` and runtime validation | contract tests, typecheck |
| Operation recovery | Extension Host generation and cancellation fencing | stale-response, cancellation, rebuild tests |
| Scanner parity | Node/native newline offsets and fallback behavior | native verification and scanner tests |
| Resource boundedness | first page, full index, RSS, and scan budget | pinned harness benchmark record |
| Release integrity | VSIX/npm allowlist, native ABI, and public-surface scan | release preflight and candidate archive checks |

## Objectives

- Candidate builds must pass the contract, type, test, build, and public-surface
  gates before release review.
- Native acceleration must remain optional and have a passing portable fallback.
- A cancelled, stale, malformed, oversized, or unsupported request must not
  publish an unbounded result or mutate the source JSONL.
- Performance numbers are valid only with a pinned corpus, host/runtime,
  command, and boundary digest. A single-host synthetic run is not a
  cross-platform SLO.

## Error budget policy

The release error budget for contract failures, native parity failures, public
surface leaks, or installed-host crashes is zero. A candidate with one of these
failures stops promotion until the owner records a fix or an explicit rollback.

Performance regressions are reviewed against the previous pinned baseline; they
are not silently converted into a promise. A new native topology, package
workspace, or transport requires a separate measurement and rollback record.

## Non-goals

This policy does not promise a cloud SLA, a universal latency target, or native
performance on an unsupported platform. Harness benchmark and host evidence
remain separate from this product contract.
