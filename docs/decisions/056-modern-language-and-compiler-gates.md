---
id: "056-modern-language-and-compiler-gates"
path: "docs/decisions/056-modern-language-and-compiler-gates.md"
title: "Modern Language And Compiler Gates"
kind: "decision"
status: "accepted"
owner: "product"
tags: ["build","compiler","declarations","react","rust","typescript"]
evidence: []
revisit: "when language gates, compiler allowlists, native lifetime APIs, or benchmark triggers change"
rollback: "revert the coordinated language and compiler gate commits and invalidate affected receipts"
---
# ADR-056: Modern Language And Compiler Gates

Status: accepted

## Pressure

The product has a growing TypeScript and React surface plus a Rust 2024 native
core. Implicit declaration inference, non-erasable TypeScript syntax, and an
unmeasured React Compiler rollout can make a build appear green while leaving
the publish boundary unstable.

## Invariant

The Extension Host/Webview protocol, read-only source semantics, native ABI,
and existing query ordering remain unchanged. Compiler and language gates may
reject a candidate, but they do not change runtime behavior silently.

## Owner

Product TypeScript owns the source and declaration gates. Webview owns the
React Compiler allowlist and Activity budget. Native owns Rust 2024 lifetime
capture. Release tooling owns execution identity and candidate verification.

## Alternatives

- Enabling isolatedDeclarations for every test and legacy adapter was rejected
  because it hides the real publish boundary behind inferred declarations.
- Disabling the checks or adding broad any annotations was rejected because it
  preserves unstable contracts.
- Compiling every Webview file with React Compiler was rejected because the
  migration needs an allowlisted smoke boundary and measured regressions.

## Probe

check:typescript-erasable checks all product and experimental TypeScript
sources. check:typescript-tests checks tests with a separate test config.
check:typescript-gates emits declarations for the shared/presentation and
provider release boundary with isolatedDeclarations. The React Compiler is
opt-in through JSONLVIEW_REACT_COMPILER=1, limited to
src/webview/widgets/detail-drawer/ and src/webview/features/record-query/,
and covered by the Babel/esbuild smoke script. The DetailDrawer retains tab
state only for records at or below 1 MiB; larger or malformed lengths use
active-only rendering.

## Decision

Product source uses erasable TypeScript syntax: enums and parameter properties
are not permitted. Exported provider projections and event presentation models
have explicit contracts. Rust APIs use precise use<'input> capture where a
returned iterator borrows input. React useEffectEvent owns the stable external
window listener callback. useOptimistic remains out of the read-only source
path; optimistic state belongs only to a future host-confirmed mutation flow.
The React Compiler mode is part of execution identity, and its helper is an
identity input, so default and opt-in bundles cannot share a receipt.

## Evidence

The source, test, declaration, native, focused Webview, compiler smoke, default
build, and opt-in build gates are required. Compiler adoption removes one
manual useMemo only after the allowlisted smoke path passes; remaining memo
uses stay until a measured component-level comparison justifies their removal.

## Boundary

This record does not enable the compiler by default, add a runtime dependency
to the extension, introduce optimistic writes, or change native wire formats.
The test declaration config is not a public .d.ts contract. Rust resource-scope
guards remain a trigger for future shared-lock code, not a fabricated wrapper
around the current lock-free scanner.

## Revisit trigger

Revisit when the public provider surface expands, a new Webview subtree enters
the compiler allowlist, a shared native lock is introduced, or benchmark data
shows a material cold-scan or render regression. Enable mmap/SIMD or broader
compiler coverage only with a representative workload receipt.

## Rollback

Unset JSONLVIEW_REACT_COMPILER, remove the allowlist plugin registration, and
restore the previous execution-identity schema only in a coordinated artifact
and receipt migration. Revert the language-gate commits as one unit if a
release blocker is found; retain explicit provider contracts and the Rust API
tests when rolling back compiler experimentation.
