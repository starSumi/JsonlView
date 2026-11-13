import { createHash } from 'node:crypto';
import { stat, type FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { JsonlFileEngine, type NativeNewlineScannerSetting } from '../src/engine';

interface Arguments {
  file: string;
  scanner: NativeNewlineScannerSetting;
  query: boolean;
  pageSamples: number;
  pageWarmup: number;
}

interface ReadCounter {
  calls: number;
  bytes: number;
  reset(): void;
  restore(): void;
}

const options = parseArguments(process.argv.slice(2));
const sourceBefore = await stat(options.file, { bigint: true });
const rssBefore = process.memoryUsage().rss;
let peakRss = rssBefore;
const sampleRss = (): number => {
  const current = process.memoryUsage().rss;
  peakRss = Math.max(peakRss, current);
  return current;
};

const openStart = performance.now();
const engine = await JsonlFileEngine.open(options.file, {
  newlineScanner: options.scanner,
  generation: 'benchmark',
});
const openMs = performance.now() - openStart;

try {
  const firstStart = performance.now();
  const first = await engine.getRows({ limit: 100 });
  const firstPageMs = performance.now() - firstStart;
  sampleRss();

  const indexStart = performance.now();
  const indexed = await engine.finishIndexing();
  const fullIndexMs = performance.now() - indexStart;
  sampleRss();

  const pageTimings: number[] = [];
  let pageDigest: string | undefined;
  for (let index = 0; index < options.pageWarmup + options.pageSamples; index += 1) {
    const pageStart = performance.now();
    const page = await engine.getRows({ limit: 100 });
    const elapsed = performance.now() - pageStart;
    const digest = digestRows(page.rows);
    if (pageDigest !== undefined && pageDigest !== digest) {
      throw new Error('Repeated forward-page queries produced different row digests.');
    }
    pageDigest = digest;
    if (index >= options.pageWarmup) {
      pageTimings.push(elapsed);
    }
    sampleRss();
  }

  const pageReadCalls: number[] = [];
  const pageReadBytes: number[] = [];
  const readCounter = countFileHandleReads(engine);
  try {
    for (let index = 0; index < options.pageSamples; index += 1) {
      readCounter.reset();
      const page = await engine.getRows({ limit: 100 });
      const digest = digestRows(page.rows);
      if (pageDigest !== digest) {
        throw new Error('Instrumented forward-page query did not match the timed result digest.');
      }
      pageReadCalls.push(readCounter.calls);
      pageReadBytes.push(readCounter.bytes);
    }
  } finally {
    readCounter.restore();
  }

  const reverseStart = performance.now();
  const reverse = await engine.getRows({
    anchorOrdinal: indexed.indexedRecords,
    direction: 'backward',
    limit: 100,
  });
  const reversePageMs = performance.now() - reverseStart;
  sampleRss();

  let errorQuery: { milliseconds: number; rows: number; hasAfter: boolean } | undefined;
  if (options.query) {
    const queryStart = performance.now();
    const page = await engine.getRows({
      limit: 100,
      predicate: { op: 'text_search', value: 'error', caseSensitive: false },
    });
    errorQuery = {
      milliseconds: round(performance.now() - queryStart),
      rows: page.rows.length,
      hasAfter: page.hasAfter,
    };
    sampleRss();
  }

  const sourceAfter = await stat(options.file, { bigint: true });
  if (sourceAfter.size !== sourceBefore.size || sourceAfter.mtimeNs !== sourceBefore.mtimeNs) {
    throw new Error('Benchmark source changed while the run was active.');
  }

  const digest = createHash('sha256');
  for (const row of [...first.rows, ...reverse.rows]) {
    digest.update(row.ref.ordinal);
    digest.update(':');
    digest.update(row.ref.byteStart);
    digest.update(':');
    digest.update(row.ref.byteEndExclusive);
    digest.update('\n');
  }

  console.log(JSON.stringify({
    source: {
      path: options.file,
      bytes: sourceBefore.size.toString(),
      mtimeNs: sourceBefore.mtimeNs.toString(),
    },
    runtime: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      scanner: options.scanner,
    },
    timings: {
      openMs: round(openMs),
      firstPageMs: round(firstPageMs),
      fullIndexMs: round(fullIndexMs),
      reversePageMs: round(reversePageMs),
      indexedForwardPage: {
        samples: pageTimings.length,
        warmup: options.pageWarmup,
        p50Ms: percentile(pageTimings, 0.5),
        p95Ms: percentile(pageTimings, 0.95),
      },
      ...(errorQuery === undefined ? {} : { errorQuery }),
    },
    io: {
      indexedForwardPage: {
        readCallsP50: percentile(pageReadCalls, 0.5),
        readCallsP95: percentile(pageReadCalls, 0.95),
        bytesReadP50: percentile(pageReadBytes, 0.5),
        bytesReadP95: percentile(pageReadBytes, 0.95),
      },
    },
    result: {
      indexedBytes: indexed.indexedBytes,
      indexedRecords: indexed.indexedRecords,
      firstRows: first.rows.length,
      reverseRows: reverse.rows.length,
      indexedForwardPageDigest: pageDigest,
      boundaryDigest: digest.digest('hex'),
    },
    memory: {
      rssBeforeBytes: rssBefore,
      peakObservedRssBytes: peakRss,
      deltaBytes: peakRss - rssBefore,
    },
    diagnostics: engine.getDiagnostics(),
  }, null, 2));
} finally {
  await engine.dispose();
}

