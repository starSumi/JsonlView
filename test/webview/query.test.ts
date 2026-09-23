import { describe, expect, it } from 'vitest';
import { keyPath, type ColumnSpec } from '../../src/shared/types';
import { combinePredicates, parseFilterLiteral, predicateForFilter } from '../../src/webview/query';

const columns: ColumnSpec[] = [
  { id: 'name', label: 'Name', source: 'record', path: keyPath('name') },
  { id: 'status', label: 'Status', source: 'profile' },
];

describe('structured query helpers', () => {
  it('builds typed record and profile predicates', () => {
    expect(predicateForFilter({ columnId: 'name', operator: 'contains', value: 'Ada', caseSensitive: false }, columns))
      .toEqual({ op: 'contains', path: keyPath('name'), value: 'Ada', caseSensitive: false });
    expect(predicateForFilter({ columnId: 'status', operator: 'eq', value: 'error' }, columns))
      .toEqual({ op: 'profile_field', field: 'status', cmp: 'eq', value: 'error' });
  });

  it('supports profile text and presence operations', () => {
    expect(predicateForFilter({ columnId: 'status', operator: 'contains', value: 'err' }, columns))
      .toEqual({ op: 'profile_text', field: 'status', cmp: 'contains', value: 'err', caseSensitive: false });
    expect(predicateForFilter({ columnId: 'status', operator: 'exists' }, columns))
      .toEqual({ op: 'profile_exists', field: 'status' });
    expect(predicateForFilter({ columnId: 'status', operator: 'is_null' }, columns))
      .toEqual({ op: 'profile_is_null', field: 'status' });
  });

  it('restores a filter from captured source metadata before columns arrive', () => {
    expect(predicateForFilter({
      columnId: 'name',
      operator: 'exists',
      source: 'record',
      path: keyPath('name'),
    }, [])).toEqual({ op: 'exists', path: keyPath('name') });
    expect(predicateForFilter({
      columnId: 'status',
      operator: 'eq',
      value: 'error',
      source: 'profile',
    }, [])).toEqual({ op: 'profile_field', field: 'status', cmp: 'eq', value: 'error' });
  });

  it('combines text and structured predicates without an empty and node', () => {
    const predicate = { op: 'exists', path: keyPath('name') } as const;
    expect(combinePredicates(undefined)).toBeUndefined();
    expect(combinePredicates(predicate)).toBe(predicate);
    expect(combinePredicates(predicate, { op: 'text_search', value: 'Ada', caseSensitive: false }))
      .toEqual({ op: 'and', args: [predicate, { op: 'text_search', value: 'Ada', caseSensitive: false }] });
  });

  it('parses only JSON scalar literals', () => {
    expect(parseFilterLiteral('42')).toBe(42);
    expect(parseFilterLiteral('true')).toBe(true);
    expect(parseFilterLiteral('null')).toBeNull();
    expect(parseFilterLiteral('hello')).toBe('hello');
    expect(parseFilterLiteral('{"x":1}')).toBe('{"x":1}');
  });
});
