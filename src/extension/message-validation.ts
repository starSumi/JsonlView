/** Compatibility path; pure wire validation lives under src/shared/contracts/. */
import { validateWebviewRequest as validateContractRequest } from '@shared/contracts/webview-request';

export type { ValidationResult } from '@shared/contracts/webview-request';

/** Extension Host adapter supplies the clock required for time-relative budget checks. */
export function validateWebviewRequest(rawValue: unknown) {
  return validateContractRequest(rawValue, { nowEpochMs: Date.now() });
}

export { isValidQueryPredicate } from '@shared/contracts/webview-request';
