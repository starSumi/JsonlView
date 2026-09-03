import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

export type NewlineScannerMode = 'auto' | 'native' | 'node';
export type ActiveNewlineScanner = 'pending' | 'native' | 'node';
export type NodeNewlineStrategy = 'indexOf' | 'number-loop';

export interface NewlineScannerCalibration {
  sampleBytes: number;
  newlineCount: number;
  rounds: number;
  nodeMedianNanoseconds: number;
  nativeMedianNanoseconds: number;
  selected: Exclude<ActiveNewlineScanner, 'pending'>;
}

export interface NewlineScannerDiagnostics {
  requestedMode: NewlineScannerMode;
  activeMode: ActiveNewlineScanner;
  maxScanBytes: number;
  lastNodeStrategy?: NodeNewlineStrategy;
  nativePath?: string;
  fallbackReason?: string;
  calibration?: NewlineScannerCalibration;
}

export interface NewlineOffsetBatch {
  readonly count: number;
  forEach(visitor: (offset: number) => void): void;
}

export interface NewlineScanner {
  scan(chunk: Uint8Array): NewlineOffsetBatch;
  diagnostics(): NewlineScannerDiagnostics;
}

interface NativeNewlineBinding {
  abiVersion(): number;
  capabilities(): number;
  scanLf(chunk: Uint8Array, start: number, limit: number): Uint32Array;
}

interface CreateNewlineScannerOptions {
  mode?: NewlineScannerMode;
  nativeBinding?: NativeNewlineBinding;
  nativeCandidates?: readonly string[];
  platform?: NodeJS.Platform;
  architecture?: string;
}

interface OffsetPage {
  values: Uint32Array;
  length: number;
}

type NativeLoadResult =
  | { binding: NativeNewlineBinding; path: string }
  | { reason: string };

let cachedNativeLoad: NativeLoadResult | undefined;

const NEWLINE_BYTE = 0x0a;
const UINT32_MAX = 0xffff_ffff;
const NATIVE_ABI_VERSION = 2;
const CAPABILITY_SCAN_LF = 1 << 0;
const OFFSET_PAGE_CAPACITY = 16 * 1024;
const DENSITY_SAMPLE_BYTES = 8 * 1024;
const AUTO_MIN_SAMPLE_BYTES = 64 * 1024;
const AUTO_ROUNDS = 5;
const NATIVE_WIN_MARGIN = 0.90;
export const MAX_NEWLINE_SCAN_BYTES = 256 * 1024;

class PackedNewlineOffsets implements NewlineOffsetBatch {
  readonly count: number;

  constructor(private readonly pages: readonly OffsetPage[]) {
    this.count = pages.reduce((total, page) => total + page.length, 0);
  }

  forEach(visitor: (offset: number) => void): void {
    for (const page of this.pages) {
      for (let index = 0; index < page.length; index += 1) {
        const offset = page.values[index];
        if (offset !== undefined) visitor(offset);
      }
    }
  }
}

class OffsetBatchBuilder {
  private readonly pages: OffsetPage[] = [];
  private current = new Uint32Array(OFFSET_PAGE_CAPACITY);
  private length = 0;

  push(offset: number): void {
    if (this.length === this.current.length) this.flush();
    this.current[this.length] = offset;
    this.length += 1;
  }

  finish(): PackedNewlineOffsets {
    this.flush();
    return new PackedNewlineOffsets(this.pages);
  }

  private flush(): void {
    if (this.length === 0) return;
    this.pages.push({ values: this.current, length: this.length });
    this.current = new Uint32Array(OFFSET_PAGE_CAPACITY);
    this.length = 0;
  }
}

export function scanNewlinesWithNode(chunk: Uint8Array): {
  batch: NewlineOffsetBatch;
  strategy: NodeNewlineStrategy;
} {
  const input = asBuffer(chunk);
  const strategy = selectNodeStrategy(input);
  const builder = new OffsetBatchBuilder();
  if (strategy === 'number-loop') {
    for (let index = 0; index < input.byteLength; index += 1) {
      if (input[index] === NEWLINE_BYTE) builder.push(index);
    }
  } else {
    let offset = input.indexOf(NEWLINE_BYTE);
    while (offset >= 0) {
      builder.push(offset);
      offset = input.indexOf(NEWLINE_BYTE, offset + 1);
    }
  }
  return { batch: builder.finish(), strategy };
}

