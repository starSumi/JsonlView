import { lstatSync, realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import {
  StagedMutationError,
  StagedMutationSession,
  editFor,
  sha256,
  type BaseEdit,
  type StageIntent,
} from '../experimental/staged-mutation/index';

export const MUTATION_BENCHMARK_SCHEMA_VERSION = 2 as const;
export const MUTATION_WORKLOAD_VERSION = 2 as const;
export const DEFAULT_MUTATION_CASES = [
  { name: '64KiB', bytes: 64 * 1024 },
  { name: '1MiB', bytes: 1024 * 1024 },
] as const;

interface BenchmarkOptions {
  iterations?: number;
  warmup?: number;
  cases?: readonly { name: string; bytes: number }[];
}

interface BenchmarkCase {
  name: string;
  targetBytes: number;
  actualBytes: number;
  editCount: number;
  samples: number;
  oracleMatches: boolean;
  candidateDigest: string;
  oracleDigest: string;
  bytesCopied: number;
  timingsMs: { p50Ms: number; p95Ms: number; maxMs: number };
  plainBaseline: {
    bytesCopied: number;
    digest: string;
    timingsMs: { p50Ms: number; p95Ms: number; maxMs: number };
  };
}

interface ScenarioEvidence {
  cancellationLatencyMs: number | null;
  unknownCommitElapsedMs: number | null;
  unknownCommitReceipt: UnknownCommitReceiptProvenance | null;
}

export interface UnknownCommitReceiptProvenance {
  operationId: string;
  state: 'unknownCommit';
  sourceUnchanged: 'unknown';
  stagingGeneration: string;
  diffDigest: string;
  reason: string;
}

export interface FailureReplayReceipt {
  schemaVersion: typeof MUTATION_BENCHMARK_SCHEMA_VERSION;
  scenario: string;
  expectedCode: string;
  observedCode: string;
  status: 'rejected' | 'wrong_failure' | 'unexpected_success';
  sourceUnchanged: true | 'unknown';
  sourceDigestBefore: string;
  sourceDigestAfter: string;
  stagingGeneration: string;
  cancellationLatencyMs: number | null;
  unknownCommitElapsedMs: number | null;
  unknownCommitReceipt: UnknownCommitReceiptProvenance | null;
}

export interface SyntheticNewlineCorpus {
  name: 'crlf' | 'mixed' | 'partial-tail';
  bytes: number;
  digest: string;
  detectedNewline: 'lf' | 'crlf' | 'mixed' | 'none' | 'unknown';
  partialTail: boolean;
  status: 'observed';
}

export interface MutationBenchmarkReport {
  schemaVersion: typeof MUTATION_BENCHMARK_SCHEMA_VERSION;
  workloadVersion: typeof MUTATION_WORKLOAD_VERSION;
  mode: 'synthetic-memory-only';
  benchmark: { iterations: number; warmup: number; cases: BenchmarkCase[] };
  newlineCorpora: SyntheticNewlineCorpus[];
  failureReplay: { allRejectedAsExpected: boolean; receipts: FailureReplayReceipt[] };
  runtime: {
    node: string;
    platform: string;
    architecture: string;
    resourceMetrics: {
      peakRssBytes: number | null;
      status: 'partial' | 'unavailable';
      samples: number;
      method: string;
      reason: string;
    };
    cancellation: {
      latencyMs: number | null;
      status: 'partial' | 'unavailable';
      mode: 'pre-aborted-signal';
      reason: string;
    };
  };
  timingInterpretation: {
    status: 'partial';
    text: string;
  };
}

/** Deterministic bytes; no filesystem or producer store is consulted. */
export function createSyntheticBase(sizeBytes: number): Uint8Array {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1) throw new Error('Synthetic size must be positive.');
  const bytes = new Uint8Array(sizeBytes);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 31 + 17) & 0xff;
  return bytes;
}

export function createSyntheticEdits(base: Uint8Array): BaseEdit[] {
  const points = [Math.floor(base.byteLength * 0.2), Math.floor(base.byteLength * 0.5), Math.floor(base.byteLength * 0.8)];
  const lengths = [17, 64, 257];
  return points.map((start, index) => {
    const end = Math.min(base.byteLength, start + lengths[index]!);
    const replacement = Uint8Array.from({ length: index === 1 ? lengths[index]! + 11 : Math.max(1, lengths[index]! - 3) }, () => 0xa0 + index);
    return editFor(base, BigInt(start), BigInt(end), replacement);
  });
}

