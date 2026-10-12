# Incident Review and Postmortem Contract

## Scope and owner

Product engineering owns the response contract for failures in the extension,
Webview, parser, native boundary, build, or release gates. This document is a
stable policy for learning and corrective action. It is not an incident log.

## Required review fields

Every material incident review records in a separately governed evidence
workspace: impact and affected boundary; detection signal and time-bounded
timeline; contributing conditions and root cause; why existing tests or gates
did not stop or expose it; corrective and preventive actions; rollback or
containment evidence; and an immutable receipt with revision, artifact identity,
and digest.

Reviews are blameless. They describe system conditions and decisions rather
than assigning personal fault. A postmortem instance may contain private paths,
raw logs, screenshots, or customer data only in the access-controlled evidence
workspace; none of that is product source, runtime input, public ADR, or package
file.

## Closure and recurrence

An action is closed only when the owning test, gate, documentation, or runtime
control is present and independently verified. Repeated incidents update the
relevant decision record or threat model with a stable invariant and rollback
rule. The product repository stores the policy and resulting source/test
changes; the evidence workspace stores the incident instance and receipt.
