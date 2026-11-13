import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

const { pairQueryTemporalAssociation, summarizeQueryTemporalAssociation } = await import(
  fileURLToPath(new URL('../../scripts/query-temporal-association.mjs', import.meta.url)),
);

const startedEvent = {
    traceId: 'trace-a', startupId: 'startup-a', eventName: 'jsonlview.query.started',
    attributes: { stage: 'get_rows', request_seq: 12 },
};
const settledEvent = {
    traceId: 'trace-a', startupId: 'startup-a', eventName: 'jsonlview.query.settled',
    attributes: {
      stage: 'get_rows', request_seq: 12, outcome: 'completed', delivery: 'accepted',
      abort_observed: false, duration_ms: 17, rows: 100,
    },
};
const pair = () => [startedEvent, settledEvent];

const domTransition = {
  direction: 'next', fromPage: 1, toPage: 2, cursorFirstOrdinal: 100, mountedOrdinal: 100, webviewElapsedMs: 24.1254,
};

describe('CDP query temporal association', () => {
  it('associates a single host query with a committed DOM page transition without causal claims', () => {
    const sample = pairQueryTemporalAssociation({ events: pair(), domTransition });

    expect(sample).toEqual({
      association: 'bounded-temporal-co-occurrence-only', causalAttribution: false,
      direction: 'next', hostDurationMs: 17, webviewElapsedMs: 24.125,
    });
    expect(JSON.stringify(sample)).not.toContain('trace-a');
    expect(JSON.stringify(sample)).not.toContain('startup-a');
    expect(JSON.stringify(sample)).not.toContain('request_seq');
  });

  it('labels an unrelated but coincident host query as temporal-only', () => {
    const unrelatedQuery = pair().map((event) => ({ ...event, traceId: 'unrelated-query' }));
    const sample = pairQueryTemporalAssociation({ events: unrelatedQuery, domTransition });

    expect(sample.association).toBe('bounded-temporal-co-occurrence-only');
    expect(sample.causalAttribution).toBe(false);
  });

  it.each([
    ['overflow', { overflow: true }],
    ['out-of-window event', { outOfWindowEvents: 1 }],
    ['missing host event', { events: pair().slice(0, 1) }],
    ['duplicate host event', { events: [...pair(), pair()[1]] }],
    ['event limit overflow', { events: Array.from({ length: 9 }, () => pair()[0]) }],
    ['reversed host events', { events: [...pair()].reverse() }],
    ['sanitizer-invalid event envelope', { events: [{ ...startedEvent, invalid: true }, settledEvent] }],
    ['unexpected event envelope field', { events: [{ ...startedEvent, prompt: 'secret' }, settledEvent] }],
    ['transport marker leaked into event envelope', { events: [{ ...startedEvent, __jsonlViewCdpQueryTap: 1 }, settledEvent] }],
    ['unmatched trace identity', { events: [pair()[0], { ...pair()[1], traceId: 'other' }] }],
    ['unmatched request sequence', { events: [startedEvent, { ...settledEvent, attributes: { ...settledEvent.attributes, request_seq: 13 } }] }],
    ['unexpected attribute', { events: [startedEvent, { ...settledEvent, attributes: { ...settledEvent.attributes, uri: 'secret' } }] }],
    ['failed host query', { events: [startedEvent, { ...settledEvent, attributes: { ...settledEvent.attributes, outcome: 'failed', delivery: 'failed', error_name: 'Error' } }] }],
    ['missing DOM transition', { domTransition: undefined }],
    ['nonadjacent DOM transition', { domTransition: { ...domTransition, toPage: 3 } }],
  ])('fails closed for %s', (_name, override) => {
    const input = { events: pair(), domTransition, ...override };
    expect(() => pairQueryTemporalAssociation(input as Parameters<typeof pairQueryTemporalAssociation>[0]))
      .toThrow(/Query temporal association failed closed/);
  });

  it('summarizes host and Webview clocks separately without retaining samples', () => {
    const summary = summarizeQueryTemporalAssociation([
      pairQueryTemporalAssociation({ events: pair(), domTransition }),
      pairQueryTemporalAssociation({
        events: pair(),
        domTransition: { ...domTransition, direction: 'previous', fromPage: 2, toPage: 1, webviewElapsedMs: 30 },
      }),
    ]);

    expect(summary).toEqual({
      associatedSampleCount: 2,
      association: 'bounded-temporal-co-occurrence-only',
      causalAttribution: false,
      percentileMethod: 'nearest-rank',
      hostQueryDuration: { sampleCount: 2, minMs: 17, p50Ms: 17, p95Ms: 17, maxMs: 17 },
      webviewClickToDomSettle: { sampleCount: 2, minMs: 24.125, p50Ms: 24.125, p95Ms: 30, maxMs: 30 },
      clocks: { host: 'extension-host-performance.now', webview: 'window.performance.now' },
      presentationGuaranteed: false,
    });
    expect(JSON.stringify(summary)).not.toContain('trace-a');
    expect(JSON.stringify(summary)).not.toContain('rows');
  });
});
