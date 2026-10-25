import { calibrateNewlineScanner } from './newline-calibration';
import { loadNativeBinding, validateNativeContract } from './newline-native-binding';
import { scanNewlinesWithNative } from './newline-native-scan';
import { scanNewlinesWithNode } from './newline-node-scanner';
import {
  MAX_NEWLINE_SCAN_BYTES,
  type CreateNewlineScannerOptions,
  type NewlineOffsetBatch,
  type NewlineScanner,
  type NewlineScannerDiagnostics,
  type NewlineScannerMode,
  type NodeNewlineStrategy,
} from './newline-scanner-types';

export {
  MAX_NEWLINE_SCAN_BYTES,
  type ActiveNewlineScanner,
  type CreateNewlineScannerOptions,
  type NewlineOffsetBatch,
  type NewlineScanner,
  type NewlineScannerCalibration,
  type NewlineScannerDiagnostics,
  type NewlineScannerMode,
  type NodeNewlineStrategy,
} from './newline-scanner-types';
export { scanNewlinesWithNode } from './newline-node-scanner';

// A packaged native failure is process-wide: another Engine instance should
// not repeatedly load or call a binding that has already failed. Injected
// bindings remain instance-scoped so differential tests and embedders can
// exercise independent candidates without contaminating the process latch.
let processNativeFuseReason: string | undefined;

export function createNewlineScanner(options: CreateNewlineScannerOptions = {}): NewlineScanner {
  const requestedMode = options.mode ?? readRequestedMode();
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  let activeMode: 'pending' | 'native' | 'node' = requestedMode === 'node' ? 'node' : 'pending';
  let nativeBinding = options.nativeBinding;
  let nativePath: string | undefined = options.nativeBinding === undefined ? undefined : '<injected>';
  let fallbackReason: string | undefined;
  let calibration: NewlineScannerDiagnostics['calibration'];
  let lastNodeStrategy: NodeNewlineStrategy | undefined;
  let probed = options.nativeBinding !== undefined;
  const processFuseEligible = options.nativeBinding === undefined && options.nativeCandidates === undefined;

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
    if (processFuseEligible && processNativeFuseReason === undefined) processNativeFuseReason = reason;
  };

  const probeNative = (): typeof nativeBinding => {
    if (probed) return nativeBinding;
    probed = true;
    if (processFuseEligible && processNativeFuseReason !== undefined) {
      disableNative(`native scanner process fuse is active: ${processNativeFuseReason}`);
      return undefined;
    }
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

  return {
    scan(chunk: Uint8Array): NewlineOffsetBatch {
      if (chunk.byteLength > MAX_NEWLINE_SCAN_BYTES) {
        throw new RangeError(
          `newline scan quantum exceeds the fixed ${String(MAX_NEWLINE_SCAN_BYTES)} byte bound`,
        );
      }
      if (activeMode === 'node') return scanNode(chunk);

      // A peer packaged/default scanner may have fused the process-wide native
      // path since this instance activated it. Re-check before every native
      // call so an already-active instance cannot bypass the process fuse.
      if (processFuseEligible && processNativeFuseReason !== undefined) {
        disableNative(`native scanner process fuse is active: ${processNativeFuseReason}`);
        return scanNode(chunk);
      }

      const binding = nativeBinding ?? probeNative();
      if (binding === undefined) return scanNode(chunk);

      if (activeMode === 'pending') {
        try {
          validateNativeContract(binding);
          if (requestedMode === 'native') {
            activeMode = 'native';
          } else {
            const result = calibrateNewlineScanner(binding, chunk, scanNode);
            activeMode = result.selected;
            calibration = result.calibration;
            fallbackReason = result.fallbackReason;
          }
        } catch (error) {
          disableNative(`native scanner initialization failed: ${errorMessage(error)}`);
        }
      }

      if (activeMode === 'native' && nativeBinding !== undefined) {
        try {
          return scanNewlinesWithNative(nativeBinding, chunk);
        } catch (error) {
          disableNative(`native scanner call failed: ${errorMessage(error)}`);
        }
      }
      return scanNode(chunk);
    },
    diagnostics,
  };
}

function readRequestedMode(): NewlineScannerMode {
  const value = process.env.JSONLVIEW_NEWLINE_SCANNER?.trim().toLowerCase();
  return value === 'native' || value === 'node' ? value : 'auto';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
