---
id: "046-insights-analysis-intent-and-scope"
path: "docs/decisions/046-insights-analysis-intent-and-scope.md"
title: "Insights Analysis Intent And Scope"
kind: "decision"
status: "accepted"
owner: "product"
tags: ["bounded-scan","insights","lifecycle","query"]
evidence: []
revisit: "when adapter revision or analysis source watermark contracts change"
rollback: "revert shared analysis protocol and host and webview together"
---
# ADR-046: Insights Analysis Intent and Scope

Status: accepted for the isolated query-scope experiment

## Pressure

Table search, multiple field conditions and row types already compose a typed
predicate. Insights previously rebuilt only text search, omitting field
conditions and row types. A delayed result could therefore describe a different query or
profile while appearing to describe the current view. Its aggregate counts did
not state whether they described filtered records or the whole file.

## Invariant

The source remains read-only. Current-view Table and Insights use the same pure
condition compiler over the existing predicate AST and engine. Display columns
are projection only. An Insights result commits only when its complete analysis
intent equals the currently accepted intent. Bounded evidence never claims a
whole-file count. Navigator discovery remains an explicit opt-in action.

## Owner

Shared contracts own AnalysisIntent v1 and comparison. The record-query slice
owns condition compilation. App owns monotonic intent issuance and cancellation;
the reducer owns result admission. The document controller owns source and
profile identity validation before and after the bounded engine scan. Existing
profile adapters own the semantic projection and its version.

## Alternatives

- Rebuild separate Insights predicates: rejected because partial filter copying
  already diverged from Table.
- Add a query language or dependency: rejected because the existing typed AST
  expresses text, AND field conditions and OR row types.
- Default to whole-file: rejected because existing Insights used current search.
  Current view is the smaller behavioral change and includes all Table conditions.
- Identify analysis only by scope and request ID: rejected because query,
  profile, document generation and source epoch can change independently.
- Include Columns in the predicate: rejected because projection changes neither
  matching records nor aggregate meaning.

## Probe

Compare Table records and current-view aggregate counts over the same synthetic
Codex input using text, two conditions and two row types together. Change query,
field conditions, row type, profile and scope while an old result is delayed;
admit a newer result, then deliver the old result and verify it cannot replace
the new cache. Test mismatched source epoch/profile revisions before scanning
and a profile change during a paused scan. Verify whole-file excludes predicates,
bounded scan accounting remains visible, and handwritten queries emit no
Navigator request.

## Decision

Insights offers Current view and Whole file. Current view is the default and
scope persists with the workspace. Current view means all records matching the
Table conditions in the selected file, subject to the existing scan budgets;
it does not mean only the rendered page. Whole file removes all Table conditions
but retains scan budgets. Both scopes use the existing ascending physical scan
and aggregate engine; Table sort/order does not alter aggregate membership.

AnalysisIntent v1 carries:

- version 1 and a monotonically increasing intentRevision within the Webview;
- aggregation dimension and explicit scope;
- documentId, generation and sourceEpoch when the source supplies an epoch;
- selected profile ID and its existing AgentProfile.version;
- a normalized typed predicate for current-view, absent for whole-file.

Associative AND/OR nodes are flattened and conditions are sorted for canonical
comparison. This is normalization of the existing AST, not a new DSL. The
profile's existing version is the adapter/projection revision; this experiment
does not invent a second revision or claim support for mutable external adapters.
Current hosts expose that version in DocumentSummary and PROFILE_CHANGED. The
version remains optional in legacy transport fixtures, but missing revision
prevents issuing analysis and is never borrowed from a previous profile.

GET_INSIGHTS carries the intent and INSIGHTS echoes it. Semantic edits clear the
accepted intent and cached result and advance the revision. The App cancels
pending superseded work, while the reducer independently rejects unequal
intents. Selecting a profile invalidates analysis immediately; new analysis
waits for the host to acknowledge that profile. Scope and dimension remain
editable while analysis is pending. The
host verifies document/generation/epoch/profile before scanning and again before
posting. Display column visibility, order and width do not invalidate analysis.
Background and explicit profile publishers revalidate the captured document,
generation, source epoch and profile ID/version after asynchronous delivery;
cancelled profile requests cannot publish their follow-up summary. Captured
progress keeps its original identity rather than borrowing a newer envelope.

A correlated analysis error records the failed semantic conditions. Automatic
effects do not retry those conditions merely because pending clears or the
intent revision increases. A changed predicate, scope, dimension, document or
profile identity permits another attempt; the explicit Refresh action also
permits a retry. Dismissing an error and changing display columns do not. This
admission rule bounds repeated stale-intent and ordinary failures without a
timer or silently overriding the host's authority.

Provenance states scope, whether a predicate was applied, and complete or bounded
scan coverage. The UI labels examined source records, matched records, truncation
reason and grouped overflow. Complete means the selected source scan reached its
end within budget. It does not promise future appended records are included.
Capacity overflow remains visible even if source scanning completed.

Navigator retains its existing opt-in command and explicit open action. Neither
condition compilation nor handwritten query edits opens or scans Navigator.
Cross-file query linking is outside this experiment.

## Evidence

Product tests cover shared compilation, real-engine membership agreement,
request validation, response provenance, paused host identity changes, stale
reducer admission, explicit UI scope and Navigator opt-in. Tests also cover
interleaved background/explicit profile publication, cancelled
same-profile requests, and bounded automatic retries with Refresh recovery.
Full mandatory gates
must pass on the integrated candidate. The experiment alone claims no installed
VS Code acceptance, publication or performance improvement.

## Boundary

No new dependency, source mutation, native operator, MCP service or cross-file
query is introduced. Sampled or truncated counts are evidence about examined
records. Schema and dataset-specific aggregation remain separate concerns.
The new request shape requires host and Webview to be built together; protocol
envelope compatibility does not make the old GET_INSIGHTS payload valid.

## Revisit Trigger

Revisit when externally mutable adapters need an independent projection revision,
persisted analysis results outlive a Webview lifecycle, or aggregation resumes
over a growing source with a defined watermark. Also revisit when whole-file
analysis needs measured opt-in budgets beyond the current bounded scan.

## Rollback

Revert the experiment's shared protocol, host, Webview and tests together. The
older Webview ignores persisted insightScope. Source bytes and Navigator state
are unchanged. Rebuild both extension and Webview after rollback.
