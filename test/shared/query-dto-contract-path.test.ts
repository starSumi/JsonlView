import { describe, expect, it } from 'vitest';
import * as legacyQueryDto from '../../src/shared/query-dto';
import * as canonicalQueryDto from '../../src/shared/contracts/query-dto';
import {
  parseQueryRequestDtoV1,
  QUERY_DTO_SCHEMA,
  QUERY_DTO_VERSION,
  serializeQueryRequestDtoV1,
  type QueryRequestDtoV1,
} from '@shared/contracts/query-dto';

describe('canonical query DTO contract path', () => {
  it('preserves the runtime export surface through the legacy facade', () => {
    expect(Object.keys(legacyQueryDto).sort()).toEqual(Object.keys(canonicalQueryDto).sort());
  });

  it('preserves the existing v1 wire schema and request shape', () => {
    const now = Date.now();
    const value: QueryRequestDtoV1 = {
      schema: QUERY_DTO_SCHEMA,
      version: QUERY_DTO_VERSION,
      requestId: 'query-contract-path',
      source: {
        sourceId: 'source-1',
        documentId: 'document-1',
        generation: 'generation-1',
        epoch: 3,
      },
      ast: { schema: 'jsonlview.query-ast.v1', version: 1 },
      cursor: { anchorOrdinal: '12', direction: 'forward' },
      budget: { limit: 20, maxBytes: '4096', deadlineEpochMs: now + 5_000 },
      cancellation: { requestId: 'query-contract-path' },
    };

    const serialized = serializeQueryRequestDtoV1(value, now);
    const wire = JSON.parse(serialized) as Record<string, unknown>;

    expect(wire).toEqual(value);
    expect(wire).toMatchObject({
      schema: 'jsonlview.query-dto.v1',
      version: 1,
      requestId: 'query-contract-path',
      cursor: { anchorOrdinal: '12', direction: 'forward' },
    });
    expect(parseQueryRequestDtoV1(serialized, now)).toEqual(value);
  });
});