export function materializeOracle(base: Uint8Array, edits: readonly BaseEdit[]): Uint8Array {
  const output: number[] = [];
  let cursor = 0n;
  for (let index = 0; index < base.byteLength; index += 1) {
    const edit = edits.find((candidate) => candidate.start === BigInt(index));
    if (edit !== undefined) {
      output.push(...edit.replacement);
      index = Number(edit.endExclusive) - 1;
      cursor = edit.endExclusive;
    } else {
      output.push(base[index]!);
      cursor = BigInt(index + 1);
    }
  }
  if (cursor < BigInt(base.byteLength)) output.push(...base.slice(Number(cursor)));
  return Uint8Array.from(output);
}

export function summarize(values: readonly number[]): { p50Ms: number; p95Ms: number; maxMs: number } {
  const ordered = [...values].sort((left, right) => left - right);
  if (ordered.length === 0) return { p50Ms: 0, p95Ms: 0, maxMs: 0 };
  return {
    p50Ms: round(percentile(ordered, 0.5)),
    p95Ms: round(percentile(ordered, 0.95)),
    maxMs: round(ordered.at(-1)!),
  };
}

export async function benchmarkMutationCase(
  sizeBytes: number,
  options: { iterations?: number; warmup?: number } = {},
): Promise<BenchmarkCase> {
  const iterations = options.iterations ?? 31;
  const warmup = options.warmup ?? 5;
  const base = createSyntheticBase(sizeBytes);
  const sessionTemplate = StagedMutationSession.fromBytes(base, {
    documentId: `synthetic-${String(sizeBytes)}`,
    sourceIdentity: `synthetic://mutation/${String(sizeBytes)}`,
    sourceGeneration: 'source-1',
    baseGeneration: 'base-1',
    fenceToken: 'fence-benchmark',
  });
  const edits = createSyntheticEdits(sessionTemplate.baseBytes);
  const samples: number[] = [];
  const baselineSamples: number[] = [];
  let candidateDigest = '';
  let oracleDigest = '';
  let baselineDigest = '';
  for (let index = 0; index < warmup + iterations; index += 1) {
    const baselineStart = performance.now();
    const baseline = Uint8Array.from(base);
    const baselineElapsed = performance.now() - baselineStart;
    baselineDigest = sha256(baseline);
    if (index >= warmup) baselineSamples.push(baselineElapsed);
    const session = StagedMutationSession.fromBytes(base, {
      documentId: `synthetic-${String(sizeBytes)}`,
      sourceIdentity: `synthetic://mutation/${String(sizeBytes)}`,
      sourceGeneration: 'source-1',
      baseGeneration: 'base-1',
      fenceToken: 'fence-benchmark',
    });
    const start = performance.now();
    const receipt = await session.stage(intentFor(session, edits, index));
    const materialized = session.materialize();
    const elapsed = performance.now() - start;
    if (index >= warmup) samples.push(elapsed);
    candidateDigest = sha256(materialized);
    oracleDigest = sha256(materializeOracle(base, edits));
    if (receipt.sourceUnchanged !== true) throw new Error('Synthetic stage changed the source.');
  }
  return {
    name: sizeBytes === 64 * 1024 ? '64KiB' : sizeBytes === 1024 * 1024 ? '1MiB' : `${String(sizeBytes)}B`,
    targetBytes: sizeBytes,
    actualBytes: base.byteLength,
    editCount: edits.length,
    samples: samples.length,
    oracleMatches: candidateDigest === oracleDigest,
    candidateDigest,
    oracleDigest,
    bytesCopied: coordinatorCopyBytes(base, edits),
    timingsMs: summarize(samples),
    plainBaseline: {
      bytesCopied: base.byteLength,
      digest: baselineDigest,
      timingsMs: summarize(baselineSamples),
    },
  };
}

