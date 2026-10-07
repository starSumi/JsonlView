import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import {
  StagedMutationError,
  StagedMutationSession,
  editFor,
  sha256,
  type BaseEdit,
  type DiffReceipt,
  type StageIntent,
} from '../experimental/staged-mutation/index';

export const MUTATION_BENCHMARK_SCHEMA_VERSION = 1 as const;
export const MUTATION_WORKLOAD_VERSION = 1 as const;
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
  timingsMs: { p50Ms: number; p95Ms: number; maxMs: number };
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
}

export interface MutationBenchmarkReport {
  schemaVersion: typeof MUTATION_BENCHMARK_SCHEMA_VERSION;
  workloadVersion: typeof MUTATION_WORKLOAD_VERSION;
  mode: 'synthetic-memory-only';
  benchmark: { iterations: number; warmup: number; cases: BenchmarkCase[] };
  failureReplay: { allRejectedAsExpected: boolean; receipts: FailureReplayReceipt[] };
  runtime: { node: string; platform: string; architecture: string };
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
  let candidateDigest = '';
  let oracleDigest = '';
  for (let index = 0; index < warmup + iterations; index += 1) {
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
    timingsMs: summarize(samples),
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
  const scenarios: readonly { name: string; expectedCode: string; run: (session: StagedMutationSession) => Promise<unknown> }[] = [
    { name: 'stale-source-generation', expectedCode: 'STALE_SOURCE_GENERATION', run: (session) => session.stage(intentFor(session, edits, 1, { sourceGeneration: 'source-stale' })) },
    { name: 'base-digest-mismatch', expectedCode: 'BASE_DIGEST_MISMATCH', run: (session) => session.stage(intentFor(session, edits, 2, { baseDigest: sha256(Uint8Array.from([0])) })) },
    { name: 'overlap', expectedCode: 'OVERLAP', run: (session) => session.stage(intentFor(session, overlap, 3)) },
    { name: 'duplicate-intent-mismatch', expectedCode: 'DUPLICATE_INTENT_MISMATCH', run: async (session) => { const first = intentFor(session, [edits[0]!], 4); await session.stage(first); return session.stage({ ...first, editRanges: [edits[1]!] }); } },
    { name: 'cancelled', expectedCode: 'CANCELLED', run: (session) => session.stage(intentFor(session, edits, 5), { signal: AbortSignal.abort() }) },
    { name: 'fence-held-after-unknown-commit', expectedCode: 'FENCE_HELD', run: async (session) => { await session.stage(intentFor(session, [edits[0]!], 6)); session.simulateUnknownCommit({ reason: 'synthetic replay' }); return session.stage(intentFor(session, [edits[1]!], 7)); } },
  ];
  return Promise.all(scenarios.map(async (scenario) => {
    const session = makeSession(base);
    const before = sha256(session.baseBytes);
    let observedCode = 'NONE';
    let status: FailureReplayReceipt['status'] = 'unexpected_success';
    try {
      await scenario.run(session);
    } catch (error) {
      observedCode = error instanceof StagedMutationError ? error.code : 'UNKNOWN';
      status = observedCode === scenario.expectedCode ? 'rejected' : 'wrong_failure';
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
    };
  }));
}

export async function runBenchmark(options: BenchmarkOptions = {}): Promise<MutationBenchmarkReport> {
  const iterations = options.iterations ?? 31;
  const warmup = options.warmup ?? 5;
  const cases = await Promise.all((options.cases ?? DEFAULT_MUTATION_CASES).map((entry) => benchmarkMutationCase(entry.bytes, { iterations, warmup })));
  const receipts = await replayFailureScenarios();
  return {
    schemaVersion: MUTATION_BENCHMARK_SCHEMA_VERSION,
    workloadVersion: MUTATION_WORKLOAD_VERSION,
    mode: 'synthetic-memory-only',
    benchmark: { iterations, warmup, cases },
    failureReplay: { allRejectedAsExpected: receipts.every((receipt) => receipt.status === 'rejected'), receipts },
    runtime: { node: process.version, platform: process.platform, architecture: process.arch },
  };
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
  const report = await runBenchmark(options);
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (options.out !== undefined) await writeFile(options.out, output, 'utf8');
  process.stdout.write(output);
}

function parseArgs(values: readonly string[]): BenchmarkOptions & { out?: string } {
  const args = values[0] === '--' ? values.slice(1) : values;
  const options: BenchmarkOptions & { out?: string } = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    const value = args[index + 1];
    if (key === '--help') {
      process.stdout.write('Usage: node scripts/benchmark-staged-mutation.mjs [--iterations N] [--warmup N] [--out report.json]\n');
      return options;
    }
    if (key === '--iterations') { options.iterations = positiveInteger(value, key); index += 1; continue; }
    if (key === '--warmup') { options.warmup = nonNegativeInteger(value, key); index += 1; continue; }
    if (key === '--out') {
      if (value === undefined || value.startsWith('--')) throw new Error('--out requires a path.');
      options.out = value; index += 1; continue;
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
