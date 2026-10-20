# ADR-055: Development Query Observation Tap

Status: accepted

## Pressure

The Webview CDP harness can observe a trusted page-control click, a committed
DOM transition, and bounded Extension Host GET_ROWS events. Its current
contract does not correlate the click with the protocol request ID, so it
cannot prove that the click caused that host query. Host counters and Webview
clocks are separate, and sending an unbounded diagnostic stream would change
the query path or retain source-adjacent data.

## Invariant

The source file, query result, cancellation gates, lifecycle ordering, and
production activation behavior remain unchanged. A diagnostic event is an
optional observation only. A failed or incomplete observation invalidates a
measurement; it never retries, blocks, or changes the query result.

## Owner

The extension cdp query tap module owns the development-only event projection,
allowlist, bounded delivery, and terminal failure state. extension.ts only
composes and disposes the tap. The external Harness owns CDP collection and
pairing; it does not become a product runtime dependency.

## Alternatives

- Instrument the Webview protocol: rejected because tap envelopes would enter
  the product message contract and expand the UI state surface.
- Write host events to Output or a file: rejected because it risks source,
  prompt, path, and raw event retention and cannot prove Webview receipt.
- Await the diagnostic send in GET_ROWS: rejected because measurement must not
  add a blocking dependency to the query path.

## Probe

The tap is enabled only when the Extension Host runs in development mode and
JSONLVIEW_CDP_QUERY_TAP is exactly 1. It accepts only validated
jsonlview.query.started and jsonlview.query.settled metadata for get_rows,
uses one in-flight message, an eight-event queue, and a 250 ms timeout. False,
rejected, thrown, timed-out, or overflowed delivery closes the tap. The CDP
consumer requires exactly one ordered pair with matching traceId, startupId,
and request_seq inside the bounded pager-click window, plus one adjacent page
transition settled over two animation frames. This is temporal co-occurrence
only; an unrelated query in that window can be paired with the DOM transition.

## Decision

Keep the tap in the Extension Host as a fixed, memory-only diagnostic
projection. Unknown attributes, unsafe identifiers, invalid terminal
combinations, and stale correlations are dropped or rejected before delivery.
The Harness records the consumer result as bounded temporal association and
sets causalAttribution to false. It must run a separately launched VS Code
process with run-owned user-data and extension directories and a synthetic
fixture only. It must retain aggregate timings without raw events, source
rows, paths, prompts, or target URIs. A future causal measurement requires an
end-to-end request identity or explicit intent correlation.

## Evidence

The focused host tap suite covers gating, allowlist projection, delivery
serialization, disposal, timeout, rejection, synchronous failure, false
delivery, and queue overflow. The focused CDP suite covers event-pair
identity and sequence checks, DOM settling, invalid envelopes, overflow,
late/out-of-window events, aggregate-only summaries, and an unrelated query
co-occurring with a page transition that remains explicitly non-causal. A
real-host receipt is required before making a latency or presentation claim;
tap-enabled timings are measurement-perturbed.

## Boundary

This change does not add a listener, network endpoint, persistence path,
provider adapter, protocol message, source mutation path, or production
instrumentation. postMessage(true) is treated as transport acceptance only;
the CDP receipt remains the proof of Webview observation. Extension Host and
Webview elapsed times stay in separate clock domains and are never subtracted.

## Revisit trigger

Revisit when the query event schema, VS Code Webview delivery contract, CDP
target/frame topology, host measurement requirement, or representative
workload gate changes. Revisit before enabling any non-development mode or
persisting diagnostic events.

## Rollback

Remove the tap construction and the Harness temporal-association mode, retaining
the existing query observer and page-navigation smoke mode. No source data,
index, or user configuration migration is required.