export function createNewlineScanner(options: CreateNewlineScannerOptions = {}): NewlineScanner {
  const requestedMode = options.mode ?? readRequestedMode();
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  let activeMode: ActiveNewlineScanner = requestedMode === 'node' ? 'node' : 'pending';
  let nativeBinding = options.nativeBinding;
  let nativePath: string | undefined = options.nativeBinding === undefined ? undefined : '<injected>';
  let fallbackReason: string | undefined;
  let calibration: NewlineScannerCalibration | undefined;
  let lastNodeStrategy: NodeNewlineStrategy | undefined;
  let probed = options.nativeBinding !== undefined;

  const diagnostics = (): NewlineScannerDiagnostics => ({
    requestedMode,
    activeMode,
    maxScanBytes: MAX_NEWLINE_SCAN_BYTES,
    ...(lastNodeStrategy === undefined ? {} : { lastNodeStrategy }),
    ...(nativePath === undefined ? {} : { nativePath }),
    ...(fallbackReason === undefined ? {} : { fallbackReason }),
    ...(calibration === undefined ? {} : { calibration }),
  });

  const scanNode = (chunk: Uint8Array): NewlineOffsetBatch => {
    const result = scanNewlinesWithNode(chunk);
    lastNodeStrategy = result.strategy;
    return result.batch;
  };

  const disableNative = (reason: string): void => {
    nativeBinding = undefined;
    activeMode = 'node';
    fallbackReason = reason;
  };

  const probeNative = (): NativeNewlineBinding | undefined => {
    if (probed) return nativeBinding;
    probed = true;
    if (requestedMode === 'auto' && (platform !== 'win32' || architecture !== 'x64')) {
      disableNative(`native auto mode is experimental and limited to win32-x64, observed ${platform}-${architecture}`);
      return undefined;
    }
    const loaded = loadNativeBinding(options.nativeCandidates);
    if ('binding' in loaded) {
      nativeBinding = loaded.binding;
      nativePath = loaded.path;
      return nativeBinding;
    }
    disableNative(loaded.reason);
    return undefined;
  };

  const scanNative = (binding: NativeNewlineBinding, chunk: Uint8Array): NewlineOffsetBatch => {
    if (chunk.byteLength > UINT32_MAX) {
      throw new Error(`native scanner input exceeds the u32 offset domain (${String(chunk.byteLength)} bytes)`);
    }
    const input = asBuffer(chunk);
    const pages: OffsetPage[] = [];
    let start = 0;
    while (start < input.byteLength) {
      const output = binding.scanLf(input, start, OFFSET_PAGE_CAPACITY);
      if (!(output instanceof Uint32Array) || output.length > OFFSET_PAGE_CAPACITY) {
        throw new Error('native scanner returned an invalid offset batch');
      }
      const count = output.length;
      if (count === 0) break;

      let previous = start - 1;
      for (let index = 0; index < count; index += 1) {
        const offset = output[index];
        if (offset === undefined || offset <= previous || offset >= input.byteLength || input[offset] !== NEWLINE_BYTE) {
          throw new Error(`native scanner returned an invalid newline offset at index ${String(index)}`);
        }
        previous = offset;
      }
      pages.push({ values: output, length: count });
      start = previous + 1;
      if (count < output.length) break;
    }
    return new PackedNewlineOffsets(pages);
  };

  const runAutoCalibration = (
    binding: NativeNewlineBinding,
    chunk: Uint8Array,
  ): Exclude<ActiveNewlineScanner, 'pending'> => {
    if (chunk.byteLength < AUTO_MIN_SAMPLE_BYTES) {
      fallbackReason = `auto calibration kept node for a ${String(chunk.byteLength)} byte sample below ${String(AUTO_MIN_SAMPLE_BYTES)} bytes`;
      return 'node';
    }

    const nodeBatch = scanNode(chunk);
    const nativeBatch = scanNative(binding, chunk);
    assertSameOffsets(nodeBatch, nativeBatch);
    scanNode(chunk);
    scanNative(binding, chunk);

    const nodeSamples = measureRounds(AUTO_ROUNDS, () => scanNode(chunk));
    const nativeSamples = measureRounds(AUTO_ROUNDS, () => scanNative(binding, chunk));
    const nodeMedianNanoseconds = median(nodeSamples);
    const nativeMedianNanoseconds = median(nativeSamples);
    const selected = nativeMedianNanoseconds < nodeMedianNanoseconds * NATIVE_WIN_MARGIN ? 'native' : 'node';
    calibration = {
      sampleBytes: chunk.byteLength,
      newlineCount: nodeBatch.count,
      rounds: AUTO_ROUNDS,
      nodeMedianNanoseconds,
      nativeMedianNanoseconds,
      selected,
    };
    if (selected === 'node') {
      fallbackReason = 'auto calibration did not show a repeatable native win of at least 10%';
    }
    return selected;
  };

  return {
    scan(chunk) {
      if (chunk.byteLength > MAX_NEWLINE_SCAN_BYTES) {
        throw new RangeError(
          `newline scan quantum exceeds the fixed ${String(MAX_NEWLINE_SCAN_BYTES)} byte bound`,
        );
      }
      if (activeMode === 'node') return scanNode(chunk);

      const binding = nativeBinding ?? probeNative();
      if (binding === undefined) return scanNode(chunk);

      if (activeMode === 'pending') {
        try {
          validateNativeContract(binding);
          activeMode = requestedMode === 'native'
            ? 'native'
            : runAutoCalibration(binding, chunk);
        } catch (error) {
          disableNative(`native scanner initialization failed: ${errorMessage(error)}`);
        }
      }

      if (activeMode === 'native' && nativeBinding !== undefined) {
        try {
          return scanNative(nativeBinding, chunk);
        } catch (error) {
          disableNative(`native scanner call failed: ${errorMessage(error)}`);
        }
      }
      return scanNode(chunk);
    },
    diagnostics,
  };
}

