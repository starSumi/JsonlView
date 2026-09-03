import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const PAGE_CAPACITY = 16 * 1024;
function main() {
const options = parseArguments(process.argv.slice(2));
const input = options.file === undefined
  ? generatedInput(options.sizeMiB * 1024 * 1024, options.lineBytes)
  : readFileSync(options.file);
const native = loadNative();
const referenceInput = input.subarray(0, Math.min(input.byteLength, 8 * 1024 * 1024));

const referenceFingerprint = fingerprint(scanOldLoop(referenceInput));
assertSame('old JS loop vs Buffer.indexOf reference sample', referenceFingerprint, fingerprint(scanIndexOf(referenceInput)));
const expected = fingerprint(scanIndexOf(input));

const results = {
  input: {
    source: options.file === undefined ? 'generated' : resolve(options.file),
    bytes: input.byteLength,
    referenceBytes: referenceInput.byteLength,
    newlineCount: expected.count,
    offsetHash: expected.hash,
  },
  settings: { warmup: options.warmup, rounds: options.rounds, pageCapacity: PAGE_CAPACITY },
  scanners: {
    oldJsLoopReference: benchmark(
      () => scanOldLoop(referenceInput),
      options,
      referenceInput.byteLength,
    ),
    bufferIndexOf: benchmark(() => scanIndexOf(input), options, input.byteLength),
    denseNumberLoop: benchmark(() => scanNumberLoop(input), options, input.byteLength),
  },
};

if (native === undefined) {
  results.scanners.nativeScanLfInto = { available: false };
} else {
  const contract = { abiVersion: native.binding.abiVersion(), capabilities: native.binding.capabilities() };
  if (contract.abiVersion !== 1 || (contract.capabilities & 1) === 0) {
    throw new Error(`native ABI mismatch: ${JSON.stringify(contract)}`);
  }
  assertSame('native vs Buffer.indexOf full input', fingerprint(scanNative(input, native.binding)), expected);
  assertSame(
    'native vs old JS loop reference sample',
    fingerprint(scanNative(referenceInput, native.binding)),
    referenceFingerprint,
  );
  results.scanners.nativeScanLfInto = {
    available: true,
    path: native.path,
    contract,
    ...benchmark(() => scanNative(input, native.binding), options, input.byteLength),
  };
}

console.log(JSON.stringify(results, null, 2));
}

function scanOldLoop(buffer) {
  const pages = new Pages();
  for (let index = 0; index < buffer.byteLength; index += 1) {
    if (buffer[index] === 0x0a) pages.push(index);
  }
  return pages;
}

function scanIndexOf(buffer) {
  const pages = new Pages();
  let offset = buffer.indexOf(0x0a);
  while (offset >= 0) {
    pages.push(offset);
    offset = buffer.indexOf(0x0a, offset + 1);
  }
  return pages;
}

function scanNumberLoop(buffer) {
  const pages = new Pages();
  for (let index = 0; index < buffer.byteLength; index += 1) {
    if (buffer[index] === 0x0a) pages.push(index);
  }
  return pages;
}

function scanNative(buffer, binding) {
  const pages = new Pages();
  let start = 0;
  while (start < buffer.byteLength) {
    const output = binding.scanLf(buffer, start, PAGE_CAPACITY);
    if (!(output instanceof Uint32Array) || output.length > PAGE_CAPACITY) {
      throw new Error('native returned invalid offset batch');
    }
    const count = output.length;
    if (count === 0) break;
    let previous = start - 1;
    for (let index = 0; index < count; index += 1) {
      const offset = output[index];
      if (offset <= previous || offset >= buffer.byteLength || buffer[offset] !== 0x0a) {
        throw new Error(`native returned invalid offset at ${String(index)}`);
      }
      previous = offset;
    }
    pages.add(output, count);
    start = previous + 1;
    if (count < output.length) break;
  }
  return pages;
}

