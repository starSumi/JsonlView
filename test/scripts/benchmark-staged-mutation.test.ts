import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  benchmarkMutationCase,
  createSyntheticBase,
  createSyntheticEdits,
  materializeOracle,
  replayFailureScenarios,
  runBenchmark,
  summarize,
} from '../../scripts/benchmark-staged-mutation-runner';

describe('staged mutation benchmark and replay oracle', () => {
  it('creates deterministic exact-size synthetic bases', () => {
    const first = createSyntheticBase(64 * 1024);
    const second = createSyntheticBase(64 * 1024);
    expect(first.byteLength).toBe(64 * 1024);
    expect(first.byteLength).toBe(64 * 1024);
    expect(digest(first)).toBe(digest(second));
  });

  it('keeps source bytes outside the actual session and matches the independent oracle', async () => {
    const base = createSyntheticBase(64 * 1024);
    const before = digest(base);
    const edits = createSyntheticEdits(base);
    const result = await benchmarkMutationCase(64 * 1024, { iterations: 2, warmup: 1 });
    expect(result.oracleMatches).toBe(true);
    expect(digest(base)).toBe(before);
    expect(materializeOracle(base, edits).byteLength).toBeGreaterThan(0);
  });

  it('produces deterministic failure receipts with unchanged source digests', async () => {
    const receipts = await replayFailureScenarios();
    expect(receipts).toHaveLength(6);
    expect(receipts.every((receipt) => receipt.status === 'rejected')).toBe(true);
    expect(receipts.every((receipt) => receipt.sourceDigestBefore === receipt.sourceDigestAfter)).toBe(true);
    expect(receipts.map((receipt) => receipt.observedCode)).toEqual([
      'STALE_SOURCE_GENERATION', 'BASE_DIGEST_MISMATCH', 'OVERLAP', 'DUPLICATE_INTENT_MISMATCH', 'CANCELLED', 'FENCE_HELD',
    ]);
  });

  it('reports p50 and p95 for both required corpus sizes', async () => {
    const small = await benchmarkMutationCase(64 * 1024, { iterations: 3, warmup: 1 });
    const large = await benchmarkMutationCase(1024 * 1024, { iterations: 3, warmup: 1 });
    expect(small).toMatchObject({ name: '64KiB', targetBytes: 64 * 1024, samples: 3, oracleMatches: true });
    expect(large).toMatchObject({ name: '1MiB', targetBytes: 1024 * 1024, samples: 3, oracleMatches: true });
    expect(small.timingsMs.p95Ms).toBeGreaterThanOrEqual(small.timingsMs.p50Ms);
    expect(large.timingsMs.p95Ms).toBeGreaterThanOrEqual(large.timingsMs.p50Ms);
  });

  it('aggregates p50 and p95 without sorting the caller array', () => {
    const values = [9, 1, 5, 3];
    expect(summarize(values)).toEqual({ p50Ms: 4, p95Ms: 8.4, maxMs: 9 });
    expect(values).toEqual([9, 1, 5, 3]);
  });

  it('returns a complete synthetic report with failure replay gate', async () => {
    const report = await runBenchmark({ iterations: 2, warmup: 1 });
    expect(report.mode).toBe('synthetic-memory-only');
    expect(report.benchmark.cases.map((entry) => entry.name)).toEqual(['64KiB', '1MiB']);
    expect(report.failureReplay.allRejectedAsExpected).toBe(true);
  });
});

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
