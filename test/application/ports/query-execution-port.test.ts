import { describe, expect, it, vi } from 'vitest';
import {
  createQueryExecutionRequestV1,
  QueryExecutionPort,
  QueryExecutionSourceError,
  QueryExecutionUnsupportedError,
  type QueryExecutionSourceV1,
} from '../../../src/application';
import type { RecordPageRequest } from '../../../src/application';
import type { RowPage } from '../../../src/shared/types';

const source = {
  sourceId: 'source-1',
  documentId: 'document-1',
  generation: 'generation-1',
  epoch: 2,
  fingerprint: 'fingerprint-1',
} as const;

const page: RowPage = {
  rows: [],
  columns: [],
  anchorOrdinal: '0',
  hasBefore: false,
  hasAfter: false,
  indexedRecords: '0',
};

function request(overrides: Partial<RecordPageRequest> = {}) {
  return createQueryExecutionRequestV1(source, 'request-1', {
    limit: 10,
    columns: [],
    ...overrides,
  }, 1_000);
}

function sourceWith(reader: QueryExecutionSourceV1['recordPage']): QueryExecutionSourceV1 {
  return { identity: source, recordPage: reader };
}

describe('QueryExecutionPort', () => {
  it('lowers the versioned AST through the existing record-page reader', async () => {
    const getRows = vi.fn().mockResolvedValue(page);
    const port = new QueryExecutionPort(() => sourceWith({ getRows }));
    const query = request({
      predicate: { op: 'text_search', value: 'needle', caseSensitive: false },
      anchorOrdinal: '4',
      direction: 'forward',
    });

    const result = await port.execute(query, new AbortController().signal);

    expect(result.target).toBe('record-page');
    expect(result.settlement.status).toBe('completed');
    expect(getRows).toHaveBeenCalledWith({
      limit: 10,
      columns: [],
      anchorOrdinal: '4',
      direction: 'forward',
      predicate: { op: 'text_search', value: 'needle', caseSensitive: false },
    }, expect.any(AbortSignal));
  });

  it('maps a portable scan truncation into a status-consistent settlement', async () => {
    const port = new QueryExecutionPort(() => sourceWith({
      getRows: vi.fn().mockResolvedValue({ ...page, scan: {
        examinedRecords: '10', examinedBytes: '100', cursorOrdinal: '9', truncatedReason: 'byte_limit',
      } }),
    }));
    const result = await port.execute(request(), new AbortController().signal);
    expect(result.settlement).toMatchObject({
      status: 'truncated',
      truncation: { reason: 'byte_limit', nextOrdinal: '9' },
    });
  });

  it('fails closed for a stale source and for an uninstalled raw target', async () => {
    const port = new QueryExecutionPort(() => undefined);
    await expect(port.execute(request(), new AbortController().signal))
      .rejects.toBeInstanceOf(QueryExecutionSourceError);

    const rawUnsupported = new QueryExecutionPort(() => sourceWith({ getRows: vi.fn() }));
    await expect(rawUnsupported.execute({ ...request(), target: 'raw-records' }, new AbortController().signal))
      .rejects.toBeInstanceOf(QueryExecutionUnsupportedError);
  });
});
