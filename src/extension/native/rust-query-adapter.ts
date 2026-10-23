import {
  RustQueryAuthorizationError,
  RustQueryUnavailableError,
  type RustQueryBridge,
  type RustQueryRequest,
  type RustQueryResult,
} from '../rust-query-bridge';

const RUST_QUERY_ABI_VERSION = 2;
const RUST_QUERY_CAPABILITY = 1 << 2;

/** Optional probe supplied by tests or a loader that owns the raw addon. */
export interface NativeQueryBindingProbe {
  readonly abiVersion: () => number;
  readonly capabilities: () => number;
}

/**
 * The native query is an optional accelerator. The portable reader remains
 * the result authority and is injected by the owning lifecycle/query path.
 * This boundary deliberately does not know the query AST or profile DTO.
 */
export type PortableRustQuery = (
  request: RustQueryRequest,
  signal: AbortSignal,
) => Promise<RustQueryResult>;

export type NativeQueryFallbackReason =
  | 'missing-binary'
  | 'unsupported-native'
  | 'cancelled'
  | 'budget-exhausted'
  | 'native-failure';

export interface NativeQueryOutcome {
  readonly result: RustQueryResult;
  readonly path: 'native' | 'portable';
  readonly fallbackReason?: NativeQueryFallbackReason;
}

export interface RustQueryAdapterOptions {
  /**
   * The bridge is retained even when its optional addon is absent. Its query
   * method performs path authorization before reporting native unavailability,
   * so fallback cannot bypass the host source allowlist.
   */
  readonly bridge: RustQueryBridge;
  /**
   * `loadRustQueryBridge` already validates this contract. Supplying the
   * probe lets embedders keep that validation visible without exposing the
   * bridge's private binding or changing the wire protocol.
   */
  readonly nativeBinding?: NativeQueryBindingProbe;
  /** Required when `nativeBinding` is supplied so capability probing cannot
   * bypass host path authorization. */
  readonly authorize?: (sourcePath: string) => void;
  readonly portable: PortableRustQuery;
}

/**
 * Selects the native accelerator only after the caller has supplied an
 * authorized, bounded request. Native N-API calls are synchronous today, so
 * they are intentionally treated as non-cancellable: cancellation before or
 * after the call discards the candidate and invokes the portable path.
 */
export class RustQueryAdapter {
  private readonly bridge: RustQueryBridge;
  private readonly nativeBinding: NativeQueryBindingProbe | undefined;
  private readonly authorize: ((sourcePath: string) => void) | undefined;
  private readonly portable: PortableRustQuery;

  public constructor(options: RustQueryAdapterOptions) {
    this.bridge = options.bridge;
    this.nativeBinding = options.nativeBinding;
    this.authorize = options.authorize;
    this.portable = options.portable;
  }

  public async query(
    request: RustQueryRequest,
    signal: AbortSignal,
  ): Promise<NativeQueryOutcome> {
    if (signal.aborted) return this.queryPortable(request, signal, 'cancelled');

    if (this.nativeBinding !== undefined) {
      if (this.authorize === undefined) throw new RustQueryUnavailableError('Native query probing requires host path authorization.');
      this.authorize(request.sourcePath);
    }

    try {
      if (this.nativeBinding !== undefined) assertNativeCapability(this.nativeBinding);
      const result = this.bridge.query(request);
      // A synchronous N-API call cannot observe an AbortSignal while it is
      // running. Never publish a native result after cancellation is visible.
      if (signal.aborted) return this.queryPortable(request, signal, 'cancelled');
      return { result, path: 'native' };
    } catch (error) {
      if (error instanceof RustQueryAuthorizationError) throw error;
      if (error instanceof RangeError) throw error;
      return this.queryPortable(request, signal, signal.aborted ? 'cancelled' : classifyFallbackReason(error));
    }
  }

  private async queryPortable(
    request: RustQueryRequest,
    signal: AbortSignal,
    fallbackReason: NativeQueryFallbackReason,
  ): Promise<NativeQueryOutcome> {
    const result = await this.portable(request, signal);
    return { result, path: 'portable', fallbackReason };
  }
}

function classifyFallbackReason(error: unknown): NativeQueryFallbackReason {
  if (error instanceof RustQueryUnavailableError) return 'missing-binary';
  const message = error instanceof Error ? error.message : String(error);
  if (/\b(?:abort|cancel)(?:ed|led)?\b/iu.test(message)) return 'cancelled';
  if (message.includes('jsonl-query:scan-budget-exceeded')
    || message.includes('jsonl-query:record-exceeds-max-bytes')
    || message.includes('jsonl-query:response-too-large')) {
    return 'budget-exhausted';
  }
  if (message.includes('unsupported') || message.includes('capabilit')) return 'unsupported-native';
  return 'native-failure';
}

function assertNativeCapability(binding: NativeQueryBindingProbe): void {
  const abiVersion = binding.abiVersion();
  if (abiVersion !== RUST_QUERY_ABI_VERSION) {
    throw new Error(`unsupported native ABI ${String(abiVersion)}`);
  }
  const capabilities = binding.capabilities();
  if (!Number.isSafeInteger(capabilities) || (capabilities & RUST_QUERY_CAPABILITY) === 0) {
    throw new Error(`unsupported native query capability ${String(capabilities)}`);
  }
}
