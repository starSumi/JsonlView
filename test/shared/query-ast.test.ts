import { describe, expect, it } from 'vitest';
import {
  createQueryAstV1,
  isQueryAstV1,
  lowerQueryAstV1,
  QUERY_AST_SCHEMA,
} from '../../src/shared/query-ast';
import type { Predicate } from '../../src/shared/types';

describe('versioned query AST', () => {
  it('wraps the existing Predicate semantics and preserves match-all omission', () => {
    const predicate: Predicate = {
      op: 'and',
      args: [
        { op: 'compare', path: { tokens: [{ kind: 'key', value: 'status' }] }, cmp: 'eq', value: 'ok' },
        { op: 'profile_exists', field: 'eventKind' },
      ],
    };
    const ast = createQueryAstV1(predicate);
    expect(ast.schema).toBe(QUERY_AST_SCHEMA);
    expect(isQueryAstV1(ast)).toBe(true);
    expect(lowerQueryAstV1(ast)).toEqual(predicate);

    const matchAll = createQueryAstV1();
    expect(isQueryAstV1(matchAll)).toBe(true);
    expect(lowerQueryAstV1(matchAll)).toBeUndefined();
  });

  it('rejects unsupported versions, extra envelope fields, and over-budget expressions', () => {
    expect(isQueryAstV1({ schema: QUERY_AST_SCHEMA, version: 2 })).toBe(false);
    expect(isQueryAstV1({ schema: QUERY_AST_SCHEMA, version: 1, path: 'C:/secret.jsonl' })).toBe(false);
    expect(isQueryAstV1({
      schema: QUERY_AST_SCHEMA,
      version: 1,
      predicate: { op: 'contains', path: { tokens: [] }, value: 'x', caseSensitive: false },
    })).toBe(true);
    expect(isQueryAstV1({
      schema: QUERY_AST_SCHEMA,
      version: 1,
      predicate: {
        op: 'contains',
        path: { tokens: [] },
        value: 'x'.repeat(16 * 1024 + 1),
        caseSensitive: false,
      },
    })).toBe(false);
  });
});
