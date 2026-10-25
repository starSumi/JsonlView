---
id: "048-bounded-conversation-and-dataset-scenes"
path: "docs/decisions/048-bounded-conversation-and-dataset-scenes.md"
title: "Bounded Conversation And Dataset Scenes"
kind: "decision"
status: "accepted"
owner: "product"
tags: ["bounded-scan","conversation","datasets","projection"]
evidence: []
revisit: "when projection budgets or dataset observation semantics change"
rollback: "disable the optional projections and retain the physical record table"
---
# ADR-048: Bounded Conversation and Dataset Scenes

Status: accepted

## Pressure

Physical record tables support audit and query but make conversations difficult
to read. Dataset examples require targets, preference alternatives, role and
loss metadata rather than an agent event clock. Both need bounded projections
without introducing a second source of truth or fetching every row detail.

## Invariant

The physical RecordRef remains the identity in every display mode. Query,
ordering, pagination, selection, follow and reading anchors have one owner.
Changing presentation must not issue a different query or reinterpret ordinal
as timestamp. Unknown and invalid records remain inspectable.

## Owner

Profiles own deterministic semantic extraction. Shared contracts own bounded
projection DTOs. The engine derives them during existing record hydration.
The Webview owns rendering and accessible interaction; it never reads source
files or follows external media and tool-output paths.

## Alternatives

- Fetch full RecordDetail for every conversation row: rejected because this
  multiplies requests and defeats the page and detail budgets.
- Reuse only the short table summary: insufficient for reading message text.
- Treat every JSON object as an agent: rejected because dataset targets and
  token sequences have different semantics.
- Compute dataset statistics from truncated preview text: rejected because
  preview truncation would silently change the result.

## Probe

Test each registered profile, malformed and unfamiliar shapes, oversized text,
part limits, omitted content, sparse dataset fields and mixed records. Verify
page order and anchors after append, navigation and display-mode changes.
Use bounded adversarial arrays and category cardinality tests. Verify that
missing tokenizers and unspecified loss masks remain unknown. Static and
unit checks do not establish real-host visual or scrolling acceptance.

## Decision

Conversation is an alternate presentation of the Table workspace, sharing its
existing request and lifecycle path. A bounded message projection carries
actual text and source paths, with explicit truncation. The selected row still
opens the existing semantic, Tree, Raw, Derived and Bytes detail workflow.
Tool, reasoning and bookkeeping rows may use compact strips; they remain
physical records rather than invented conversation turns.
Conversation projections carry at most eight parts and 2,048 UTF-16 code units
of text in total. Hidden or encrypted blocks remain opaque. The receiver
validates fixed projection keys, role and label lengths, twelve path tokens
and eighty code units per path key; malformed optional projections cannot
enter presentation state. These limits are not a whole-message byte budget.

Dataset summaries contain fixed observations and bounded category values,
not copies of prompts or responses. Analysis distinguishes observed token
array lengths from declared counts. Role and loss-weight counts describe only
inspected messages. Missing labels, targets, masks and media are reported with
their evidence and inspection limits; they are never inferred from filenames
or a model-specific training convention. Each aggregate declares its scope,
sample size and partial coverage. A visible-page aggregate cannot claim
whole-file completeness and does not inherit an unrelated aggregate toolbar
scope. JSONL framing and generic fallback remain unchanged.
Dataset summaries are optional on Generic row pages and are validated at the
transport boundary. The visible-page panel inspects at most 256 loaded rows,
stays hidden while a replacement page is pending and remains separate from
the independently requested file or filtered-view aggregate. Missing summaries
reduce coverage; they do not count as observations of an empty dataset.

The projection plan is orthogonal to physical query identity. New Webview row
requests state whether the current presentation needs conversation and dataset
scenes, and the engine echoes the page's available capabilities. Table pages
omit both scenes, Conversation pages request only conversation scenes, and
visible Generic Insights table pages may request dataset scenes for the
sample panel; the separate full or filtered Insights aggregation requests no
display scenes and consumes only profile-projected fields. A display switch
reissues the current bounded viewport through the existing query controller,
preserving its anchor, predicate, filters, row types, sort and pagination state.
It does not create a second query owner. Engine callers that omit the plan retain
the historical projection defaults; pages from that contract without capability
metadata are interpreted using those defaults.

If a projection refresh fails, the physical page and selected record remain
usable, missing dataset scenes stay hidden rather than appearing as zero
observations, and the same failed intent is not retried in a render loop. A
new view intent can retry through the existing correlated request lifecycle.
The metadata is additive and does not require a protocol version change.

The compact workspace uses a primary row for tabs, status and profile controls
and a second row for query and projection controls. Temporary provenance and
Save As remain accessible at narrow widths. Host theme tokens own color and
focus; density changes must not remove keyboard or screen-reader access.

## Evidence

The existing bounded row/detail contracts, ADR-017, ADR-018, ADR-045 and
ADR-046 provide the lifecycle and query boundaries. Dataset shape conventions
are checked against the official
[LLaMA-Factory data guide](https://github.com/hiyouga/LLaMA-Factory/blob/main/data/README.md).
Implementation tests and host evidence are revision-specific and do not
transfer to a changed candidate.

## Boundary

This decision does not add a tokenizer, training runtime, dataset export,
automatic external-path traversal, complete-file statistics or a new query
language. Kimi storage recognition is a source-pinned profile adaptation, not
permission to execute a provider or replay destructive context operations.
No external validation workspace is a runtime or build dependency.

## Revisit Trigger

Revisit when measured page payloads exceed the transport budget, reading
anchors cannot be preserved, a provider changes storage format, or dataset
workloads justify an explicit independently budgeted aggregation operation.

## Rollback

Remove the request capability and page metadata together, restore legacy
projection defaults for all row requests, and retain the physical table,
generic fallback, row identity and full selected-record detail. The
metadata-only inspection path can remain independently if its own measurements
and tests continue to justify it. Discard disposable analysis projections;
source files are never modified.
