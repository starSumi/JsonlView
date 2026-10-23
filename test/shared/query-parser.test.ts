import { describe, expect, it } from 'vitest';
import { evaluatePredicate } from '../../src/engine/predicate';
import { keyPath } from '../../src/shared/types';
import { compileQueryDsl, parseQueryDsl, QUERY_DSL_LIMITS } from '../../src/shared/query-parser';
import { compileDslQueryCondition } from '../../src/webview/features/record-query/query-condition';

describe('bounded query DSL parser', () => {
  it('lowers comparison and boolean precedence to the existing Predicate evaluator', () => {
    const result = parseQueryDsl('status == "error" and count >= 2 or active == true');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.predicate).toEqual({
      op: 'or',
      args: [
        {
          op: 'and',
          args: [
            { op: 'compare', path: keyPath('status'), cmp: 'eq', value: 'error' },
            { op: 'compare', path: keyPath('count'), cmp: 'gte', value: 2 },
          ],
        },
        { op: 'compare', path: keyPath('active'), cmp: 'eq', value: true },
      ],
    });
    expect(evaluatePredicate(result.predicate!, { status: 'error', count: 2, active: false })).toBe(true);
    expect(evaluatePredicate(result.predicate!, { status: 'ok', count: 2, active: false })).toBe(false);
  });

  it('supports nested paths, array indexes, profile fields, and text search', () => {
    expect(parseQueryDsl('payload.items[0].name contains "Ada"').predicate).toEqual({
      op: 'contains', path: { tokens: [
        { kind: 'key', value: 'payload' },
        { kind: 'key', value: 'items' },
        { kind: 'index', value: 0 },
        { kind: 'key', value: 'name' },
      ] }, value: 'Ada', caseSensitive: false,
    });
    expect(parseQueryDsl('@status == "error"').predicate).toEqual({
      op: 'profile_field', field: 'status', cmp: 'eq', value: 'error',
    });
    expect(parseQueryDsl('text("needle")').predicate).toEqual({
      op: 'text_search', value: 'needle', caseSensitive: false,
    });
    expect(parseQueryDsl('"needle"').predicate).toEqual({
      op: 'text_search', value: 'needle', caseSensitive: false,
    });
    expect(parseQueryDsl('$ == null').predicate).toEqual({ op: 'compare', path: { tokens: [] }, cmp: 'eq', value: null });
  });

  it('keeps empty input as the existing match-all predicate contract', () => {
    const result = parseQueryDsl('  ');
    expect(result).toMatchObject({ ok: true, predicate: undefined, ast: {
      schema: 'jsonlview.query-ast.v1', version: 1,
    } });
  });

  it('returns structured diagnostics for unsupported, malformed, and ambiguous input', () => {
    const unsupported = parseQueryDsl('status ~~ "error"');
    expect(unsupported.ok).toBe(false);
    if (!unsupported.ok) expect(unsupported.diagnostics.every((item) => item.code === 'unexpected_character')).toBe(true);
    const ambiguous = parseQueryDsl('status == "error" active == true');
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) expect(ambiguous.diagnostics.some((item) => item.code === 'ambiguous_expression')).toBe(true);
    expect(parseQueryDsl('status')).toMatchObject({ ok: false, diagnostics: [{ code: 'missing_operator' }] });
    expect(parseQueryDsl('status ==')).toMatchObject({ ok: false, diagnostics: [{ code: 'invalid_literal' }] });
    const result = parseQueryDsl('a'.repeat(QUERY_DSL_LIMITS.maxSourceLength + 1));
    expect(result).toMatchObject({ ok: false, diagnostics: [{ code: 'source_too_large' }] });
  });

  it('rejects excessive nesting and preserves bounded diagnostic fields', () => {
    const query = `${'('.repeat(QUERY_DSL_LIMITS.maxDepth + 1)}text("x")${')'.repeat(QUERY_DSL_LIMITS.maxDepth + 1)}`;
    const result = parseQueryDsl(query);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.some((item) => item.code === 'depth_limit_exceeded')).toBe(true);
    expect(result.diagnostics.every((item) => item.start >= 0 && item.length >= 0)).toBe(true);
  });

  it('exposes a compilation alias with the same result', () => {
    expect(compileQueryDsl('count > 1')).toEqual(parseQueryDsl('count > 1'));
  });

  it('composes successful DSL output through the existing query-condition path', () => {
    const result = compileDslQueryCondition({ query: 'status == "error"', filters: [], filterColumns: [] });
    expect(result).toMatchObject({
      ok: true,
      predicate: { op: 'compare', path: keyPath('status'), cmp: 'eq', value: 'error' },
      ast: { schema: 'jsonlview.query-ast.v1', version: 1 },
      diagnostics: [],
    });
    const invalid = compileDslQueryCondition({ query: 'status ~~ "error"', filters: [], filterColumns: [] });
    expect(invalid.ok).toBe(false);
    expect(invalid.diagnostics[0]?.code).toBe('unexpected_character');
  });

  it('keeps a deterministic corpus equivalent to hand-authored Predicates', () => {
    const cases: readonly [string, unknown, boolean][] = [
      ['count == 2', { count: 2 }, true],
      ['count != 2', { count: 3 }, true],
      ['name starts_with "Ad"', { name: 'Ada' }, true],
      ['name ends_with "son"', { name: 'Watson' }, true],
      ['missing exists', {}, false],
      ['empty is_null', { empty: null }, true],
      ['items[1] == "ok"', { items: ['no', 'ok'] }, true],
      ['active == false', { active: true }, false],
      ['kind kind_is "array"', { kind: [] }, true],
    ];
    for (const [query, value, expected] of cases) {
      const result = parseQueryDsl(query);
      expect(result.ok, query).toBe(true);
      if (!result.ok || result.predicate === undefined) continue;
      expect(evaluatePredicate(result.predicate, value), query).toBe(expected);
    }
  });

  it('preserves comparison operator semantics across a bounded generated corpus', () => {
    const cases: readonly [string, number, boolean][] = [
      ['==', 2, true], ['!=', 2, false], ['!=', 3, true],
      ['<', 3, false], ['<=', 2, true], ['>', 1, false], ['>=', 2, true],
    ];
    for (const [operator, count, expected] of cases) {
      const result = parseQueryDsl(`count ${operator} 2`);
      expect(result.ok, operator).toBe(true);
      if (!result.ok || result.predicate === undefined) continue;
      expect(evaluatePredicate(result.predicate, { count }), `${operator} ${count}`).toBe(expected);
    }
  });
});
