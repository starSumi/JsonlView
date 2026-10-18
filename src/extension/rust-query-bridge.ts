import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, relative, resolve } from 'node:path';

export const RUST_QUERY_SCHEMA = 'jsonlview.rust-query.v1' as const;
export const RUST_QUERY_CAPABILITY = 1 << 2;
export const RUST_QUERY_MAX_LIMIT = 256;
export const RUST_QUERY_MAX_BYTES = 8 * 1024 * 1024;

export interface RustQueryRequest {
  readonly sourcePath: string;
  readonly startOrdinal?: string;
  readonly limit?: number;
  readonly maxBytes?: number;
}

export interface RustQueryRecord {
  readonly ordinal: string;
  readonly startByte: string;
  readonly endByte: string;
  readonly raw: string;
}

export interface RustQueryResult {
  readonly schema: typeof RUST_QUERY_SCHEMA;
  readonly snapshot: { readonly sizeBytes: string; readonly modifiedUnixMillis: string };
  readonly records: readonly RustQueryRecord[];
  readonly nextOrdinal: string | null;
  readonly truncated: boolean;
  readonly truncationReason?: string;
}

export interface RustQueryBinding {
  readonly abiVersion: () => number;
  readonly capabilities: () => number;
  readonly queryRecords: (sourcePath: string, startOrdinal: string, limit: number, maxBytes: number) => string;
}

export interface RustQueryBridgeOptions {
  readonly binding?: RustQueryBinding;
  readonly allowedRoots?: readonly string[];
}

export class RustQueryBridge {
  private readonly binding: RustQueryBinding | undefined;
  private readonly allowedRoots: readonly string[] | undefined;

  public constructor(options: RustQueryBridgeOptions = {}) {
    this.binding = options.binding;
    this.allowedRoots = options.allowedRoots?.map((root) => resolve(root));
  }

  public query(request: RustQueryRequest): RustQueryResult {
    const path = normalizePath(request.sourcePath);
    this.assertAuthorized(path);
    const startOrdinal = parseBoundedOrdinal(request.startOrdinal ?? '0');
    const limit = boundedInteger(request.limit ?? 100, 1, RUST_QUERY_MAX_LIMIT, 'limit');
    const maxBytes = boundedInteger(request.maxBytes ?? 1024 * 1024, 1, RUST_QUERY_MAX_BYTES, 'maxBytes');
    const binding = this.binding;
    if (binding === undefined) throw new RustQueryUnavailableError('Native Rust query capability is unavailable.');
    const raw = binding.queryRecords(path, startOrdinal, limit, maxBytes);
    return validateResult(raw, startOrdinal, limit, maxBytes);
  }

  private assertAuthorized(path: string): void {
    if (this.allowedRoots === undefined || this.allowedRoots.length === 0) return;
    const allowed = this.allowedRoots.some((root) => {
      const remainder = relative(root, path);
      return remainder === '' || (!remainder.startsWith('..') && !isAbsolute(remainder));
    });
    if (!allowed) throw new RustQueryAuthorizationError('The source path is outside the authorized roots.');
  }
}

export class RustQueryUnavailableError extends Error {
  public readonly code = 'RUST_QUERY_UNAVAILABLE' as const;
}

export class RustQueryAuthorizationError extends Error {
  public readonly code = 'RUST_QUERY_UNAUTHORIZED' as const;
}

/** Adapt the same Rust data plane to the MCP tool boundary. Source IDs are
 * resolved by the host; MCP arguments never receive a filesystem path. */
export function createMcpRustQueryHandler(
  bridge: RustQueryBridge,
  sourcePaths: ReadonlyMap<string, string>,
): (request: { readonly arguments: Readonly<Record<string, unknown>>; readonly signal: AbortSignal }) => Promise<RustQueryResult> {
  return async ({ arguments: args, signal }) => {
    if (signal.aborted) throw new Error('MCP query was cancelled.');
    const sourceId = args.sourceId;
    if (typeof sourceId !== 'string') throw new Error('sourceId is required.');
    const sourcePath = sourcePaths.get(sourceId);
    if (sourcePath === undefined) throw new Error('sourceId is not authorized for this session.');
    const startOrdinal = args.startOrdinal === undefined ? '0' : String(args.startOrdinal);
    const limit = args.limit === undefined ? undefined : Number(args.limit);
    const maxBytes = args.maxBytes === undefined ? undefined : Number(args.maxBytes);
    return bridge.query({ sourcePath, startOrdinal, ...(limit === undefined ? {} : { limit }), ...(maxBytes === undefined ? {} : { maxBytes }) });
  };
}

