import { describe, expect, it, vi } from 'vitest';
import { LoadRecordPage, RecordPageRequestError, type RecordPageRequest } from '../../../src/application';
import type { RowPage } from '../../../src/shared/types';

const request: RecordPageRequest = {
  limit: 25,
  anchorOrdinal: '12',
  direction: 'forward',
  columns: [],
};

const page = {
  rows: [],
  columns: [],
  snapshot: { generation: 'g1', documentId: 'doc-1' },
} as unknown as RowPage;

describe('LoadRecordPage', () => {
  it('delegates the bounded request and cancellation signal to the reader port', async () => {
    const signal = new AbortController().signal;
    const getRows = vi.fn<(request: RecordPageRequest, signal: AbortSignal) => Promise<RowPage>>()
      .mockResolvedValue(page);
    const useCase = new LoadRecordPage({ getRows });

    await expect(useCase.execute(request, signal)).resolves.toBe(page);
    expect(getRows).toHaveBeenCalledOnce();
    expect(getRows).toHaveBeenCalledWith(request, signal);
  });

  it('preserves reader failures for the transport boundary to classify', async () => {
    const failure = new Error('source changed');
    const useCase = new LoadRecordPage({
      getRows: vi.fn().mockRejectedValue(failure),
    });

    await expect(useCase.execute(request, new AbortController().signal)).rejects.toBe(failure);
  });

  const { anchorOrdinal: _anchor, direction: _direction, ...sortedBase } = request;
  it.each<[RecordPageRequest, string]>([
    [{ ...request, limit: 0 }, 'limit'],
    [{ ...request, limit: 501 }, 'limit'],
    [{ ...request, anchorOrdinal: '01' }, 'anchor'],
    [{ ...request, sortOffset: '1' }, 'sort offset'],
    [{ ...sortedBase, sort: { columnId: 'payload', direction: 'asc' }, sortOffset: '2040' }, 'sort window'],
    [{ ...request, columns: null as unknown as NonNullable<RecordPageRequest['columns']> }, 'null columns'],
    [{ ...request, columns: Array.from({ length: 65 }, () => ({ id: 'x', label: 'x', source: 'record' as const })) }, 'columns'],
  ])('rejects an unbounded %s request before invoking the reader', async (invalid, label) => {
    const getRows = vi.fn().mockResolvedValue(page);
    const useCase = new LoadRecordPage({ getRows });

    await expect(useCase.execute(invalid, new AbortController().signal))
      .rejects.toBeInstanceOf(RecordPageRequestError);
    expect(getRows).not.toHaveBeenCalled();
    expect(String(label)).toBeTruthy();
  });

  it('accepts a bounded scan budget and physical sort window', async () => {
    const getRows = vi.fn().mockResolvedValue(page);
    const useCase = new LoadRecordPage({ getRows });
    const bounded = {
      ...sortedBase,
      sort: { columnId: '__ordinal', direction: 'asc' as const },
      sortOffset: '900719925474099199',
      scanBudget: { maxExaminedRecords: 100, maxExaminedBytes: '1048576' },
    };

    await expect(useCase.execute(bounded, new AbortController().signal)).resolves.toBe(page);
    expect(getRows).toHaveBeenCalledWith(bounded, expect.any(AbortSignal));
  });
});
