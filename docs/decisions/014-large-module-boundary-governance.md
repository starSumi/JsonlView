# ADR-014: Large Module Boundary Governance

Status: accepted

## Pressure

The working tree currently contains several modules whose size makes review and
change isolation expensive: `src/engine/jsonl-engine.ts` (2016 lines),
`src/webview/App.tsx` (1646), `src/webview/event-presentation.tsx` (1327),
`src/extension/integrated-session.ts` (967), and
`src/profiles/codex-profile.ts` (768). `src/webview/styles.css` is 2063 lines
and has the same discoverability problem, although CSS must be split by
cascade ownership rather than by an arbitrary line threshold.

The counts are a review snapshot from 2026-09-27 against product baseline
`9f7130330da5cbf53dfe6f555d7d5dcf3805772e`; the checkout is intentionally
dirty. They are evidence for a refactor plan, not a claim that every line in
the dirty tree belongs to one change.

## Invariant

Refactoring must reduce change coupling without changing the authority model:

- the engine remains the authority for bytes, framing, offsets, generations,
  indexing, and bounded queries;
- the extension host remains the authority for lifecycle, cancellation, and
  versioned IPC;
- profiles remain semantic adapters and never become a second parser or source
  of physical truth;
- the Webview keeps bounded projections, interaction state, and display-only
  behavior; Raw/Copy remain authoritative;
- every extracted boundary preserves generation checks, cancellation, budgets,
  malformed-input fallback, and native-to-portable fallback;
- a mechanical split is behavior-neutral and independently reversible.

## Owner

The owning directory reviews its seam, while the existing runtime owner keeps
the contract:

| Module | First seam | Contract owner |
| --- | --- | --- |
| `engine/jsonl-engine.ts` | scan/cursor, hydration, projection, sort/problem budgets | Engine |
| `webview/App.tsx` | protocol message handling, viewport recovery, request lifecycle, layout | Webview session controller |
| `webview/event-presentation.tsx` | bounded extraction, provider adapters, command/diff candidates, generic fallback | Presentation adapter |
| `extension/integrated-session.ts` | lifecycle/IPC orchestration, detection, insight queries | Integrated session |
| `profiles/codex-profile.ts` | response-item projection, event-message projection, validation | Codex profile |
| `webview/styles.css` | tokens/base, shell/controls, table/detail, diff/structured views | Webview styling |

## Alternatives

- Split every file at 300 or 500 lines: rejected because line count does not
  establish a semantic seam and would increase cross-module coupling.
- Rewrite the whole tree into feature-sliced or clean-architecture folders:
  rejected because the product has two runtimes, a file authority, a native
  failure domain, and a versioned protocol; a global shared layer would become
  an escape hatch.
- Add a parser/highlighter/worker dependency while moving code: rejected
  because correctness, bundle, CSP, memory, and latency evidence would become
  impossible to attribute to one change.
- Leave the large modules untouched: rejected because review surface,
  ownership ambiguity, and accidental state coupling are already observable
  maintenance risks.

## Decision

Use an evidence-first, seam-by-seam refactor. Do not change behavior and module
topology in the same unmeasured patch.

1. **Characterize before extraction.** Add or confirm focused tests for each
   boundary's inputs, outputs, cancellation, stale generation, malformed data,
   budget exhaustion, and fallback. Record the current symbol clusters and
   hot-path measurements.
2. **Extract pure policies first.** Move normalization, cursor math, bounded
   classification, and formatting helpers behind stable contracts. These are
   low-risk seams because they do not own I/O or React lifecycle.
3. **Extract one state machine at a time.** The next candidates are the engine's
   row query pipeline, the Webview's message/recovery controller, and the
   presentation candidate adapters. Keep the existing façade while callers
   migrate incrementally.
4. **Keep provider and UI dispatch explicit.** A provider-specific adapter may
   return an additive projection, but unknown or malformed input falls back to
   the generic path. No extracted module may silently become a second semantic
   owner.
5. **Split CSS by cascade layer only after selector ownership is mapped.** Each
   extracted stylesheet must have an explicit import order and no selector may
   move across layers without a visual regression check.
6. **Close each slice with evidence.** Run focused tests, typecheck, build, and
   representative UI/runtime checks before starting the next slice. If a seam
   increases bundle size, render cost, or request count beyond its budget, revert
   that slice instead of compensating with another abstraction.

## Probe

For each proposed extraction, produce this minimum record:

```text
entry -> owner -> decision -> side effect -> persistence -> recovery
```

Then compare before/after on a synthetic corpus containing: first-page load,
large records, invalid/blank rows, stale generation responses, cancellation,
partial sorted pages, provider-specific records, unknown records, and native
scanner failure. The falsifier is any changed row identity/offset, dropped raw
value, stale response committed to the view, budget overrun, or visual cascade
regression.

## Evidence

- `source-confirmed`: the existing engine, session, profile, and Webview
  boundaries in `src/` and their focused tests.
- `runtime-observed`: the current large-file counts from the 2026-09-27 working
  tree snapshot.
- `test-backed`: current focused regression coverage for pagination, invalid
  rows, and Codex `web_search_call` classification.
- `unknown`: actual post-split bundle/render deltas; these require measurement
  per slice and must not be inferred from line count.

## Boundary

This ADR does not authorize a repository-wide rewrite, dependency replacement,
public release, or harness fixture promotion. It does not require splitting a
file merely because it exceeds the threshold. A file may remain large when its
state ownership is coherent and a split would make the contract less explicit;
that exception must be recorded in the slice review.

## Revisit Trigger

Revisit when a proposed slice has characterization coverage, a named owner, a
rollback path, and before/after measurements. Revisit immediately if a module
starts owning two independent state machines, duplicates a normalization rule,
or requires callers to know private lifecycle details.

## Rollback

Each slice remains a separate change and retains the original façade until its
focused and full validation gates pass. Revert the slice, not the unrelated
working tree, when a contract, performance, visual, or packaging gate fails.