export async function replayFailureScenarios(sizeBytes = 64 * 1024): Promise<FailureReplayReceipt[]> {
  const base = createSyntheticBase(sizeBytes);
  const sourceSession = makeSession(base);
  const edits = createSyntheticEdits(sourceSession.baseBytes);
  const overlapStart = edits[0]!.start + 1n;
  const overlapLength = edits[1]!.endExclusive - edits[1]!.start;
  const overlap = [edits[0]!, {
    ...edits[1]!,
    start: overlapStart,
    endExclusive: overlapStart + overlapLength,
    expectedOldDigest: sha256(base.slice(Number(overlapStart), Number(overlapStart + overlapLength))),
  }];
  const scenarios: readonly { name: string; expectedCode: string; run: (session: StagedMutationSession, evidence: ScenarioEvidence) => Promise<unknown> }[] = [
    { name: 'stale-source-generation', expectedCode: 'STALE_SOURCE_GENERATION', run: (session) => session.stage(intentFor(session, edits, 1, { sourceGeneration: 'source-stale' })) },
    { name: 'base-digest-mismatch', expectedCode: 'BASE_DIGEST_MISMATCH', run: (session) => session.stage(intentFor(session, edits, 2, { baseDigest: sha256(Uint8Array.from([0])) })) },
    { name: 'overlap', expectedCode: 'OVERLAP', run: (session) => session.stage(intentFor(session, overlap, 3)) },
    { name: 'duplicate-intent-mismatch', expectedCode: 'DUPLICATE_INTENT_MISMATCH', run: async (session) => { const first = intentFor(session, [edits[0]!], 4); await session.stage(first); return session.stage({ ...first, editRanges: [edits[1]!] }); } },
    { name: 'cancelled', expectedCode: 'CANCELLED', run: (session) => session.stage(intentFor(session, edits, 5), { signal: AbortSignal.abort() }) },
    { name: 'fence-held-after-unknown-commit', expectedCode: 'FENCE_HELD', run: async (session, evidence) => {
      await session.stage(intentFor(session, [edits[0]!], 6));
      const started = performance.now();
      const unknown = session.simulateUnknownCommit({ reason: 'synthetic replay' });
      evidence.unknownCommitReceipt = {
        operationId: unknown.operationId,
        state: unknown.state,
        sourceUnchanged: unknown.sourceUnchanged,
        stagingGeneration: unknown.stagingGeneration,
        diffDigest: unknown.diffDigest,
        reason: unknown.reason,
      };
      try {
        return await session.stage(intentFor(session, [edits[1]!], 7));
      } finally {
        evidence.unknownCommitElapsedMs = round(performance.now() - started);
      }
    } },
  ];
  return Promise.all(scenarios.map(async (scenario) => {
    const session = makeSession(base);
    const evidence: ScenarioEvidence = { cancellationLatencyMs: null, unknownCommitElapsedMs: null, unknownCommitReceipt: null };
    const before = sha256(session.baseBytes);
    let observedCode = 'NONE';
    let status: FailureReplayReceipt['status'] = 'unexpected_success';
    const started = performance.now();
    try {
      await scenario.run(session, evidence);
    } catch (error) {
      observedCode = error instanceof StagedMutationError ? error.code : 'UNKNOWN';
      status = observedCode === scenario.expectedCode ? 'rejected' : 'wrong_failure';
      if (scenario.name === 'cancelled') evidence.cancellationLatencyMs = round(performance.now() - started);
    }
    const after = sha256(session.baseBytes);
    return {
      schemaVersion: MUTATION_BENCHMARK_SCHEMA_VERSION,
      scenario: scenario.name,
      expectedCode: scenario.expectedCode,
      observedCode,
      status,
      sourceUnchanged: session.sourceUnchanged === true ? true : 'unknown',
      sourceDigestBefore: before,
      sourceDigestAfter: after,
      stagingGeneration: session.stagingGeneration,
      cancellationLatencyMs: evidence.cancellationLatencyMs,
      unknownCommitElapsedMs: evidence.unknownCommitElapsedMs,
      unknownCommitReceipt: evidence.unknownCommitReceipt,
    };
  }));
}

