import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { JsonlFileEngine, type NativeNewlineScannerSetting } from '../src/engine';

interface Arguments {
  file: string;
  scanner: NativeNewlineScannerSetting;
  query: boolean;
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
const engine = await JsonlFileEngine.open(options.file, { newlineScanner: options.scanner });
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
      ...(errorQuery === undefined ? {} : { errorQuery }),
    },
    result: {
      indexedBytes: indexed.indexedBytes,
      indexedRecords: indexed.indexedRecords,
      firstRows: first.rows.length,
      reverseRows: reverse.rows.length,
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
  let file: string | undefined;
  let scanner: NativeNewlineScannerSetting = 'off';
  let query = true;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    const next = values[index + 1];
    if (value === '--file' && next !== undefined) {
      file = resolve(next);
      index += 1;
    } else if (value === '--scanner' && (next === 'off' || next === 'auto' || next === 'on')) {
      scanner = next;
      index += 1;
    } else if (value === '--no-query') {
      query = false;
    }
  }
  if (file === undefined) throw new Error('Usage: pnpm benchmark:engine --file <path> [--scanner off|auto|on] [--no-query]');
  return { file, scanner, query };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
