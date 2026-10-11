import { describe, expect, it, vi } from 'vitest';
import { LoadRecordPage, type RecordPageRequest } from '../../../src/application';
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
});
