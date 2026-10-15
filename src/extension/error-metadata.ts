const ERROR_NAMES = new Set([
  'Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError',
  'EvalError', 'AggregateError', 'AbortError', 'InvalidStateError', 'SecurityError',
  'NotAllowedError', 'TimeoutError', 'NetworkError', 'StartupTimeout',
]);
const ERROR_CODES = new Set([
  'ABORT_ERR', 'ERR_CANCELED', 'EACCES', 'EBUSY', 'EEXIST', 'EIO', 'EISDIR',
  'EMFILE', 'ENFILE', 'ENOENT', 'ENOMEM', 'ENOSPC', 'ENOTDIR', 'EPERM', 'EROFS', 'ETIMEDOUT',
]);

export interface ErrorMetadata {
  readonly errorName: string;
  readonly errorCode?: string;
}

export function isSafeErrorName(value: unknown): value is string {
  return typeof value === 'string' && (value === 'UnknownError' || ERROR_NAMES.has(value));
}

/** Inspect only data descriptors: never run an error getter or coerce a thrown value. */
function dataProperty(value: unknown, key: 'name' | 'code', inherited = false): unknown {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
  try {
    const own = Object.getOwnPropertyDescriptor(value, key);
    if (own !== undefined) return 'value' in own ? own.value : undefined;
    if (!inherited) return undefined;
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype === null) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
    return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    // Revoked proxies and hostile descriptor/prototype traps are unknown errors.
    return undefined;
  }
}

/** Shared fixed metadata; messages, stacks, causes and arbitrary codes are omitted. */
export function classifyErrorMetadata(error: unknown): ErrorMetadata {
  const name = dataProperty(error, 'name', true);
  const code = dataProperty(error, 'code');
  return {
    errorName: isSafeErrorName(name) ? name : 'UnknownError',
    ...(typeof code === 'string' && ERROR_CODES.has(code) ? { errorCode: code } : {}),
  };
}