function selectNodeStrategy(input: Buffer): NodeNewlineStrategy {
  const sampleLength = Math.min(input.byteLength, DENSITY_SAMPLE_BYTES);
  if (sampleLength < 64) return 'indexOf';
  const denseThreshold = Math.max(8, Math.floor(sampleLength / 8));
  let count = 0;
  let offset = input.indexOf(NEWLINE_BYTE);
  while (offset >= 0 && offset < sampleLength) {
    count += 1;
    if (count >= denseThreshold) return 'number-loop';
    offset = input.indexOf(NEWLINE_BYTE, offset + 1);
  }
  return 'indexOf';
}

function readRequestedMode(): NewlineScannerMode {
  const value = process.env.JSONLVIEW_NEWLINE_SCANNER?.trim().toLowerCase();
  return value === 'native' || value === 'node' ? value : 'auto';
}

function loadNativeBinding(candidatesOverride?: readonly string[]): NativeLoadResult {
  if (candidatesOverride === undefined && cachedNativeLoad !== undefined) return cachedNativeLoad;
  const candidates = candidatesOverride ?? nativeCandidates();
  const attempted: string[] = [];
  const loadErrors: string[] = [];
  const runtimeFilename = typeof __filename === 'string'
    ? __filename
    : join(process.cwd(), 'package.json');
  const runtimeRequire = createRequire(runtimeFilename);

  for (const candidate of candidates) {
    const absolute = resolve(candidate);
    if (!existsSync(absolute)) continue;
    attempted.push(absolute);
    try {
      const loaded = runtimeRequire(absolute) as Partial<NativeNewlineBinding>;
      if (
        typeof loaded.abiVersion !== 'function'
        || typeof loaded.capabilities !== 'function'
        || typeof loaded.scanLf !== 'function'
      ) {
        continue;
      }
      const result = { binding: loaded as NativeNewlineBinding, path: absolute };
      if (candidatesOverride === undefined) cachedNativeLoad = result;
      return result;
    } catch (error) {
      loadErrors.push(`${absolute}: ${errorMessage(error)}`);
    }
  }

  const result = {
    reason: loadErrors.length > 0
      ? `unable to load native addon candidates: ${loadErrors.join('; ')}`
      : attempted.length > 0
      ? `native addon did not expose the required ABI: ${attempted.join(', ')}`
      : 'native addon was not found; using the adaptive Node scanner',
  };
  if (candidatesOverride === undefined) cachedNativeLoad = result;
  return result;
}

function nativeCandidates(): string[] {
  const runtimeDirectory = typeof __filename === 'string'
    ? dirname(__filename)
    : undefined;
  if (runtimeDirectory === undefined) return [];
  const roots = [
    resolve(runtimeDirectory, '..', 'native', 'jsonl-core'),
  ];
  const names = [
    'jsonl_core.win32-x64-msvc.node',
    'jsonl-core.win32-x64-msvc.node',
    'jsonl_core.node',
    'jsonl-core.node',
    'index.node',
  ];
  return [...new Set(roots.flatMap((root) => names.map((name) => join(root, name))))];
}

function validateNativeContract(binding: NativeNewlineBinding): void {
  const abiVersion = binding.abiVersion();
  if (abiVersion !== NATIVE_ABI_VERSION) {
    throw new Error(`unsupported native ABI ${String(abiVersion)}, expected ${String(NATIVE_ABI_VERSION)}`);
  }
  const capabilities = binding.capabilities();
  if (!Number.isSafeInteger(capabilities) || (capabilities & CAPABILITY_SCAN_LF) === 0) {
    throw new Error(`native capabilities ${String(capabilities)} do not include scanLf`);
  }
}

function asBuffer(value: Uint8Array): Buffer {
  return Buffer.isBuffer(value)
    ? value
    : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function fingerprint(batch: NewlineOffsetBatch): { count: number; hash: number } {
  let hash = 0x811c9dc5;
  batch.forEach((offset) => {
    hash = Math.imul(hash ^ offset, 0x01000193) >>> 0;
  });
  return { count: batch.count, hash };
}

function assertSameOffsets(left: NewlineOffsetBatch, right: NewlineOffsetBatch): void {
  const leftFingerprint = fingerprint(left);
  const rightFingerprint = fingerprint(right);
  if (leftFingerprint.count !== rightFingerprint.count || leftFingerprint.hash !== rightFingerprint.hash) {
    throw new Error('native scanner offsets did not match the adaptive Node scanner');
  }
}

function measureRounds(rounds: number, run: () => NewlineOffsetBatch): number[] {
  const samples: number[] = [];
  for (let round = 0; round < rounds; round += 1) {
    const start = process.hrtime.bigint();
    run();
    samples.push(Number(process.hrtime.bigint() - start));
  }
  return samples;
}

function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
