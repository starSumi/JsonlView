import { describe, expect, it } from 'vitest';
import {
  createNewlineScanner,
  MAX_NEWLINE_SCAN_BYTES,
  scanNewlinesWithNode,
  type NewlineOffsetBatch,
} from '../../src/engine/newline-scanner';

function collect(batch: NewlineOffsetBatch): number[] {
  const offsets: number[] = [];
  batch.forEach((offset) => offsets.push(offset));
  return offsets;
}

function validBinding(overrides: Partial<{
  abiVersion(): number;
  capabilities(): number;
  scanLf(chunk: Uint8Array, start: number, limit: number): Uint32Array;
}> = {}) {
  return {
    abiVersion: () => 2,
    capabilities: () => 1,
    scanLf(chunk: Uint8Array, start: number, limit: number): Uint32Array {
      const output = new Uint32Array(limit);
      let count = 0;
      for (let index = start; index < chunk.byteLength && count < output.length; index += 1) {
        if (chunk[index] === 0x0a) {
          output[count] = index;
          count += 1;
        }
      }
      return output.slice(0, count);
    },
    ...overrides,
  };
}

describe('newline scanner', () => {
  it('uses Buffer.indexOf for sparse data and a number loop for extremely dense data', () => {
    const empty = scanNewlinesWithNode(Buffer.alloc(0));
    expect(collect(empty.batch)).toEqual([]);
    expect(empty.strategy).toBe('indexOf');

    const sparse = scanNewlinesWithNode(Buffer.from('a\nb\n'));
    expect(collect(sparse.batch)).toEqual([1, 3]);
    expect(sparse.strategy).toBe('indexOf');

    const dense = scanNewlinesWithNode(Buffer.alloc(8 * 1024, 0x0a));
    expect(dense.batch.count).toBe(8 * 1024);
    expect(dense.strategy).toBe('number-loop');
  });

  it('honors the byte offset of typed-array views', () => {
    const storage = Buffer.from('prefix-a\nb\n-suffix');
    const view = new Uint8Array(storage.buffer, storage.byteOffset + 7, 4);
    expect(Buffer.from(view).toString()).toBe('a\nb\n');
    expect(collect(scanNewlinesWithNode(view).batch)).toEqual([1, 3]);
  });

  it('uses the bounded owned-result scanLf ABI and follows full-page continuations', () => {
    const scanner = createNewlineScanner({ mode: 'native', nativeBinding: validBinding() });
    const dense = Buffer.alloc(16 * 1024 + 3, 0x0a);
    const offsets = collect(scanner.scan(dense));
    expect(offsets).toHaveLength(dense.length);
    expect(offsets[0]).toBe(0);
    expect(offsets.at(-1)).toBe(dense.length - 1);
    expect(scanner.diagnostics().activeMode).toBe('native');
  });

  it('rejects ABI mismatches before calling native and falls back diagnostically', () => {
    let calls = 0;
    const scanner = createNewlineScanner({
      mode: 'native',
      nativeBinding: validBinding({
        abiVersion: () => 1,
        scanLf() {
          calls += 1;
          return new Uint32Array();
        },
      }),
    });

    expect(collect(scanner.scan(Buffer.from('a\nb\n')))).toEqual([1, 3]);
    expect(calls).toBe(0);
    expect(scanner.diagnostics()).toMatchObject({
      requestedMode: 'native',
      activeMode: 'node',
    });
    expect(scanner.diagnostics().fallbackReason).toContain('unsupported native ABI');
  });

  it('stages native results, validates offsets, and fuses to node after one failure', () => {
    let calls = 0;
    const scanner = createNewlineScanner({
      mode: 'native',
      nativeBinding: validBinding({
        scanLf(_chunk, _start, _limit) {
          calls += 1;
          return new Uint32Array([2]);
        },
      }),
    });

    expect(collect(scanner.scan(Buffer.from('a\nb\n')))).toEqual([1, 3]);
    expect(collect(scanner.scan(Buffer.from('\n')))).toEqual([0]);
    expect(calls).toBe(1);
    expect(scanner.diagnostics().fallbackReason).toContain('invalid newline offset');
  });

  it('limits experimental auto mode to win32-x64', () => {
    const scanner = createNewlineScanner({
      mode: 'auto',
      nativeCandidates: [],
      platform: 'linux',
      architecture: 'x64',
    });
    expect(collect(scanner.scan(Buffer.from('a\n')))).toEqual([1]);
    expect(scanner.diagnostics().activeMode).toBe('node');
    expect(scanner.diagnostics().fallbackReason).toContain('limited to win32-x64');
  });

  it('keeps node in auto mode for samples too small to benchmark responsibly', () => {
    const scanner = createNewlineScanner({ mode: 'auto', nativeBinding: validBinding() });
    expect(collect(scanner.scan(Buffer.from('a\nb\n')))).toEqual([1, 3]);
    expect(scanner.diagnostics()).toMatchObject({ requestedMode: 'auto', activeMode: 'node' });
    expect(scanner.diagnostics().fallbackReason).toContain('sample below');
  });

  it('enforces a 256 KiB scan quantum and reports the bound diagnostically', () => {
    const scanner = createNewlineScanner({ mode: 'node' });
    expect(scanner.diagnostics().maxScanBytes).toBe(256 * 1024);
    expect(MAX_NEWLINE_SCAN_BYTES).toBe(256 * 1024);
    expect(scanner.scan(Buffer.alloc(MAX_NEWLINE_SCAN_BYTES, 0x0a)).count).toBe(MAX_NEWLINE_SCAN_BYTES);
    expect(() => scanner.scan(Buffer.alloc(MAX_NEWLINE_SCAN_BYTES + 1))).toThrow('fixed 262144 byte bound');
  });
});
