---
id: "076-source-intake-stage"
path: "docs/decisions/076-source-intake-stage.md"
title: "Source Intake Stage and Explicit Actions"
kind: "decision"
status: "accepted"
owner: "product"
tags: ["navigator","intake","webview","lifecycle"]
evidence: ["source-contract:source-drop-view", "test-contract:source-drop-view", "test-contract:source-drop-html"]
revisit: "when native views support a whole-surface drop target with inline command buttons"
rollback: "remove the added intake view and restore the prior import picker while retaining Collections and temporary preview ownership"
---
# ADR-076: Source Intake Stage and Explicit Actions

## Pressure and invariant

Dragging is a gesture over a target, while Import and Paste are explicit
commands. A tiny Drop button misrepresents the gesture and narrows its target.
The native Collections tree must remain an independent metadata domain and
Agent Sessions must retain its authorization, direct-open and polling contract.

## Owner and decision

The sidebar WebviewView placement and its compact two-action card were
superseded by [ADR-086](086-import-canvas-and-toolbar-entrypoint.md). The
temporary-preview owner, input validation, and explicit authorization rules
below remain in force.

The native-tree-drop availability below was superseded by
[ADR-085](085-collections-reference-entrypoint.md), and the sidebar card
placement was superseded by ADR-086. The Collections tree no longer forwards
external drops to intake; the current drop surface is the editor-area Import
canvas.

This ADR initially placed a compact `jsonlView.sourceIntake` Webview View above
the two native trees. Its whole card received drop gestures, while Import and
Paste remained explicit actions. ADR-086 later moved that intake surface into
the editor area and removed its sidebar WebviewView. This record remains as the
history for bounded preview creation, native pickers and explicit source
authorization; its former placement and native-tree drop routes are superseded.

Rendering or resolving this view starts no source discovery, source scan,
clipboard read or source authorization. A browser File is read only after an
explicit drop, with size checked before and after the read and strict UTF-8
decoding. Host validation enforces the existing 1 MiB / 10,000 record JSONL
limits and exact text preservation through the existing session preview owner.
A single local URI uses the host's canonical local-source validator before
preview. A directory invokes the explicit folder picker. Remote, command,
symlink and oversized inputs do not become source permission. Files, Folder
and agent actions retain their existing permission and effective-settings checks.
Temporary previews do not register sources or add Collections membership.

One resolved view accepts one pending operation. Busy disables both actions and
rejects duplicate host requests; only a terminal host status restores the UI.
View disposal, resolve cancellation and provider disposal abort pending work
and suppress late messages. Selection results check cancellation before they
can authorize anything. Provider cleanup retains existing preview cleanup rules.
Failed message delivery is contained; errors render via textContent.

The card uses host theme tokens, explicit accessible button names and visible
keyboard focus. Container queries shorten English labels below 280px, hide the
secondary hint below 220px and remove the chevron below 170px. Forced colors and
reduced motion use their platform media queries. Product UI text remains English.

## Alternatives and compatibility

Retaining only native intake rows cannot express the selected full-card target
and two inline actions. Replacing Collections with a custom Webview tree would
add unrelated tree, keyboard, persistence and rendering ownership. A third Drop
button would duplicate a picker command. The added view keeps those costs out
of the existing native trees and uses the project's VS Code baseline.

The platform pattern follows Microsoft's [Webview View sample](https://github.com/microsoft/vscode-extension-samples/tree/main/webview-view-sample)
and [Webview guide](https://code.visualstudio.com/api/extension-guides/webview).
No dependencies, parser rules, source limits, persistence schema or native
accelerator behavior change.

## Probe, evidence and boundary

Focused tests cover strict message shape and limits, duplicate requests,
cancel/close/dispose, delayed or failed previews, UTF-8 and byte limits, drag
depth, accessible actions and picker cancellation. Browser acceptance checks
the generated product HTML at narrow/wide widths, including theme/focus and
button overflow. Mocked host tests cannot prove OS drag payloads or native
picker appearance; those require separate real-host observation. Build and
source tests do not assert installed-package or release acceptance.

## Rollback and revisit

Remove the added view, controller and generated HTML; restore the prior picker
choices. Retain Collections metadata, authorized source settings and existing
preview ownership. Revisit if native views gain the selected layout capability
or real-host evidence shows that the additional view's height harms navigation.
