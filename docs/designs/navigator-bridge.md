---
id: "navigator-bridge"
path: "docs/designs/navigator-bridge.md"
title: "Navigator Bridge in Record Detail"
kind: "design"
status: "proposed"
owner: "product"
tags: ["accessibility","authorization","navigator","webview"]
evidence: []
revisit: "when the Host publishes Navigator authorization status"
rollback: "remove the bridge and retain the top-level Navigator action"
---
# Navigator bridge in the record detail

The record detail keeps its selected physical record as the primary surface.
Its secondary Navigator bridge delegates to the same Open Navigator action
used by the workspace header. It does not create a second command or replace
the JSONL editor route.

The Webview presents a fail-closed handoff state: disabled,
authorization-required, authorized, cancelled, or failed. A restored editor
starts at disabled and waits for a current Host readback before showing
authorized; the Webview state is never authorization evidence. The Host remains authoritative for
Navigator enablement, source authorization, and durable local registration;
the Webview must never infer authorization from a request being posted.

The command flow is:

1. When Navigator is disabled, Open Navigator focuses the left Navigator view
   and presents the explicit read-only authorization step.
2. When it is open but authorization is absent, the left view owns the consent
   action. Cancel or failure leaves the current detail and direct session/file
   open path unchanged.
3. Once the Host reads back durable authorization, the same control becomes a
   locate action for the corresponding source, session, or exact-file leaf. It
   does not repeat consent or enable query linkage.

The existing OPEN_SESSION_NAVIGATOR request is the only wire action used by
this Webview change. A future Host status response must be added through the
shared protocol owner before the UI can transition itself to authorized; until
then the UI labels the handoff as Host-owned.
