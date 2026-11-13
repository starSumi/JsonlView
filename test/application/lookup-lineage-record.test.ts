import { describe, expect, it, vi } from 'vitest';
import { lookupLineageRecord, type LineageWindowReader } from '../../src/application/use-cases/lookup-lineage-record';
import { lineageEvidence as evidence, lineagePage as page, lineageRow as row, lineageSummary as summary } from '../support/lineage-fixtures';

describe('bounded lineage lookup use case', () => {
  const source = row(800, { parentId: 'target', evidence: [evidence('messageId', 'uuid'), evidence('parentId', 'parentUuid')] });
  const candidate = row(600, { messageId: 'target' });
  const signal = () => new AbortController().signal;
  function reader(rows = [candidate], reason?: 'byte_limit' | 'uninspectable_record' | 'record_limit'): LineageWindowReader {
    return { read: vi.fn(async (_start, _count, _deadline, _signal, progress) => {
      progress.examinedRecords = reason === 'record_limit' ? 500 : rows.length;
      progress.examinedBytes = '9'; progress.requestedBytes = 123;
      return { ...page(rows), scan: { examinedRecords: String(progress.examinedRecords), examinedBytes: '9', ...(reason === undefined ? {} : { truncatedReason: reason }) } };
    }) };
  }
  it('uses a preceding 500-record window and preserves exact candidate coordinates', async () => {
    const f = reader(); const result = await lookupLineageRecord(summary(), source, 'parent', f, signal());
    expect(f.read).toHaveBeenCalledWith('300', 500, expect.any(Number), expect.any(AbortSignal), expect.any(Object));
    expect(result).toMatchObject({ status: 'found', match: candidate, scope: { startOrdinal: '300', endOrdinalExclusive: '800', complete: true, requestedBytes: 123 } });
  });
  it('returns ambiguous for duplicate same-context candidates; other sessions and out-of-window coordinates cannot match', async () => {
    const duplicate = row(601, { messageId: 'target' });
    expect((await lookupLineageRecord(summary(), source, 'parent', reader([candidate, duplicate]), signal())).status).toBe('ambiguous');
    expect((await lookupLineageRecord(summary(), source, 'parent', reader([row(600, { messageId: 'target', sessionId: 'other' }), row(1, { messageId: 'target' })]), signal())).status).toBe('not-observed');
  });
  it.each(['byte_limit', 'uninspectable_record'] as const)('never accepts a candidate or claims absence from an incompletely inspected window: %s', async (reason) => {
    const result = await lookupLineageRecord(summary(), source, 'parent', reader([candidate], reason), signal());
    expect(result.status).toBe('budget-exceeded'); expect(result.match).toBeUndefined(); expect(result.scope.complete).toBe(false);
  });
  it('can settle a fully inspected bounded window at the record limit without implying whole-source absence', async () => {
    const result = await lookupLineageRecord(summary(), source, 'parent', reader([], 'record_limit'), signal());
    expect(result.status).toBe('not-observed'); expect(result.scope).toMatchObject({ startOrdinal: '300', complete: true });
  });
  it('preserves read quota and deadline errors as incomplete outcomes, and cancellation as cancellation', async () => {
    const f: LineageWindowReader = { read: async (_s, _c, _d, _signal, progress) => { progress.requestedBytes = 1_048_576; throw { code: 'READ_BUDGET_EXCEEDED' }; } };
    expect(await lookupLineageRecord(summary(), source, 'parent', f, signal())).toMatchObject({ status: 'budget-exceeded', scope: { requestedBytes: 1_048_576, complete: false } });
    const aborted = new AbortController(); aborted.abort(); const untouched = reader();
    await expect(lookupLineageRecord(summary(), source, 'parent', untouched, aborted.signal)).rejects.toThrow('cancelled');
    expect(untouched.read).not.toHaveBeenCalled();
  });
  it('searches forward for a Codex tool result, using exact context evidence rather than raw substring matching', async () => {
    const call = row(10, { profileId: 'codex-rollout', eventKind: 'tool_call', turnId: 'turn', toolCallId: 'id"with spaces', evidence: [evidence('toolCallId', 'payload', 'call_id')] });
    const result = row(11, { ...call.profile, eventKind: 'tool_result' }); const f = reader([result]);
    expect((await lookupLineageRecord({ ...summary(), profileId: 'codex-rollout' }, call, 'tool-partner', f, signal())).status).toBe('found');
    expect(f.read).toHaveBeenCalledWith('11', 500, expect.any(Number), expect.any(AbortSignal), expect.any(Object));
  });
  it('discards even a matching candidate when its scan settles after the cooperative deadline', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      const f = reader(); const read = f.read;
      f.read = async (...args) => { const result = await read(...args); now.mockReturnValue(2500); return result; };
      const result = await lookupLineageRecord(summary(), source, 'parent', f, signal());
      expect(result).toMatchObject({ status: 'timed-out', scope: { complete: false, requestedBytes: 123 } });
      expect(result.match).toBeUndefined();
    } finally { now.mockRestore(); }
  });
});
