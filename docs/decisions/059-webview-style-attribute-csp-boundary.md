---
id: "059-webview-style-attribute-csp-boundary"
path: "docs/decisions/059-webview-style-attribute-csp-boundary.md"
title: "Webview Style Attribute CSP Boundary"
kind: "decision"
status: accepted
owner: "product"
tags: ["security", "webview", "csp", "nonce"]
evidence: []
revisit: "when runtime style attributes are removed from the Webview render path"
rollback: "restore the previous CSP policy while retaining nonce-bound scripts and style elements"
---
# ADR-059: Webview Style Attribute CSP Boundary

## Pressure

The extension Webview already uses a per-document nonce for its diagnostic
bootstrap and bundled script, and the external stylesheet is restricted to the
extension Webview resource root. The rendered application still emits runtime
`style` attributes for virtualized row geometry, progress widths, and bounded
popover placement. CSP nonces authorize `style` elements; they do not authorize
arbitrary `style` attributes.

## Decision

Keep `style-src-attr 'unsafe-inline'` as an explicit, temporary exception in
the extension Webview policy. Keep `style-src-elem` resource-root constrained,
keep executable scripts nonce-bound, and do not broaden either directive to a
general `unsafe-inline` allowance. The exception applies only to the product's
runtime layout attributes and is not a license for HTML or script injection.

## Migration gate

The exception may be removed only after a source and host-rendering inventory
shows that all dynamic layout values have moved to authored classes or
controlled custom properties, with representative virtualized-table and
popover resize checks passing. The gate must verify both the generated CSP and
the rendered behavior; a text-only removal is insufficient because it can
silently collapse row positioning.

## Probe

`test/extension/webview-html.test.ts` asserts that scripts remain nonce-bound,
style elements remain resource-root constrained, and no broad script or style
`unsafe-inline` directive is introduced. A separate inventory of runtime style
attributes is required before changing the accepted exception.

## Boundary and rollback

This decision covers the extension-owned HTML shell only. It does not authorize
inline scripts, remote resources, or changes to the experimental Source Intake
documents. If a future migration regresses layout or CSP compatibility, restore
the last verified policy while retaining nonce-bound scripts and styles.
