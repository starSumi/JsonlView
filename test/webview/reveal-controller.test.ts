import { describe, expect, it } from 'vitest';
import { WebviewRevealController, hasVisibleRevealTarget } from '../../src/webview/features/record-query/reveal-controller';
import { PROTOCOL_VERSION, type ExtensionMessage, type RowPage } from '../../src/shared/types';
import type { RevealAckPayload } from '../../src/shared/protocol/reveal';

function wire(requestId = 'reveal-1'): Extract<ExtensionMessage, { type: 'REVEAL' }> {
  return { protocolVersion: PROTOCOL_VERSION, type: 'REVEAL', documentId: 'doc', generation: 'g', epoch: 1,
    requestId, payload: { sourceId: 'src', generation: 'g', nativeId: 'event', anchorOrdinal: '42' } };
}
function fixture(local = false) {
  const acks: { requestId: string; payload: RevealAckPayload }[] = [];
  let loads = 0;
  const controller = new WebviewRevealController({
    getSession: () => ({ documentId: 'doc', generation: 'g', epoch: 1 }),
    isLocal: () => local,
    load: () => `rows-${++loads}`,
    acknowledge: (message, payload) => { acks.push({ requestId: message.requestId, payload }); },
    onChange: () => undefined,
  });
  return { controller, acks, get loads() { return loads; } };
}
const page = (ordinals: string[], scan?: RowPage['scan']): RowPage => ({ rows: ordinals.map((ordinal) => ({
  ref: { generation: 'g', ordinal, byteStart: '0', byteEndExclusive: '2', contentByteLength: '1', delimiterByteLength: 1, parseState: 'valid' }, cells: [], genericSummary: '' })),
  columns: [], anchorOrdinal: '42', hasBefore: true, hasAfter: false, indexedRecords: '100', totalRecords: '100', ...(scan === undefined ? {} : { scan }) });

describe('virtual reveal lifecycle', () => {
  it('keeps a reveal alive through unrelated request failures but retires its failed page', () => {
    const test = fixture(); test.controller.begin(wire());
    test.controller.requestFailed('detail-1', 'DETAIL_FAILED');
    expect(test.acks).toEqual([]);
    test.controller.requestFailed('rows-1', 'PAGE_FAILED');
    expect(test.acks[0]?.payload.outcome).toBe('stale');
    const local = fixture(true); local.controller.begin(wire());
    local.controller.requestFailed('detail-2', 'DETAIL_FAILED');
    local.controller.rendered('reveal-1', '42');
    expect(local.acks[0]?.payload.outcome).toBe('shown');
  });
  it('fetches a missing page and waits for a matching DOM observation', () => {
    const test = fixture(); test.controller.begin(wire());
    expect(test.loads).toBe(1); expect(test.acks).toEqual([]);
    test.controller.rowsAccepted('unrelated', page(['42']));
    expect(test.controller.target).toBeUndefined();
    test.controller.rowsAccepted('rows-1', page(['42']));
    expect(test.controller.target?.requestId).toBe('reveal-1');
    test.controller.rendered('reveal-other', '42'); expect(test.acks).toEqual([]);
    test.controller.rendered('reveal-1', '42');
    expect(test.acks).toEqual([{ requestId: 'reveal-1', payload: { outcome: 'shown', anchorOrdinal: '42', renderedOrdinal: '42' } }]);
    expect(test.controller.target).toBeUndefined();
  });

  it('does not label an unexamined or uninspectable missing row filtered-out', () => {
    const test = fixture(); test.controller.begin(wire());
    test.controller.rowsAccepted('rows-1', page([], { examinedRecords: '0', examinedBytes: '0', truncatedReason: 'byte_limit' }));
    expect(test.acks).toEqual([{ requestId: 'reveal-1', payload: { anchorOrdinal: '42', outcome: 'not-found' } }]);
  });

  it('reports filtered-out only when the physical target was examined and skipped', () => {
    const test = fixture(); test.controller.begin(wire());
    test.controller.rowsAccepted('rows-1', page(['43']));
    expect(test.acks[0]?.payload).toEqual({ anchorOrdinal: '42', outcome: 'filtered-out' });
  });

  it('ignores old fetches and DOM observations after a newer reveal', () => {
    const test = fixture(); test.controller.begin(wire()); test.controller.begin(wire('reveal-2'));
    test.controller.rowsAccepted('rows-1', page(['42'])); test.controller.rendered('reveal-1', '42');
    expect(test.acks).toEqual([]);
    test.controller.rowsAccepted('rows-2', page(['42'])); test.controller.rendered('reveal-2', '42');
    expect(test.acks.map((item) => item.requestId)).toEqual(['reveal-2']);
  });

  it('uses the current loaded row without issuing another fetch and retires on invalidation', () => {
    const test = fixture(true); test.controller.begin(wire());
    expect(test.loads).toBe(0); expect(test.controller.target).toBeDefined();
    test.controller.invalidate(); test.controller.rendered('reveal-1', '42');
    expect(test.acks[0]?.payload.outcome).toBe('stale'); expect(test.acks).toHaveLength(1);
  });
});

describe('DOM visibility evidence', () => {
  const bounds = { top: 0, bottom: 100, left: 0, right: 100, width: 100, height: 100 };
  it('requires a mounted nonzero target intersecting the visible content viewport', () => {
    expect(hasVisibleRevealTarget(bounds, { ...bounds, top: 120, bottom: 150, height: 30 }, false)).toBe(false);
    expect(hasVisibleRevealTarget(bounds, { ...bounds, top: 10, bottom: 30, height: 20 }, false)).toBe(true);
    expect(hasVisibleRevealTarget(bounds, { ...bounds, top: 10, bottom: 30, height: 20 }, true)).toBe(false);
    expect(hasVisibleRevealTarget(bounds, { ...bounds, height: 0 }, false)).toBe(false);
    expect(hasVisibleRevealTarget(bounds, { ...bounds, left: 100, right: 120 }, false)).toBe(false);
  });
});
