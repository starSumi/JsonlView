import { describe, expect, it } from 'vitest';
import { findDeprecatedQueryDtoImports } from '../../scripts/check-query-dto-facade.mjs';

describe('deprecated query DTO facade gate', () => {
  it('finds static, type-only, re-export, dynamic, require, and import-equals references', () => {
    const references = findDeprecatedQueryDtoImports('src/application/consumer.ts', [
      "import { QUERY_DTO_SCHEMA as OtherSchema } from '@shared/query-dto';",
      "import type { QueryRequestDtoV1 } from '@shared/query-dto';",
      "export { parseQueryRequestDtoV1 } from '@shared/query-dto';",
      "void import('@shared/query-dto');",
      "void require('@shared/query-dto');",
      "import Legacy = require('@shared/query-dto');",
    ].join('\n'));

    expect(references).toHaveLength(6);
    expect(references.map((reference) => reference.line)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('resolves relative and aliased paths that target the deprecated facade', () => {
    const references = findDeprecatedQueryDtoImports('src/application/ports/consumer.ts', [
      "import { QUERY_DTO_SCHEMA } from '../../shared/query-dto';",
      "export type { QueryRequestDtoV1 } from '../../shared/query-dto';",
      "type QueryAlias = import('../../shared/query-dto').QueryDtoV1;",
      "void import('../../shared/query-dto');",
      "import { QUERY_DTO_SCHEMA as AliasedSchema } from '@shared/query-dto';",
    ].join('\n'));

    expect(references.map((reference) => reference.specifier)).toEqual([
      '../../shared/query-dto',
      '../../shared/query-dto',
      '../../shared/query-dto',
      '../../shared/query-dto',
      '@shared/query-dto',
    ]);
  });

  it('allows the compatibility facade and canonical contract path', () => {
    expect(findDeprecatedQueryDtoImports('src/shared/query-dto.ts', "export * from './contracts/query-dto';")).toEqual([]);
    expect(findDeprecatedQueryDtoImports('src/application/consumer.ts', "import { QUERY_DTO_SCHEMA } from '@shared/contracts/query-dto';")).toEqual([]);
  });
});
