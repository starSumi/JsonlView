import type { ExecutionIdentity, RuntimeExecutionIdentity } from '../execution-identity';

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

export const JSONLVIEW_DIAGNOSTIC_PROTOCOL_VERSION = 1 as const;
export const JSONLVIEW_STARTUP_STAGE_PROTOCOL_VERSION = 1 as const;
export const MAX_JSONLVIEW_DIAGNOSTIC_NAME_LENGTH = 128;
export const MAX_JSONLVIEW_DIAGNOSTIC_MESSAGE_LENGTH = 512;
export const MAX_STARTUP_STAGE_ID_LENGTH = 128;
export const MAX_STARTUP_STAGE_ROWS = 500;

export type JsonlViewDiagnosticProtocolVersion = typeof JSONLVIEW_DIAGNOSTIC_PROTOCOL_VERSION;
export type StartupStageProtocolVersion = typeof JSONLVIEW_STARTUP_STAGE_PROTOCOL_VERSION;

export interface JsonlViewDiagnosticMessage {
  readonly type: 'JSONLVIEW_DIAGNOSTIC';
  readonly diagnosticProtocolVersion: JsonlViewDiagnosticProtocolVersion;
  readonly name: string;
  readonly message: string;
}

export type StartupStage = 'opened-accepted' | 'page-committed' | 'startup-error';

export interface StartupStageReceipt {
  readonly type: 'JSONLVIEW_STARTUP_STAGE';
  readonly startupStageProtocolVersion: StartupStageProtocolVersion;
  readonly stage: StartupStage;
  readonly documentId: string;
  readonly generation: string;
  readonly startupId: string;
  readonly executionIdentity: ExecutionIdentity;
  readonly runtimeIdentity: RuntimeExecutionIdentity;
  readonly epoch?: number;
  readonly rows?: number;
}

const STARTUP_STAGE_RECEIPT_KEYS = [
  'type', 'startupStageProtocolVersion', 'stage', 'documentId', 'generation', 'startupId',
  'executionIdentity', 'runtimeIdentity', 'epoch', 'rows',
] as const;
const EXECUTION_IDENTITY_KEYS = [
  'schemaVersion', 'extensionId', 'extensionVersion', 'buildMode', 'compilerMode', 'sourceRevision', 'sourceState',
  'buildInputsSha256', 'buildInputCount', 'digestAlgorithm', 'canonicalization', 'manifestSha256',
] as const;
const RUNTIME_EXECUTION_IDENTITY_KEYS = ['extensionId', 'extensionVersion', 'extensionMode'] as const;

/** Stateless shape guard for bounded diagnostic messages crossing the Webview boundary. */
export function isJsonlViewDiagnosticMessage(value: unknown): value is JsonlViewDiagnosticMessage {
  return isRecord(value)
    && hasOnlyKeys(value, ['type', 'diagnosticProtocolVersion', 'name', 'message'])
    && value.type === 'JSONLVIEW_DIAGNOSTIC'
    && value.diagnosticProtocolVersion === JSONLVIEW_DIAGNOSTIC_PROTOCOL_VERSION
    && isBoundedProtocolString(value.name, MAX_JSONLVIEW_DIAGNOSTIC_NAME_LENGTH)
    && isBoundedProtocolString(value.message, MAX_JSONLVIEW_DIAGNOSTIC_MESSAGE_LENGTH);
}

/**
 * Stateless shape guard for startup receipts. Matching these identities to
 * the active extension and document session remains an extension-adapter check.
 */
export function isStartupStageReceipt(value: unknown): value is StartupStageReceipt {
  if (!isRecord(value)
    || !hasOnlyKeys(value, STARTUP_STAGE_RECEIPT_KEYS)
    || value.type !== 'JSONLVIEW_STARTUP_STAGE'
    || value.startupStageProtocolVersion !== JSONLVIEW_STARTUP_STAGE_PROTOCOL_VERSION
    || !isStartupStage(value.stage)
    || !isBoundedProtocolString(value.documentId, MAX_STARTUP_STAGE_ID_LENGTH)
    || !isBoundedProtocolString(value.generation, MAX_STARTUP_STAGE_ID_LENGTH)
    || !isBoundedProtocolString(value.startupId, MAX_STARTUP_STAGE_ID_LENGTH)
    || !hasExecutionIdentityShape(value.executionIdentity)
    || !hasRuntimeExecutionIdentityShape(value.runtimeIdentity)
    || (value.epoch !== undefined && (!Number.isSafeInteger(value.epoch) || (value.epoch as number) < 0))) return false;
  if (value.stage === 'page-committed') {
    return Number.isSafeInteger(value.rows) && (value.rows as number) >= 0 && (value.rows as number) <= MAX_STARTUP_STAGE_ROWS;
  }
  return value.rows === undefined;
}

function isStartupStage(value: unknown): value is StartupStage {
  return value === 'opened-accepted' || value === 'page-committed' || value === 'startup-error';
}

function hasExecutionIdentityShape(value: unknown): value is ExecutionIdentity {
  if (!isRecord(value) || Object.keys(value).length !== EXECUTION_IDENTITY_KEYS.length
    || !EXECUTION_IDENTITY_KEYS.every((key) => Object.hasOwn(value, key))) return false;
  return typeof value.schemaVersion === 'string'
    && typeof value.extensionId === 'string'
    && typeof value.extensionVersion === 'string'
    && (value.buildMode === 'development' || value.buildMode === 'production' || value.buildMode === 'test')
    && (value.compilerMode === 'disabled' || value.compilerMode === 'enabled')
    && typeof value.sourceRevision === 'string'
    && (value.sourceState === 'clean' || value.sourceState === 'modified')
    && typeof value.buildInputsSha256 === 'string'
    && Number.isSafeInteger(value.buildInputCount)
    && value.digestAlgorithm === 'sha256'
    && typeof value.canonicalization === 'string'
    && typeof value.manifestSha256 === 'string';
}

function hasRuntimeExecutionIdentityShape(value: unknown): value is RuntimeExecutionIdentity {
  return isRecord(value)
    && Object.keys(value).length === RUNTIME_EXECUTION_IDENTITY_KEYS.length
    && RUNTIME_EXECUTION_IDENTITY_KEYS.every((key) => Object.hasOwn(value, key))
    && typeof value.extensionId === 'string'
    && typeof value.extensionVersion === 'string'
    && (value.extensionMode === 'production' || value.extensionMode === 'development'
      || value.extensionMode === 'test' || value.extensionMode === 'unknown');
}
