---
id: "086-import-canvas-and-toolbar-entrypoint"
path: "docs/decisions/086-import-canvas-and-toolbar-entrypoint.md"
title: "Import Canvas and Collections Toolbar Entrypoint"
kind: "decision"
status: "accepted"
owner: "product"
tags: ["navigator", "intake", "webview-panel", "drag-and-drop"]
evidence: ["source:src/experimental/session-navigator/source-drop-html.ts", "source:src/experimental/session-navigator/source-drop-view.ts", "source:src/experimental/session-navigator/tree-provider.ts", "test/experimental/source-drop-html.test.ts", "test/experimental/source-drop-view.test.ts"]
revisit: "after real Windows Explorer drag acceptance and when a supported modal extension surface becomes available"
rollback: "restore the sidebar intake view and its title placement while retaining the bounded preview and authorization owners"
---
# ADR-086: Import Canvas and Collections Toolbar Entrypoint

## Pressure and invariant

Dragging a file from Windows Explorer into the narrow Add Source sidebar card
did not produce a reliable intake gesture. The entire card competed with a
small nested webview area and the two compact actions. Move the drop target to
the editor area while keeping sidebar Collections immediately available.

Source selection, read-only authorization, temporary preview and Collections
membership remain different operations. Opening the canvas does not inspect or
authorize paths, scan a source, read the clipboard, alter source bytes or file a
reference.

## Owner and decision

The native Collections title exposes an Import codicon command before New
Collection. Its command opens one reusable `jsonlView.sourceImportCanvas`
WebviewPanel in `ViewColumn.Active`. Remove the `jsonlView.sourceIntake`
WebviewView from the Activity Bar container so Collections is the first view.
Agent Sessions retains its native Add Source action.

The canvas centers a wide intake surface in the editor area and exposes Choose
files, Choose folder and Paste JSONL. Its whole document accepts one dropped
JSONL or NDJSON file. File and folder buttons call the existing native picker
and explicit source authorization flow. Dropping a local URI runs the existing
canonical path validation and creates only a bounded temporary preview.
Dropping a browser File remains limited to 1 MiB, strict UTF-8 and existing
JSONL validation. Multiple files use Choose files. Paste opens an inline text
editor and creates a temporary preview only after explicit submission; it
never reads the clipboard automatically. Save As remains the separate action
for a durable copy.

After the preview editor opens, publish the successful Import status before
offering a native Save As or Keep Temporary Only choice. The notification is
independent of the canvas operation and other previews. Identify Recent Previews
as recovery for the current VS Code session; saving and Collection filing are
separate choices. A late choice after intake cancellation does not start a save.

The window API offers editor-area `WebviewPanel` placement; it does not expose
a third-party extension overlay that dims the previous workbench surface. The
centered canvas uses the available editor area and keeps VS Code's panel tab and
close behavior. It does not claim the screenshot's dimmed backdrop is a native
modal.

One panel accepts one pending operation. Closing it aborts a picker operation
and suppresses late results. The existing preview and authorized-source owners
retain their validation, cancellation and cleanup contracts. Importing a file
does not automatically add it to a Collection; the user separately chooses an
authorized identity through Add Existing Reference.

This supersedes the sidebar-view placement in [ADR-076](076-source-intake-stage.md)
and the sidebar-card retention clause in
[ADR-085](085-collections-reference-entrypoint.md). The decision to keep
temporary preview, Add Source authorization and Collections membership separate
is unchanged.

## Alternatives

The sidebar card remains too small for the Windows Explorer gesture that failed
acceptance. An editor-area panel expands the file-drop target and gives the
three explicit actions room without changing the native trees. A native modal
overlay is not available on the Extension API surface. Automatically filing a
dropped file into a selected or default Collection would combine source
ingestion and metadata mutation, so membership remains an explicit second step.

## Probe, evidence and boundary

Source and unit checks cover toolbar contribution ordering, removal of the
sidebar WebviewView, the three accessible actions, the wide drop surface,
file/URI/paste message bounds, source authorization routing, temporary preview
ownership, single-flight operation and cancellation after panel disposal.
These checks do not prove that a real Explorer gesture reaches the VS Code
Webview on this workstation. That remains a separate host-acceptance step.

## Revisit and rollback

Revisit after testing Explorer drag-over and drop on the real host, especially
when the webview is narrow or overlapped by another editor group. If the host
still loses the gesture, retain the three explicit actions and inspect the
platform data-transfer route before adding another import mechanism. Roll back
the title command, panel and contribution removal together; preview files,
source settings, Collections metadata and accepted journal commands stay under
their existing owners.
