---
id: "051-v2-plane-boundaries-and-engineering-gates"
path: "docs/decisions/051-v2-plane-boundaries-and-engineering-gates.md"
title: "V2 Plane Boundaries and Engineering Gates"
kind: "decision"
status: "accepted"
owner: "product"
tags: ["architecture","evaluation","mcp","native","otel","rollback"]
evidence: []
revisit: "when a V2 plane boundary or capability gate changes"
rollback: "supersede ADR-051 with an explicit replacement and disable the affected capability"
---
# ADR-051: V2 Plane Boundaries and Engineering Gates

Status: accepted

## Pressure

The architecture notes propose sparse indexes, vectorized predicates, staged
PieceTree writes, CQRS, MCP, OTel, and richer Webview projections. Adopting all
of them at once would blur source authority and make performance claims
unverifiable.

## Invariant

JSONL bytes and absolute physical offsets remain authoritative. The default
product is read-only, bounded, generation-safe, and usable through the portable
engine when native, MCP, telemetry, or experimental projection paths fail.

## Decision

Adopt four orthogonal planes: physical facts, host control, semantic/UI
projection, and opt-in agentic boundaries. Use CQRS only to keep command and
query responsibilities explicit. Keep Rust as a bounded accelerator, generic
agent parsing as a bounded semantic adapter, and MCP as a host-owned read-only
facade until each later capability has its own contract and evidence.

## Alternatives

Rejected as current defaults: a mandatory microservice/BFF, a second event log,
an in-memory full-file model, automatic source mutation, a provider-wide
filesystem parser copied into the Webview, and unmeasured zero-copy or bitmap
claims.

## Probe and evidence

Native and projection changes require differential tests, bounded malformed and
oversized fixtures, cancellation and stale-generation tests, and resource
measurements. MCP and staging require allowlist, redaction, timeout, idempotency,
crash-recovery, and readback evidence. OTel exports require a zero-PII review
and cardinality budget.

## Boundary and rollback

The product checkout owns rules and contracts; external harnesses own raw
receipts, screenshots, and benchmark output. Disable a failed capability or
revert its scoped slice; never rewrite source files or promote a design input
to runtime behavior without a passing gate.