export async function runBenchmark(options: BenchmarkOptions = {}): Promise<MutationBenchmarkReport> {
  const iterations = options.iterations ?? 31;
  const warmup = options.warmup ?? 5;
  const rssSamples = sampleRss();
  const cases = await Promise.all((options.cases ?? DEFAULT_MUTATION_CASES).map((entry) => benchmarkMutationCase(entry.bytes, { iterations, warmup })));
  rssSamples.push(...sampleRss());
  const receipts = await replayFailureScenarios();
  const newlineCorpora = createSyntheticNewlineCorpora();
  const observedRss = rssSamples.length > 0 ? Math.max(...rssSamples) : null;
  const cancellationLatencyMs = receipts.find((receipt) => receipt.cancellationLatencyMs !== null)?.cancellationLatencyMs ?? null;
  return {
    schemaVersion: MUTATION_BENCHMARK_SCHEMA_VERSION,
    workloadVersion: MUTATION_WORKLOAD_VERSION,
    mode: 'synthetic-memory-only',
    benchmark: { iterations, warmup, cases },
    newlineCorpora,
    failureReplay: {
      allRejectedAsExpected: receipts.every((receipt) => receipt.status === 'rejected'
        && receipt.sourceDigestBefore === receipt.sourceDigestAfter
        && (receipt.sourceUnchanged === true || receipt.sourceUnchanged === 'unknown')),
      receipts,
    },
    runtime: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      resourceMetrics: {
        peakRssBytes: observedRss,
        status: observedRss === null ? 'unavailable' : 'partial',
        samples: rssSamples.length,
        method: 'process.memoryUsage sampled before and after the benchmark cases',
        reason: 'Node exposes process RSS but this synchronous harness does not sample inside each operation; the value is a process-level lower bound, not a per-case peak.',
      },
      cancellation: {
        latencyMs: cancellationLatencyMs,
        status: cancellationLatencyMs === null ? 'unavailable' : 'partial',
        mode: 'pre-aborted-signal',
        reason: 'Only rejection of an already-aborted signal is measured; mid-operation cancellation requires an asynchronous adapter and is not inferred.',
      },
    },
    timingInterpretation: {
      status: 'partial',
      text: 'These are single-process observations, not performance promises. An apparent inversion such as slower 64KiB samples than 1MiB can come from V8 warmup, allocator or garbage-collection state, scheduler contention, and timer resolution; no corpus ranking is inferred.',
    },
  };
}

export function createSyntheticNewlineCorpora(): SyntheticNewlineCorpus[] {
  const entries: readonly { name: SyntheticNewlineCorpus['name']; text: string }[] = [
    { name: 'crlf', text: '{"event":"a"}\r\n{"event":"b"}\r\n' },
    { name: 'mixed', text: '{"event":"a"}\r\n{"event":"b"}\n{"event":"c"}\r\n' },
    { name: 'partial-tail', text: '{"event":"a"}\n{"event":"partial"' },
  ];
  return entries.map(({ name, text }) => {
    const bytes = new TextEncoder().encode(text);
    const session = StagedMutationSession.fromBytes(bytes, { documentId: `synthetic-${name}`, sourceIdentity: `synthetic://newline/${name}` });
    return {
      name,
      bytes: bytes.byteLength,
      digest: sha256(bytes),
      detectedNewline: session.metadata.newline,
      partialTail: bytes.at(-1) !== 0x0a && bytes.at(-1) !== 0x0d,
      status: 'observed',
    };
  });
}

function coordinatorCopyBytes(base: Uint8Array, edits: readonly BaseEdit[]): number {
  const replacementBytes = edits.reduce((sum, edit) => sum + edit.replacement.byteLength, 0);
  const replacedBytes = edits.reduce((sum, edit) => sum + Number(edit.endExclusive - edit.start), 0);
  const untouchedBytes = base.byteLength - replacedBytes;
  const outputBytes = untouchedBytes + replacementBytes;
  // stage() clones replacements; materialize() slices untouched bytes, clones
  // replacements, then copies all parts into the final output.
  return replacementBytes + untouchedBytes + replacementBytes + outputBytes;
}

function sampleRss(): number[] {
  try {
    const rss = process.memoryUsage().rss;
    return Number.isSafeInteger(rss) && rss >= 0 ? [rss] : [];
  } catch {
    return [];
  }
}

