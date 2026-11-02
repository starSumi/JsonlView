import { MAX_DIAGNOSTIC_CODE_LENGTH } from './types';

/** A small discriminated result used by runtime validators. */
export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isArray<T = unknown>(
  value: unknown,
  itemGuard?: (item: unknown) => item is T,
): value is readonly T[] {
  return Array.isArray(value) && (itemGuard === undefined || value.every(itemGuard));
}

/** Matches the existing transport contract: non-empty text within the limit. */
export function isBoundedString(value: unknown, maxLength: number): value is string {
  return isString(value) && value.length > 0 && value.length <= maxLength;
}

/** Validates diagnostic codes at the shared boundary before they enter a result or IPC payload. */
export function validateDiagnosticCode(code: unknown): ValidationResult<string> {
  if (!isString(code) || code.length === 0) {
    return { ok: false, error: 'Diagnostic code is required.' };
  }
  if (code.length > MAX_DIAGNOSTIC_CODE_LENGTH) {
    return { ok: false, error: `Code exceeds ${MAX_DIAGNOSTIC_CODE_LENGTH} characters` };
  }
  return { ok: true, value: code };
}