class Pages {
  pages = [];
  current = new Uint32Array(PAGE_CAPACITY);
  length = 0;
  count = 0;

  push(offset) {
    if (this.length === this.current.length) this.flush();
    this.current[this.length] = offset;
    this.length += 1;
    this.count += 1;
  }

  add(values, length) {
    this.flush();
    this.pages.push({ values, length });
    this.count += length;
  }

  flush() {
    if (this.length === 0) return;
    this.pages.push({ values: this.current, length: this.length });
    this.current = new Uint32Array(PAGE_CAPACITY);
    this.length = 0;
  }

  finish() {
    this.flush();
    return this.pages;
  }
}

function fingerprint(pages) {
  let hash = 0x811c9dc5;
  let count = 0;
  for (const page of pages.finish()) {
    for (let index = 0; index < page.length; index += 1) {
      hash = Math.imul(hash ^ page.values[index], 0x01000193) >>> 0;
      count += 1;
    }
  }
  return { count, hash };
}

function benchmark(run, settings, bytes) {
  for (let index = 0; index < settings.warmup; index += 1) run();
  const samples = [];
  let count = 0;
  for (let index = 0; index < settings.rounds; index += 1) {
    const start = performance.now();
    const pages = run();
    count = pages.count;
    samples.push(performance.now() - start);
  }
  samples.sort((left, right) => left - right);
  const medianMs = samples[Math.floor(samples.length / 2)];
  const p95Ms = samples[Math.ceil(samples.length * 0.95) - 1];
  return {
    count,
    medianMs: round(medianMs),
    p95Ms: round(p95Ms),
    medianMiBPerSecond: round((bytes / (1024 * 1024)) / (medianMs / 1000)),
  };
}

function generatedInput(length, lineBytes) {
  const output = Buffer.allocUnsafe(length).fill(0x78);
  for (let offset = lineBytes - 1; offset < length; offset += lineBytes) output[offset] = 0x0a;
  return output;
}

function loadNative() {
  const configured = process.env.JSONLVIEW_NEWLINE_NATIVE_PATH;
  const candidates = configured === undefined
    ? [
        'native/jsonl-core/jsonl_core.win32-x64-msvc.node',
        'native/jsonl-core/jsonl-core.win32-x64-msvc.node',
        'native/jsonl-core/jsonl_core.node',
        'native/jsonl-core/jsonl-core.node',
        'native/jsonl-core/index.node',
      ]
    : [configured];
  const localRequire = createRequire(import.meta.url);
  for (const candidate of candidates) {
    const path = resolve(candidate);
    if (!existsSync(path)) continue;
    const binding = localRequire(path);
    if (
      typeof binding.abiVersion === 'function'
      && typeof binding.capabilities === 'function'
      && typeof binding.scanLf === 'function'
    ) {
      return { binding, path };
    }
  }
  return undefined;
}

function parseArguments(arguments_) {
  const parsed = { sizeMiB: 32, lineBytes: 256, warmup: 2, rounds: 9, file: undefined };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const next = arguments_[index + 1];
    if (argument === '--file' && next !== undefined) parsed.file = next;
    else if (argument === '--size-mib' && next !== undefined) parsed.sizeMiB = positiveInteger(next, argument);
    else if (argument === '--line-bytes' && next !== undefined) parsed.lineBytes = positiveInteger(next, argument);
    else if (argument === '--warmup' && next !== undefined) parsed.warmup = positiveInteger(next, argument);
    else if (argument === '--rounds' && next !== undefined) parsed.rounds = positiveInteger(next, argument);
    else continue;
    index += 1;
  }
  return parsed;
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} requires a positive integer`);
  return parsed;
}

function assertSame(label, left, right) {
  if (left.count !== right.count || left.hash !== right.hash) {
    throw new Error(`${label} mismatch: ${JSON.stringify({ left, right })}`);
  }
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

main();
