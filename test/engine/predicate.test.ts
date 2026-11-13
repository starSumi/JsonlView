import { describe, expect, it } from 'vitest';
import { evaluatePredicate, jsonKindOf, resolveFieldPath } from '../../src/engine/predicate';
import { keyPath, type FieldPath, type Predicate } from '../../src/shared/types';

describe('predicate exceptional data boundaries', () => {
  const pathCases: Array<{ name: string; value: unknown; path: FieldPath; exists: boolean }> = [
    { name: 'a missing own property', value: {}, path: keyPath('constructor'), exists: false },
    { name: 'an inherited prototype property', value: {}, path: keyPath('__proto__'), exists: false },
    { name: 'a negative array index', value: { values: ['a'] }, path: { tokens: [{ kind: 'key', value: 'values' }, { kind: 'index', value: -1 }] }, exists: false },
    { name: 'a fractional array index', value: { values: ['a'] }, path: { tokens: [{ kind: 'key', value: 'values' }, { kind: 'index', value: 0.5 }] }, exists: false },
    { name: 'an out-of-range array index', value: { values: ['a'] }, path: { tokens: [{ kind: 'key', value: 'values' }, { kind: 'index', value: 1 }] }, exists: false },
  ];

  it.each(pathCases)('resolves $name as absent without throwing', ({ value, path, exists }) => {
    expect(() => resolveFieldPath(value, path)).not.toThrow();
    expect(resolveFieldPath(value, path).exists).toBe(exists);
  });

  it.each([
    ['null record', null],
    ['undefined host value', undefined],
    ['BigInt host value', 1n],
    ['cyclic host value', Object.assign({}, { self: undefined })],
  ])('handles text search over %s without coercion exceptions', (_name, value) => {
    if (_name === 'cyclic host value' && typeof value === 'object' && value !== null) {
      (value as { self?: unknown }).self = value;
    }
    const predicate: Predicate = { op: 'text_search', value: 'needle', caseSensitive: true };

    expect(() => evaluatePredicate(predicate, value)).not.toThrow();
    expect(evaluatePredicate(predicate, value)).toBe(false);
  });

  it('treats throwing JSON serialization as an unsearchable value', () => {
    const value = { toJSON: () => { throw new Error('serialization failed'); } };
    const predicate: Predicate = { op: 'text_search', value: 'needle', caseSensitive: true };

    expect(evaluatePredicate(predicate, value)).toBe(false);
  });

  it.each([
    ['undefined', undefined, 'null'],
    ['NaN', Number.NaN, 'number'],
    ['positive infinity', Number.POSITIVE_INFINITY, 'number'],
    ['BigInt', 1n, 'null'],
    ['function', () => undefined, 'null'],
  ] as const)('classifies non-JSON %s values using the existing kind contract', (_name, value, expected) => {
    expect(jsonKindOf(value)).toBe(expected);
  });
});
