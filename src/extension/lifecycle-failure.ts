import { formatOutputLogLine, type JsonlViewOutputChannel } from './output-log';

export type LifecycleFailureStage = 'source_reconcile' | 'webview_delivery' | 'webview_diagnostic';

const ERROR_NAMES = new Set([
  'Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError',
  'EvalError', 'AggregateError', 'AbortError', 'InvalidStateError', 'SecurityError',
  'NotAllowedError', 'TimeoutError', 'NetworkError', 'StartupTimeout',
]);
const ERROR_CODES = new Set([
  'ABORT_ERR', 'ERR_CANCELED', 'EACCES', 'EBUSY', 'EEXIST', 'EIO', 'EISDIR',
  'EMFILE', 'ENFILE', 'ENOENT', 'ENOMEM', 'ENOSPC', 'ENOTDIR', 'EPERM', 'EROFS', 'ETIMEDOUT',
]);

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

function failureEvent(stage: LifecycleFailureStage): string | undefined {
  switch (stage) {
    case 'source_reconcile': return 'source-reconcile-failed';
    case 'webview_delivery': return 'webview-delivery-failed';
    case 'webview_diagnostic': return 'diagnostic';
    default: return undefined;
  }
}

/** Fixed local metadata only; failures of either observer cannot change the operation. */
export function logLifecycleFailure(
  channel: JsonlViewOutputChannel | undefined,
  stage: LifecycleFailureStage,
  error: unknown,
  warn?: (line: string) => void,
): void {
  const event = failureEvent(stage);
  if (event === undefined) return;
  const name = dataProperty(error, 'name', true);
  const code = dataProperty(error, 'code');
  const errorName = typeof name === 'string' && ERROR_NAMES.has(name) ? name : 'UnknownError';
  const errorCode = typeof code === 'string' && ERROR_CODES.has(code) ? ` code=${code}` : '';
  const detail = `stage=${stage} outcome=failed error_name=${errorName}${errorCode}`;
  try {
    channel?.appendLine(formatOutputLogLine(event, detail));
  } catch {
    // A disposed or failed log channel must not interrupt recovery or delivery.
  }
  try {
    warn?.(`[JsonlView] ${event} ${detail}`);
  } catch {
    // Console observation has the same best-effort boundary as the output channel.
  }
}
