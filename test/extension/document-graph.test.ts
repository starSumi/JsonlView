import { describe, expect, it, vi } from 'vitest';
import { DocumentGraphController } from '../../src/extension/document-graph';
import { JsonlEngineError } from '../../src/engine';
import type { DocumentSummary, RowPage } from '../../src/shared/types';

function fixture() {
  let summary = { snapshot: { documentId: 'doc', generation: 'g', epoch: 1 }, profileId: 'generic',
    profileVersion: 'v', profileEpoch: 1, indexingComplete: true } as DocumentSummary;
  let authorized = true; let observed = true;
  const ref = { generation: 'g', ordinal: '0', byteStart: '0', byteEndExclusive: '2', contentByteLength: '2', delimiterByteLength: 1 as const, parseState: 'valid' as const };
  const page: RowPage = { rows: [{ ref, cells: [], genericSummary: 'source row' }], columns: [], anchorOrdinal: '0', hasBefore: false,
    hasAfter: false, indexedRecords: '1', totalRecords: '1' };
  const read = vi.fn(async (_signal: AbortSignal) => page);
  const observe = vi.fn(async () => observed);
  const graph = new DocumentGraphController({ getSummary: () => summary, getGraphRows: read,
    validateObservedSource: observe }, () => authorized);
  return { graph, ref, read, observe, revoke: () => { authorized = false; }, changeSource: () => { observed = false; },
    changeProfile: () => { summary = { ...summary, profileEpoch: 2 }; } };
}
describe('host document graph issuance and authorization', () => {
  it('reports a changed source during a queued Graph read as stale without issuing references', async () => {
    const f = fixture();
    f.read.mockRejectedValueOnce(new JsonlEngineError('SOURCE_CHANGED', 'source changed'));
    const reply = await f.graph.load('changed', new AbortController().signal);
    expect(reply.status).toBe('stale');
    expect(reply.graph.snapshot.nodes).toEqual([]);
    expect(f.graph.publish('changed', reply)).toBe(false);
    expect(await f.graph.resolve({ graphRequestId: 'changed', ref: f.ref })).toBeUndefined();
  });
  it.each([true, false])('does not let a superseded reveal observation (%s) invalidate a newer publication', async (observation) => {
    const f = fixture();
    const first = await f.graph.load('first', new AbortController().signal);
    expect(f.graph.publish('first', first)).toBe(true);
    let finish!: (valid: boolean) => void;
    f.observe.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const oldReveal = f.graph.resolve({ graphRequestId: 'first', ref: f.ref });
    const second = await f.graph.load('second', new AbortController().signal);
    expect(f.graph.publish('second', second)).toBe(true);
    const current = await f.graph.resolve({ graphRequestId: 'second', ref: f.ref });
    expect(current?.isCurrent()).toBe(true);
    finish(observation);
    expect(await oldReveal).toBeUndefined();
    expect(current?.isCurrent()).toBe(true);
    expect(await f.graph.resolve({ graphRequestId: 'second', ref: f.ref })).toBeDefined();
  });
  it('issues only delivered current refs and rejects forged coordinates/request IDs', async () => {
    const f = fixture(); const reply = await f.graph.load('r1', new AbortController().signal);
    expect(await f.graph.resolve({ graphRequestId: 'r1', ref: f.ref })).toBeUndefined();
    expect(f.graph.publish('r1', reply)).toBe(true);
    expect(await f.graph.resolve({ graphRequestId: 'other', ref: f.ref })).toBeUndefined();
    expect(await f.graph.resolve({ graphRequestId: 'r1', ref: { ...f.ref, byteStart: '1' } })).toBeUndefined();
    expect(await f.graph.resolve({ graphRequestId: 'r1', ref: f.ref })).toMatchObject({ target: { sourceId: 'doc', anchorOrdinal: '0' } });
  });
  it('fails closed after authorization, source or profile changes before publication/reveal', async () => {
    for (const change of ['revoke', 'changeSource', 'changeProfile'] as const) {
      const f = fixture(); const reply = await f.graph.load('r1', new AbortController().signal);
      f[change]();
      if (change !== 'changeSource') expect(f.graph.publish('r1', reply)).toBe(false);
      else f.graph.publish('r1', reply);
      expect(await f.graph.resolve({ graphRequestId: 'r1', ref: f.ref })).toBeUndefined();
    }
  });
  it('drops a delayed background result after a profile switch and clears prior issued refs', async () => {
    const f = fixture(); const first = await f.graph.load('first', new AbortController().signal); f.graph.publish('first', first);
    let finish!: (page: RowPage) => void;
    f.read.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const next = f.graph.load('next', new AbortController().signal);
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(2));
    f.changeProfile(); f.graph.invalidate();
    finish({ rows: [], columns: [], anchorOrdinal: '0', hasBefore: false, hasAfter: false, indexedRecords: '0', totalRecords: '0' });
    expect((await next).graph.snapshot.nodes).toHaveLength(0);
    expect(await f.graph.resolve({ graphRequestId: 'first', ref: f.ref })).toBeUndefined();
  });
});
