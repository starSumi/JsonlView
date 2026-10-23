import { describe, expect, it } from 'vitest';
import {
  isQueryRequestDtoV1,
  parseQueryRequestDtoV1,
  serializeQueryRequestDtoV1,
  QUERY_DTO_SCHEMA,
  type QueryRequestDtoV1,
} from '../../src/shared/query-dto';

function request(overrides: Partial<QueryRequestDtoV1> = {}): QueryRequestDtoV1 {
  const requestId = 'query-1';
  return {
    schema: QUERY_DTO_SCHEMA,
    version: 1,
    requestId,
    source: { sourceId: 'source-1', documentId: 'doc-1', generation: 'generation-1', epoch: 3 },
    ast: { schema: 'jsonlview.query-ast.v1', version: 1 },
    cursor: {},
    budget: { limit: 100, maxBytes: '1048576', deadlineEpochMs: Date.now() + 5_000 },
    cancellation: { requestId },
    ...overrides,
  };
}

describe('versioned query DTO', () => {
  it('round-trips bounded request identity, AST, cursor, budget, and cancellation', () => {
    const value = request({
      ast: {
        schema: 'jsonlview.query-ast.v1',
        version: 1,
        predicate: { op: 'text_search', value: 'needle', caseSensitive: false },
      },
      cursor: { anchorOrdinal: '12', direction: 'forward' },
      budget: {
        limit: 20,
        maxBytes: '4096',
        maxExaminedRecords: 1000,
        maxExaminedBytes: '32768',
        deadlineEpochMs: Date.now() + 5_000,
      },
    });
    const now = Date.now();
    expect(isQueryRequestDtoV1(value, now)).toBe(true);
    expect(parseQueryRequestDtoV1(serializeQueryRequestDtoV1(value, now), now)).toEqual(value);
  });

  it('rejects source paths, mismatched cancellation, invalid budgets, and malformed JSON', () => {
    expect(isQueryRequestDtoV1(request({
      source: { sourceId: 'source-1', documentId: 'doc-1', generation: 'g', path: 'C:/secret.jsonl' } as never,
    }))).toBe(false);
    expect(isQueryRequestDtoV1({ ...request(), path: 'C:/secret.jsonl' })).toBe(false);
    expect(isQueryRequestDtoV1(request({ cancellation: { requestId: 'other-request' } }))).toBe(false);
    expect(isQueryRequestDtoV1(request({
      budget: { limit: 0, maxBytes: '1', deadlineEpochMs: Date.now() + 1_000 },
    }))).toBe(false);
    expect(isQueryRequestDtoV1(request({
      budget: { limit: 1, maxBytes: '1', deadlineEpochMs: 1_000 },
    }), 2_000)).toBe(true);
    expect(isQueryRequestDtoV1(request({
      budget: { limit: 1, maxBytes: '1', deadlineEpochMs: 62_001 },
    }), 2_000)).toBe(false);
    expect(isQueryRequestDtoV1(request({
      cursor: { sort: { columnId: 'status', direction: 'asc' }, sortOffset: '2040' },
      budget: { limit: 20, maxBytes: '1', deadlineEpochMs: Date.now() + 1_000 },
    }))).toBe(false);
    expect(isQueryRequestDtoV1(request({
      cursor: {
        anchorOrdinal: '10',
        direction: 'backward',
        sort: { columnId: 'status', direction: 'asc' },
      },
    }))).toBe(false);
    expect(parseQueryRequestDtoV1('{"schema":"jsonlview.query-dto.v1"}')).toBeUndefined();
    expect(() => serializeQueryRequestDtoV1(request({ requestId: '' }))).toThrow(TypeError);
  });
});