export function assertHarnessReportPath(outputPath: string, harnessRoot = resolve(process.cwd(), '..', 'JsonlView-harness')): string {
  if (outputPath.trim().length === 0) throw new Error('--out requires a non-empty path.');
  const windowsDriveAbsolute = /^[A-Za-z]:[\\/]/.test(outputPath);
  const windowsUncAbsolute = /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(outputPath);
  if (windowsUncAbsolute) {
    throw new Error('--out must not use a UNC path.');
  }
  if (process.platform !== 'win32' && windowsDriveAbsolute) {
    throw new Error('--out received a Windows absolute path on a non-Windows host.');
  }
  const root = resolve(harnessRoot, 'state', 'runs');
  const resolved = resolve(outputPath);
  const suffix = relative(root, resolved);
  if (isAbsolute(suffix) || suffix === '' || suffix === '..' || suffix.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error(`--out must stay inside the harness state/runs directory: ${root}`);
  }
  const parent = dirname(resolved);
  let rootStat;
  let parentStat;
  try {
    rootStat = lstatSync(root);
    parentStat = lstatSync(parent);
  } catch {
    throw new Error(`--out requires an existing harness run directory: ${parent}`);
  }
  if (!rootStat.isDirectory() || !parentStat.isDirectory()) {
    throw new Error(`--out requires an existing harness run directory: ${parent}`);
  }
  let current = parent;
  while (true) {
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      throw new Error(`--out could not inspect the harness path: ${current}`);
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`--out rejects symlink or junction ancestors: ${current}`);
    }
    if (current === root) break;
    const next = dirname(current);
    if (next === current) throw new Error(`--out escaped the harness state/runs directory: ${root}`);
    current = next;
  }
  let rootReal;
  let parentReal;
  try {
    rootReal = realpathSync(root);
    parentReal = realpathSync(parent);
  } catch {
    throw new Error(`--out could not resolve the harness path: ${parent}`);
  }
  const realSuffix = relative(rootReal, parentReal);
  if (isAbsolute(realSuffix) || realSuffix === '..' || realSuffix.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error(`--out rejects symlink or junction escape: ${parent}`);
  }
  try {
    lstatSync(resolved);
    throw new Error(`--out target already exists; use a new harness run path: ${resolved}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('--out target already exists')) throw error;
    // ENOENT is the expected state for a one-shot report target.
  }
  return resolved;
}

function makeSession(base: Uint8Array): StagedMutationSession {
  return StagedMutationSession.fromBytes(base, {
    documentId: 'synthetic-mutation',
    sourceIdentity: 'synthetic://mutation',
    sourceGeneration: 'source-1',
    baseGeneration: 'base-1',
    fenceToken: 'fence-replay',
  });
}

function intentFor(
  session: StagedMutationSession,
  edits: readonly BaseEdit[],
  sequence: number,
  overrides: Partial<StageIntent> = {},
): StageIntent {
  return {
    operationId: `operation-${String(sequence)}`,
    idempotencyKey: `idempotency-${String(sequence)}`,
    documentId: session.metadata.documentId,
    sourceIdentity: session.metadata.sourceIdentity,
    sourceGeneration: session.metadata.sourceGeneration,
    baseGeneration: session.metadata.baseGeneration,
    baseDigest: session.metadata.baseDigest as `sha256:${string}`,
    editRanges: edits,
    actor: 'synthetic-benchmark',
    capability: 'stage_patch',
    fenceToken: session.fenceToken,
    ...overrides,
  };
}

function percentile(ordered: readonly number[], fraction: number): number {
  const index = (ordered.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return lower === upper ? ordered[lower]! : ordered[lower]! + (ordered[upper]! - ordered[lower]!) * (index - lower);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help === true) return;
  const report = await runBenchmark(options);
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (options.out !== undefined) await writeFile(options.out, output, 'utf8');
  process.stdout.write(output);
}

function parseArgs(values: readonly string[]): BenchmarkOptions & { out?: string; help?: boolean } {
  const args = values[0] === '--' ? values.slice(1) : values;
  const options: BenchmarkOptions & { out?: string; help?: boolean } = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    const value = args[index + 1];
    if (key === '--help') {
      process.stdout.write('Usage: node scripts/benchmark-staged-mutation.mjs [--iterations N] [--warmup N] [--out report.json]\n');
      options.help = true;
      return options;
    }
    if (key === '--iterations') { options.iterations = positiveInteger(value, key); index += 1; continue; }
    if (key === '--warmup') { options.warmup = nonNegativeInteger(value, key); index += 1; continue; }
    if (key === '--out') {
      if (value === undefined || value.startsWith('--')) throw new Error('--out requires a path.');
      options.out = assertHarnessReportPath(value); index += 1; continue;
    }
    throw new Error(`Unknown argument: ${key}`);
  }
  return options;
}

function positiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive safe integer.`);
  return parsed;
}

function nonNegativeInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative safe integer.`);
  return parsed;
}

if (process.argv[1]?.toLowerCase().endsWith('runner.mjs')) await main();