function parseArguments(values: string[]): Arguments {
  const args = values[0] === '--' ? values.slice(1) : values;
  let file: string | undefined;
  let scanner: NativeNewlineScannerSetting = 'off';
  let query = true;
  let pageSamples = 12;
  let pageWarmup = 2;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    const next = args[index + 1];
    if (value === '--file') {
      if (next === undefined || next.startsWith('--')) throw new Error('--file requires a path');
      file = resolve(next);
      index += 1;
    } else if (value === '--scanner') {
      if (next !== 'off' && next !== 'auto' && next !== 'on') {
        throw new Error('--scanner requires one of: off, auto, on');
      }
      scanner = next;
      index += 1;
    } else if (value === '--no-query') {
      query = false;
    } else if (value === '--page-samples') {
      pageSamples = parseBoundedCount('--page-samples', next, 1, 100);
      index += 1;
    } else if (value === '--page-warmup') {
      pageWarmup = parseBoundedCount('--page-warmup', next, 0, 20);
      index += 1;
    } else {
      throw new Error(`unknown argument: ${value}`);
    }
  }
  if (file === undefined) {
    throw new Error('Usage: pnpm benchmark:engine --file <path> [--scanner off|auto|on] [--no-query] [--page-samples 1..100] [--page-warmup 0..20]');
  }
  return { file, scanner, query, pageSamples, pageWarmup };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index] ?? 0;
}

function parseBoundedCount(name: string, value: string | undefined, minimum: number, maximum: number): number {
  if (value === undefined || value.startsWith('--')) throw new Error(name + ' requires an integer.');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(name + ' must be an integer from ' + String(minimum) + ' to ' + String(maximum) + '.');
  }
  return parsed;
}

function digestRows(rows: readonly unknown[]): string {
  const digest = createHash('sha256');
  for (const row of rows) digest.update(JSON.stringify(row) ?? '');
  return digest.digest('hex');
}

function countFileHandleReads(engine: JsonlFileEngine): ReadCounter {
  type PositionalRead = (
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | bigint | null,
  ) => Promise<{ bytesRead: number; buffer: Buffer }>;
  const handle = (engine as unknown as { handle: FileHandle }).handle;
  const originalRead = handle.read.bind(handle) as PositionalRead;
  const originalDescriptor = Object.getOwnPropertyDescriptor(handle, 'read');
  const counter: ReadCounter = {
    calls: 0,
    bytes: 0,
    reset() {
      this.calls = 0;
      this.bytes = 0;
    },
    restore() {
      if (originalDescriptor === undefined) {
        Reflect.deleteProperty(handle, 'read');
      } else {
        Object.defineProperty(handle, 'read', originalDescriptor);
      }
    },
  };
  Object.defineProperty(handle, 'read', {
    configurable: true,
    value: async (buffer: Buffer, offset: number, length: number, position: number | bigint | null) => {
      counter.calls += 1;
      const result = await originalRead(buffer, offset, length, position);
      counter.bytes += result.bytesRead;
      return result;
    },
  });
  return counter;
}
