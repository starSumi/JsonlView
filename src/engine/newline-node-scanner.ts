import { OffsetBatchBuilder } from './newline-offset-batch';
import {
  NEWLINE_BYTE,
  type NodeNewlineStrategy,
  type NodeScanResult,
} from './newline-scanner-types';

export function scanNewlinesWithNode(chunk: Uint8Array): NodeScanResult {
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

function selectNodeStrategy(input: Buffer): NodeNewlineStrategy {
  const sampleLength = Math.min(input.byteLength, 8 * 1024);
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

function asBuffer(value: Uint8Array): Buffer {
  return Buffer.isBuffer(value)
    ? value
    : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}
