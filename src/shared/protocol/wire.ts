/**
 * Cross-boundary lifecycle vocabulary. These values are intentionally small
 * and stable: host and Webview map them to local copy instead of serializing
 * exceptions, paths, or provider-specific details.
 */
export const SHARED_CONTRACT_VERSION = 1 as const;
export type SharedContractVersion = typeof SHARED_CONTRACT_VERSION;

export type ProtocolStageCode =
  | 'request-received'
  | 'state-read'
  | 'authorization-check'
  | 'authorization-write'
  | 'authorization-readback'
  | 'source-write'
  | 'source-config-write'
  | 'source-config-readback'
  | 'catalog-reconcile'
  | 'catalog-open'
  | 'editor-open'
  | 'enablement'
  | 'authorization'
  | 'focus'
  | 'settled';

export type ProtocolErrorCode =
  | 'invalid-envelope'
  | 'unsupported-version'
  | 'wrong-direction'
  | 'stale-generation'
  | 'operation-cancelled'
  | 'deadline-exceeded'
  | 'file-save-failed'
  | 'file-save-cancelled'
  | 'file-save-unknown'
  | 'source-config-conflict'
  | 'source-config-failed'
  | 'source-config-readback-unknown'
  | 'catalog-reconcile-failed'
  | 'catalog-reconcile-unknown'
  | 'catalog-scan-disabled'
  | 'open-failed'
  | 'open-unknown'
  | 'navigator-disabled'
  | 'navigator-authorization-required'
  | 'navigator-authorization-denied'
  | 'navigator-authorization-unknown'
  | 'navigator-open-failed';

export type NavigatorErrorCode =
  | 'NAVIGATOR_DISABLED'
  | 'ENABLEMENT_NOT_CONFIRMED'
  | 'AUTHORIZATION_REQUIRED'
  | 'AUTHORIZATION_NOT_CONFIRMED'
  | 'OPEN_FAILED';

export interface ProtocolFailure {
  errorCode: ProtocolErrorCode;
  stage: ProtocolStageCode;
  recoverable: boolean;
}

export function isProtocolStageCode(value: unknown): value is ProtocolStageCode {
  return typeof value === 'string' && PROTOCOL_STAGES.has(value);
}

export function isProtocolErrorCode(value: unknown): value is ProtocolErrorCode {
  return typeof value === 'string' && PROTOCOL_ERRORS.has(value);
}

export function isProtocolFailure(value: unknown): value is ProtocolFailure {
  return isRecord(value)
    && isProtocolErrorCode(value.errorCode)
    && isProtocolStageCode(value.stage)
    && typeof value.recoverable === 'boolean'
    && hasOnlyKeys(value, ['errorCode', 'stage', 'recoverable']);
}

const PROTOCOL_STAGES: ReadonlySet<string> = new Set<ProtocolStageCode>([
  'request-received', 'state-read', 'authorization-check', 'authorization-write',
  'authorization-readback', 'source-write', 'source-config-write',
  'source-config-readback', 'catalog-reconcile', 'catalog-open', 'editor-open',
  'enablement', 'authorization', 'focus', 'settled',
]);

const PROTOCOL_ERRORS: ReadonlySet<string> = new Set<string>([
  'invalid-envelope', 'unsupported-version', 'wrong-direction', 'stale-generation',
  'operation-cancelled', 'deadline-exceeded', 'file-save-failed', 'file-save-cancelled',
  'file-save-unknown', 'source-config-conflict', 'source-config-failed',
  'source-config-readback-unknown', 'catalog-reconcile-failed', 'catalog-reconcile-unknown',
  'catalog-scan-disabled', 'open-failed', 'open-unknown', 'navigator-disabled',
  'navigator-authorization-required', 'navigator-authorization-denied',
  'navigator-authorization-unknown', 'navigator-open-failed',
]);

export const MAX_PROTOCOL_OPERATION_ID_LENGTH = 128;
export const MAX_PROTOCOL_SOURCE_ID_LENGTH = 256;
export const MAX_PROTOCOL_SOURCE_URI_LENGTH = 2048;
export const MAX_PROTOCOL_REVISION_LENGTH = 128;

export function isBoundedProtocolString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}
