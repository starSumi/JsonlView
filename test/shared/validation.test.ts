import { describe, expect, it } from 'vitest';
import {
  isArray,
  isBoundedString,
  isFiniteNumber,
  isRecord,
  isString,
  validateDiagnosticCode,
} from '../../src/shared/validation';
import { MAX_DIAGNOSTIC_CODE_LENGTH } from '../../src/shared/types';

describe('shared runtime validation', () => {
  it('returns a narrowed value for a valid diagnostic code', () => {
    const result = validateDiagnosticCode('source_changed');

    expect(result).toEqual({ ok: true, value: 'source_changed' });
    if (result.ok) expect(result.value.toUpperCase()).toBe('SOURCE_CHANGED');
  });

  it('accepts the diagnostic code length boundary', () => {
    expect(validateDiagnosticCode('x'.repeat(MAX_DIAGNOSTIC_CODE_LENGTH))).toEqual({
      ok: true,
      value: 'x'.repeat(MAX_DIAGNOSTIC_CODE_LENGTH),
    });
  });

  it('rejects empty, non-string, and overlong diagnostic codes', () => {
    expect(validateDiagnosticCode('')).toEqual({ ok: false, error: 'Diagnostic code is required.' });
    expect(validateDiagnosticCode(undefined)).toEqual({ ok: false, error: 'Diagnostic code is required.' });
    expect(validateDiagnosticCode(42)).toEqual({ ok: false, error: 'Diagnostic code is required.' });
    expect(validateDiagnosticCode('x'.repeat(MAX_DIAGNOSTIC_CODE_LENGTH + 1))).toEqual({
      ok: false,
      error: `Code exceeds ${MAX_DIAGNOSTIC_CODE_LENGTH} characters`,
    });
  });

  it('provides reusable runtime type guards', () => {
    expect(isRecord({ key: 'value' })).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isString('text')).toBe(true);
    expect(isString(1)).toBe(false);
    expect(isFiniteNumber(1.5)).toBe(true);
    expect(isFiniteNumber(Number.NaN)).toBe(false);
    expect(isArray([1, 2], (item): item is number => isFiniteNumber(item))).toBe(true);
    expect(isArray([1, '2'], (item): item is number => isFiniteNumber(item))).toBe(false);
  });

  it('keeps bounded strings non-empty and inclusive at the limit', () => {
    expect(isBoundedString('x', 1)).toBe(true);
    expect(isBoundedString('', 1)).toBe(false);
    expect(isBoundedString('xx', 1)).toBe(false);
    expect(isBoundedString(1, 1)).toBe(false);
  });
});
