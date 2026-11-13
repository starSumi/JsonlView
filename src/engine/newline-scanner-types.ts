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

export interface NativeNewlineBinding {
  abiVersion(): number;
  capabilities(): number;
  scanLf(chunk: Uint8Array, start: number, limit: number): Uint32Array;
}

export interface CreateNewlineScannerOptions {
  mode?: NewlineScannerMode;
  nativeBinding?: NativeNewlineBinding;
  nativeCandidates?: readonly string[];
  platform?: NodeJS.Platform;
  architecture?: string;
}

export interface OffsetPage {
  readonly values: Uint32Array;
  readonly length: number;
}

export interface NodeScanResult {
  batch: NewlineOffsetBatch;
  strategy: NodeNewlineStrategy;
}

export interface AutoCalibrationResult {
  selected: Exclude<ActiveNewlineScanner, 'pending'>;
  calibration?: NewlineScannerCalibration;
  fallbackReason?: string;
}

export type NativeLoadResult =
  | { binding: NativeNewlineBinding; path: string }
  | { reason: string };

export const NEWLINE_BYTE = 0x0a;
export const UINT32_MAX = 0xffff_ffff;
export const NATIVE_ABI_VERSION = 2;
export const CAPABILITY_SCAN_LF = 1 << 0;
export const OFFSET_PAGE_CAPACITY = 16 * 1024;
export const MAX_NEWLINE_SCAN_BYTES = 256 * 1024;
