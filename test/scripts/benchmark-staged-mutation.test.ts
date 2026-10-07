import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  benchmarkMutationCase,
  assertHarnessReportPath,
  createSyntheticBase,
  createSyntheticEdits,
  createSyntheticNewlineCorpora,
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
    expect(receipts.find((receipt) => receipt.scenario === 'cancelled')).toMatchObject({
      cancellationLatencyMs: expect.any(Number),
      unknownCommitReceipt: null,
    });
    expect(receipts.find((receipt) => receipt.scenario === 'fence-held-after-unknown-commit')).toMatchObject({
      unknownCommitElapsedMs: expect.any(Number),
      unknownCommitReceipt: { state: 'unknownCommit', sourceUnchanged: 'unknown' },
    });
  });

  it('reports p50 and p95 for both required corpus sizes', async () => {
    const small = await benchmarkMutationCase(64 * 1024, { iterations: 3, warmup: 1 });
    const large = await benchmarkMutationCase(1024 * 1024, { iterations: 3, warmup: 1 });
    expect(small).toMatchObject({ name: '64KiB', targetBytes: 64 * 1024, samples: 3, oracleMatches: true });
    expect(large).toMatchObject({ name: '1MiB', targetBytes: 1024 * 1024, samples: 3, oracleMatches: true });
    expect(small.bytesCopied).toBeGreaterThan(small.plainBaseline.bytesCopied);
    expect(small.plainBaseline.digest).toBe(`sha256:${digest(createSyntheticBase(64 * 1024))}`);
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
    expect(report.newlineCorpora.map((entry) => entry.name)).toEqual(['crlf', 'mixed', 'partial-tail']);
    expect(report.newlineCorpora.map((entry) => entry.detectedNewline)).toEqual(['crlf', 'mixed', 'lf']);
    expect(report.newlineCorpora.at(-1)?.partialTail).toBe(true);
    expect(report.runtime.resourceMetrics.status).toBe('partial');
    expect(report.runtime.cancellation).toMatchObject({ status: 'partial', mode: 'pre-aborted-signal' });
    expect(report.timingInterpretation.status).toBe('partial');
  });

  it('rejects report output outside the harness state/runs boundary', () => {
    const root = String.raw`C:\evidence\JsonlView-harness`;
    const allowed = String.raw`C:\evidence\JsonlView-harness\state\runs\run\report.json`;
    expect(assertHarnessReportPath(allowed, root)).toBe(allowed);
    expect(() => assertHarnessReportPath(String.raw`C:\evidence\JsonlView\report.json`, root)).toThrow(/state\\runs/);
    expect(() => assertHarnessReportPath(String.raw`C:\evidence\JsonlView-harness\state\runs\..\..\secret.json`, root)).toThrow(/state\\runs/);
  });

  it('exposes the newline corpus helper as synthetic, bounded evidence', () => {
    expect(createSyntheticNewlineCorpora()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'crlf', detectedNewline: 'crlf', partialTail: false, status: 'observed' }),
      expect.objectContaining({ name: 'mixed', detectedNewline: 'mixed', partialTail: false, status: 'observed' }),
      expect.objectContaining({ name: 'partial-tail', detectedNewline: 'lf', partialTail: true, status: 'observed' }),
    ]));
  });
});

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
