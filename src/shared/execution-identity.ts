import embeddedExecutionIdentity from 'jsonlview:execution-identity';

export const EXECUTION_IDENTITY_SCHEMA = 'jsonlview.execution-identity.v1' as const;

export interface ExecutionIdentity {
  schemaVersion: typeof EXECUTION_IDENTITY_SCHEMA;
  extensionId: string;
  extensionVersion: string;
  buildMode: 'development' | 'production' | 'test';
  compilerMode: 'disabled' | 'enabled';
  sourceRevision: string;
  sourceState: 'clean' | 'modified';
  buildInputsSha256: string;
  buildInputCount: number;
  digestAlgorithm: 'sha256';
  canonicalization: 'jsonlview.sorted-json.v1';
  manifestSha256: string;
}

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_REVISION = /^[0-9a-f]{40}$/;
const EXTENSION_ID = /^[A-Za-z0-9][A-Za-z0-9.-]{2,127}$/;
const EXTENSION_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/;
const IDENTITY_KEYS = [
  'schemaVersion', 'extensionId', 'extensionVersion', 'buildMode', 'compilerMode', 'sourceRevision', 'sourceState',
  'buildInputsSha256', 'buildInputCount', 'digestAlgorithm', 'canonicalization', 'manifestSha256',
];

export interface RuntimeExecutionIdentity {
  extensionId: string;
  extensionVersion: string;
  extensionMode: 'production' | 'development' | 'test' | 'unknown';
}

export const UNKNOWN_RUNTIME_IDENTITY: Readonly<RuntimeExecutionIdentity> = Object.freeze({
  extensionId: 'unknown', extensionVersion: 'unknown', extensionMode: 'unknown',
});

export function isRuntimeExecutionIdentity(value: unknown): value is RuntimeExecutionIdentity {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const runtime = value as Partial<RuntimeExecutionIdentity>;
  return Object.keys(runtime).length === 3
    && typeof runtime.extensionId === 'string' && EXTENSION_ID.test(runtime.extensionId)
    && typeof runtime.extensionVersion === 'string' && runtime.extensionVersion.length <= 64
    && (runtime.extensionVersion === 'unknown' || EXTENSION_VERSION.test(runtime.extensionVersion))
    && (runtime.extensionMode === 'production' || runtime.extensionMode === 'development'
      || runtime.extensionMode === 'test' || runtime.extensionMode === 'unknown');
}

export function runtimeExecutionIdentitiesEqual(left: RuntimeExecutionIdentity, right: RuntimeExecutionIdentity): boolean {
  return left.extensionId === right.extensionId && left.extensionVersion === right.extensionVersion
    && left.extensionMode === right.extensionMode;
}

export function isExecutionIdentity(value: unknown): value is ExecutionIdentity {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const identity = value as Partial<ExecutionIdentity>;
  return Object.keys(identity).length === IDENTITY_KEYS.length
    && IDENTITY_KEYS.every((key) => Object.hasOwn(identity, key))
    && identity.schemaVersion === EXECUTION_IDENTITY_SCHEMA
    && typeof identity.extensionId === 'string' && EXTENSION_ID.test(identity.extensionId)
    && typeof identity.extensionVersion === 'string' && identity.extensionVersion.length <= 64 && EXTENSION_VERSION.test(identity.extensionVersion)
    && (identity.buildMode === 'development' || identity.buildMode === 'production' || identity.buildMode === 'test')
    && (identity.compilerMode === 'disabled' || identity.compilerMode === 'enabled')
    && typeof identity.sourceRevision === 'string' && GIT_REVISION.test(identity.sourceRevision)
    && (identity.sourceState === 'clean' || identity.sourceState === 'modified')
    && typeof identity.buildInputsSha256 === 'string' && SHA256.test(identity.buildInputsSha256)
    && Number.isSafeInteger(identity.buildInputCount) && (identity.buildInputCount ?? 0) > 0 && (identity.buildInputCount ?? 0) <= 4096
    && identity.digestAlgorithm === 'sha256'
    && identity.canonicalization === 'jsonlview.sorted-json.v1'
    && typeof identity.manifestSha256 === 'string' && SHA256.test(identity.manifestSha256);
}

export function executionIdentitiesEqual(left: ExecutionIdentity, right: ExecutionIdentity): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.extensionId === right.extensionId
    && left.extensionVersion === right.extensionVersion
    && left.buildMode === right.buildMode
    && left.compilerMode === right.compilerMode
    && left.sourceRevision === right.sourceRevision
    && left.sourceState === right.sourceState
    && left.buildInputsSha256 === right.buildInputsSha256
    && left.buildInputCount === right.buildInputCount
    && left.digestAlgorithm === right.digestAlgorithm
    && left.canonicalization === right.canonicalization
    && left.manifestSha256 === right.manifestSha256;
}

if (!isExecutionIdentity(embeddedExecutionIdentity)) throw new Error('embedded JsonlView execution identity is invalid');
export const EXECUTION_IDENTITY: ExecutionIdentity = Object.freeze({ ...embeddedExecutionIdentity });