export function loadRustQueryBridge(extensionPath: string, allowedRoots?: readonly string[]): RustQueryBridge {
  const binding = loadRustQueryBinding(extensionPath);
  return new RustQueryBridge({ ...(binding === undefined ? {} : { binding }), ...(allowedRoots === undefined ? {} : { allowedRoots }) });
}

function loadRustQueryBinding(extensionPath: string): RustQueryBinding | undefined {
  const requireNative = createRequire(resolve(extensionPath, 'package.json'));
  const candidates = [
    resolve(extensionPath, 'native', 'jsonl-core', 'jsonl_core.win32-x64-msvc.node'),
    resolve(extensionPath, 'native', 'jsonl-core', 'jsonl_core.node'),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const loaded = requireNative(candidate) as Partial<RustQueryBinding>;
      if (typeof loaded.abiVersion !== 'function' || typeof loaded.capabilities !== 'function' || typeof loaded.queryRecords !== 'function') continue;
      if (loaded.abiVersion() !== 2 || (loaded.capabilities() & RUST_QUERY_CAPABILITY) === 0) continue;
      return loaded as RustQueryBinding;
    } catch {
      // Native is an optional accelerator; callers retain an explicit unavailable state.
    }
  }
  return undefined;
}

function normalizePath(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) throw new RustQueryAuthorizationError('sourcePath is invalid.');
  return resolve(value);
}

function parseBoundedOrdinal(value: string): string {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || value.length > 20) throw new RangeError('startOrdinal must be a non-negative decimal string.');
  return value;
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RangeError(`${name} is outside the bounded query budget.`);
  return value;
}

function validateResult(raw: string, startOrdinal: string, limit: number, maxBytes: number): RustQueryResult {
  if (typeof raw !== 'string' || raw.length > RUST_QUERY_MAX_BYTES * 8) throw new Error('Native Rust query returned an oversized response.');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('Native Rust query returned invalid JSON.'); }
  if (!isRecord(value) || value.schema !== RUST_QUERY_SCHEMA || !isRecord(value.snapshot) || !Array.isArray(value.records)) {
    throw new Error('Native Rust query returned an invalid response schema.');
  }
  const snapshot = value.snapshot;
  if (!isDecimal(snapshot.sizeBytes) || !isSignedDecimal(snapshot.modifiedUnixMillis)) throw new Error('Native Rust query returned an invalid snapshot.');
  if (value.records.length > limit) throw new Error('Native Rust query exceeded the requested record limit.');
  const records: RustQueryRecord[] = [];
  let expectedOrdinal = BigInt(startOrdinal);
  let previousEnd = -1n;
  let totalRawBytes = 0;
  for (const item of value.records) {
    if (!isRecord(item) || !isDecimal(item.ordinal) || !isDecimal(item.startByte) || !isDecimal(item.endByte) || typeof item.raw !== 'string') throw new Error('Native Rust query returned an invalid record.');
    const ordinal = BigInt(item.ordinal);
    const startByte = BigInt(item.startByte);
    const endByte = BigInt(item.endByte);
    if (ordinal !== expectedOrdinal || startByte < previousEnd || endByte < startByte || endByte > BigInt(snapshot.sizeBytes)) throw new Error('Native Rust query returned inconsistent record cursors.');
    totalRawBytes += Buffer.byteLength(item.raw, 'utf8');
    if (totalRawBytes > maxBytes) throw new Error('Native Rust query exceeded the requested byte limit.');
    records.push({ ordinal: item.ordinal, startByte: item.startByte, endByte: item.endByte, raw: item.raw });
    expectedOrdinal += 1n;
    previousEnd = endByte;
  }
  if (typeof value.truncated !== 'boolean' || !(value.nextOrdinal === null || isDecimal(value.nextOrdinal)) || !(value.truncationReason === null || typeof value.truncationReason === 'string')) throw new Error('Native Rust query returned invalid paging metadata.');
  if (value.truncated !== (value.nextOrdinal !== null) || (value.nextOrdinal !== null && BigInt(value.nextOrdinal) !== expectedOrdinal)) throw new Error('Native Rust query returned inconsistent continuation metadata.');
  return { schema: RUST_QUERY_SCHEMA, snapshot: { sizeBytes: snapshot.sizeBytes, modifiedUnixMillis: snapshot.modifiedUnixMillis }, records, nextOrdinal: value.nextOrdinal, truncated: value.truncated, ...(typeof value.truncationReason === 'string' ? { truncationReason: value.truncationReason } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDecimal(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 20;
}

function isSignedDecimal(value: unknown): value is string {
  return typeof value === 'string' && /^-?(0|[1-9][0-9]*)$/.test(value) && value.length <= 21;
}
