---
id: "057-module-review-budget-and-hotspot-governance"
path: "docs/decisions/057-module-review-budget-and-hotspot-governance.md"
title: "Module Review Budget And Hotspot Governance"
kind: "decision"
status: "accepted"
owner: "product"
tags: ["architecture","complexity","coupling","governance","refactoring"]
evidence: []
revisit: "when module-review signals, ownership boundaries, or CI enforcement changes"
rollback: "remove the report command and restore the previous review baseline without reverting product behavior"
---
# ADR-057: Module Review Budget And Hotspot Governance

Status: accepted

## Pressure

The product contains large engine, extension, provider, and Webview modules.
Large files are expensive to review, but line count alone does not prove a
Single Responsibility Principle violation. A stable composition root may be
large and coherent, while a smaller adapter can have several independent
reasons to change and a dangerous dependency direction.

## Invariant

Module review is a triage and change-control mechanism. It must not rewrite
runtime behavior, infer ownership from a filename, or force a split solely to
meet a line threshold. A refactor is accepted only when it makes change
reasons, side-effect ownership, dependency direction, and rollback boundaries
clearer while preserving the public facade and observable behavior.

## Owner

The owning product layer remains responsible for its contracts: engine owns
bounded reads and query state, extension owns lifecycle and IPC, profiles own
semantic adapters, Webview owns presentation, and shared owns protocol/value
contracts. The module-review report is owned by product engineering and is
read-only until a task explicitly authorizes a refactor slice.

## Signals

`size` is a review-cost proxy. The report combines it with changed lines and
recent commit count (change pressure), direct fan-in/fan-out (coupling), AST
function shape and branch count (local complexity), and a declared boundary
sensitivity for each product layer. These signals produce a bounded priority
score for ordering human review; they are not a substitute for a design
review, a proof of cohesion, or a cognitive-complexity standard.

The review question is: “Are there independent change reasons or side-effect
owners that can be given a stable contract?” The design questions are then
SRP (change reasons), OCP (new variants versus stable policy), and DIP
(dependency direction through ports). A high score schedules review; it does
not prescribe the extraction seam.

## Decision

`scripts/module-review.mjs` is the first, non-mutating implementation. It
parses TypeScript/JS with the repository parser, records file bytes and lines,
function and branch signals, relative import fan-in/fan-out, recent churn, and
changed lines from committed, staged, and working-tree diffs. It emits a
human-readable ranking or a versioned JSON report.

The report uses two modes:

1. `--all` gives a periodic whole-source inventory for architecture review.
2. `--base <revision> --head <revision> --no-worktree` gives a reproducible
   CI/PR comparison. Local runs include staged, unstaged, and untracked source
   by default so a developer cannot accidentally omit a new module from review.

Historical debt is visible but is not automatically rejected. Future
enforcement must be incremental: new files and changed files may not increase
their measured budget without an owner, reason, expiry, and rollback path.
The existing ADR-014/035/039 facade and vertical-slice rules remain the
authority for deciding whether a file should be split.

## Probe

Run `pnpm review:modules` before an architecture task and attach the JSON
report to the task package when the review is part of a release or migration.
For a candidate revision, use the explicit base/head form and record the
revision, command, and report hash in the harness. A report is not release
evidence by itself; focused tests, type gates, dependency checks, and the
relevant host or Webview smoke test remain required.

## Boundary

This decision does not add a runtime dependency, alter the Extension
Host/Webview protocol, or require a package split. CSS remains governed by its
selector ownership, import-order, hash, and visual tests; it is not split by
the same numeric thresholds. Type-only import cycles are reported as coupling
signals but are not treated as runtime cycles without runtime evidence.

## Revisit trigger

Revisit when the parser, dependency graph, complexity model, CI base/head
contract, or layer ownership changes. Add a hard budget only after fixture
coverage proves clean, dirty, staged, untracked, and base/head behavior and a
ratchet can distinguish legacy debt from new regressions.

## Rollback

Remove the report command and configuration, or disable its CI invocation,
without changing product source. Retain prior reports as historical harness
evidence. A failed refactor slice is rolled back independently by restoring
the stable facade and its characterization tests.
