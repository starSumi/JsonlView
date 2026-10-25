import { PackedNewlineOffsets } from './newline-offset-batch';
import {
  NEWLINE_BYTE,
  OFFSET_PAGE_CAPACITY,
  UINT32_MAX,
  type NativeNewlineBinding,
  type NewlineOffsetBatch,
  type OffsetPage,
} from './newline-scanner-types';

export function scanNewlinesWithNative(
  binding: NativeNewlineBinding,
  chunk: Uint8Array,
): NewlineOffsetBatch {
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
    // A short page is the native scanner's end-of-input signal.
    if (count < OFFSET_PAGE_CAPACITY) break;
  }
  return new PackedNewlineOffsets(pages);
}

export function assertSameOffsets(left: NewlineOffsetBatch, right: NewlineOffsetBatch): void {
  const leftFingerprint = fingerprint(left);
  const rightFingerprint = fingerprint(right);
  if (leftFingerprint.count !== rightFingerprint.count || leftFingerprint.hash !== rightFingerprint.hash) {
    throw new Error('native scanner offsets did not match the adaptive Node scanner');
  }
}

function fingerprint(batch: NewlineOffsetBatch): { count: number; hash: number } {
  let hash = 0x811c9dc5;
  batch.forEach((offset) => {
    hash = Math.imul(hash ^ offset, 0x01000193) >>> 0;
  });
  return { count: batch.count, hash };
}

function asBuffer(value: Uint8Array): Buffer {
  return Buffer.isBuffer(value)
    ? value
    : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}
