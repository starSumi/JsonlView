import { assertSameOffsets, scanNewlinesWithNative } from './newline-native-scan';
import {
  type AutoCalibrationResult,
  type NativeNewlineBinding,
  type NewlineOffsetBatch,
} from './newline-scanner-types';

const AUTO_MIN_SAMPLE_BYTES = 64 * 1024;
const AUTO_ROUNDS = 5;
const NATIVE_WIN_MARGIN = 0.90;

export function calibrateNewlineScanner(
  binding: NativeNewlineBinding,
  chunk: Uint8Array,
  scanNode: (value: Uint8Array) => NewlineOffsetBatch,
): AutoCalibrationResult {
  if (chunk.byteLength < AUTO_MIN_SAMPLE_BYTES) {
    return {
      selected: 'node',
      fallbackReason: `auto calibration kept node for a ${String(chunk.byteLength)} byte sample below ${String(AUTO_MIN_SAMPLE_BYTES)} bytes`,
    };
  }

  const nodeBatch = scanNode(chunk);
  const nativeBatch = scanNewlinesWithNative(binding, chunk);
  assertSameOffsets(nodeBatch, nativeBatch);
  scanNode(chunk);
  scanNewlinesWithNative(binding, chunk);

  const nodeSamples = measureRounds(AUTO_ROUNDS, () => scanNode(chunk));
  const nativeSamples = measureRounds(AUTO_ROUNDS, () => scanNewlinesWithNative(binding, chunk));
  const nodeMedianNanoseconds = median(nodeSamples);
  const nativeMedianNanoseconds = median(nativeSamples);
  const selected = nativeMedianNanoseconds < nodeMedianNanoseconds * NATIVE_WIN_MARGIN ? 'native' : 'node';
  return {
    selected,
    calibration: {
      sampleBytes: chunk.byteLength,
      newlineCount: nodeBatch.count,
      rounds: AUTO_ROUNDS,
      nodeMedianNanoseconds,
      nativeMedianNanoseconds,
      selected,
    },
    ...(selected === 'node'
      ? { fallbackReason: 'auto calibration did not show a repeatable native win of at least 10%' }
      : {}),
  };
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
