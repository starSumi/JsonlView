import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '../../src/shared/types';
import { validateWebviewRequest } from '../../src/extension/message-validation';

function envelope(type: string, payload: Record<string, unknown>): Record<string, unknown> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type,
    documentId: 'document',
    generation: 'generation',
    requestId: 'request',
    payload,
  };
}

describe('webview message validation', () => {
  it('accepts a bounded rows request', () => {
    const result = validateWebviewRequest(envelope('GET_ROWS', { limit: 100 }));
    expect(result.ok).toBe(true);
  });

  it('accepts nested record columns but rejects forged and oversized projections', () => {
    const path = { tokens: [{ kind: 'key', value: 'message' }, { kind: 'key', value: 'role' }] };
    const column = { id: JSON.stringify(path.tokens), label: '$.message.role', path, source: 'record' };
    expect(validateWebviewRequest(envelope('GET_ROWS', { limit: 20, columns: [column] })).ok).toBe(true);
    expect(validateWebviewRequest(envelope('GET_ROWS', {
      limit: 20,
      columns: [{ ...column, id: 'profile.status' }],
    })).ok).toBe(false);
    expect(validateWebviewRequest(envelope('GET_ROWS', {
      limit: 20,
      columns: [{ ...column, source: 'profile' }],
    })).ok).toBe(false);
    expect(validateWebviewRequest(envelope('GET_ROWS', {
      limit: 20,
      columns: Array.from({ length: 65 }, () => column),
    })).ok).toBe(false);
  });

  it('accepts only the two physical row-order preferences', () => {
    expect(validateWebviewRequest(envelope('SET_ROW_ORDER', { direction: 'desc' })).ok).toBe(true);
    expect(validateWebviewRequest(envelope('SET_ROW_ORDER', { direction: 'random' })).ok).toBe(false);
  });

  it('accepts bounded sorted rows and rejects an offset without sort', () => {
    expect(validateWebviewRequest(envelope('GET_ROWS', {
      limit: 100,
      sort: { columnId: 'status', direction: 'desc' },
      sortOffset: '100',
    })).ok).toBe(true);
    expect(validateWebviewRequest(envelope('GET_ROWS', {
      limit: 100,
      sortOffset: '100',
    })).ok).toBe(false);
    expect(validateWebviewRequest(envelope('GET_ROWS', {
      limit: 100,
      sort: { columnId: 'status', direction: 'asc' },
      sortOffset: '2000',
    })).ok).toBe(false);
  });

  it.each([
    ['__ordinal', 'asc'],
    ['__ordinal', 'desc'],
    ['$ordinal', 'asc'],
    ['$ordinal', 'desc'],
  ])('accepts physical ordinal %s %s pages beyond the field-sort window', (columnId, direction) => {
    for (const sortOffset of ['2000', '100000', '9007199254740993']) {
      expect(validateWebviewRequest(envelope('GET_ROWS', {
        limit: 100,
        sort: { columnId, direction },
        sortOffset,
      })).ok).toBe(true);
    }
  });

  it.each(['-1', '1.5', '02000', '2e3', 2000])(
    'rejects malformed physical ordinal offset %s',
    (sortOffset) => {
      expect(validateWebviewRequest(envelope('GET_ROWS', {
        limit: 100,
        sort: { columnId: '__ordinal', direction: 'desc' },
        sortOffset,
      })).ok).toBe(false);
    },
  );

  it('accepts bounded scan allowances and rejects unsafe combinations', () => {
    expect(validateWebviewRequest(envelope('GET_ROWS', {
      limit: 100,
      predicate: { op: 'text_search', value: 'needle', caseSensitive: false },
      scanBudget: { maxExaminedRecords: 1000, maxExaminedBytes: '65536' },
    })).ok).toBe(true);
    expect(validateWebviewRequest(envelope('GET_ROWS', {
      limit: 100,
      scanBudget: { maxExaminedRecords: 0 },
    })).ok).toBe(false);
    expect(validateWebviewRequest(envelope('GET_ROWS', {
      limit: 100,
      scanBudget: { maxExaminedBytes: 'not-a-number' },
    })).ok).toBe(false);
    expect(validateWebviewRequest(envelope('GET_ROWS', {
      limit: 100,
      sort: { columnId: 'status', direction: 'asc' },
      anchorOrdinal: '10',
    })).ok).toBe(false);
  });

  it('accepts profile text and presence predicates', () => {
    expect(validateWebviewRequest(envelope('GET_ROWS', {
      limit: 10,
      predicate: {
        op: 'and',
        args: [
          { op: 'profile_text', field: 'summary', cmp: 'contains', value: 'error', caseSensitive: false },
          { op: 'profile_exists', field: 'status' },
        ],
      },
    })).ok).toBe(true);
  });

  it('rejects an oversized page', () => {
    const result = validateWebviewRequest(envelope('GET_ROWS', { limit: 10_000 }));
    expect(result.ok).toBe(false);
  });

  it('rejects deeply nested query predicates', () => {
    let predicate: unknown = {
      op: 'text_search',
      value: 'needle',
      caseSensitive: false,
    };
    for (let index = 0; index < 20; index += 1) {
      predicate = { op: 'not', arg: predicate };
    }
    const result = validateWebviewRequest(envelope('GET_ROWS', { limit: 100, predicate }));
    expect(result.ok).toBe(false);
  });

  it('accepts bounded insight requests and rejects unknown dimensions', () => {
    expect(validateWebviewRequest(envelope('GET_INSIGHTS', {
      dimension: 'eventKind',
      predicate: { op: 'text_search', value: 'error', caseSensitive: false },
    })).ok).toBe(true);
    expect(validateWebviewRequest(envelope('GET_INSIGHTS', { dimension: 'arbitrary' })).ok).toBe(false);
  });

  it('accepts bounded problem continuation and rejects an unsafe problem budget', () => {
    expect(validateWebviewRequest(envelope('GET_PROBLEMS', {
      limit: 50,
      anchorOrdinal: '1024',
      direction: 'forward',
      scanBudget: { maxExaminedRecords: 1000, maxExaminedBytes: '65536' },
    })).ok).toBe(true);
    expect(validateWebviewRequest(envelope('GET_PROBLEMS', {
      limit: 50,
      scanBudget: { maxExaminedRecords: 0 },
    })).ok).toBe(false);
  });
});
