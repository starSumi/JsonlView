import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonlFileEngine } from '../../../src/engine';
import { IntegratedJsonlSession, type IntegratedSessionOptions } from '../../../src/extension/integrated-session/integrated-session';
import type { AnalysisIntentV1, Predicate } from '../../../src/shared/types';

const directories: string[] = [];
const sessions: IntegratedJsonlSession[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.dispose()));
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(
  count: number,
  options: Partial<IntegratedSessionOptions> = {},
  recordAt: (ordinal: number) => unknown = (ordinal) => ({
    ordinal, message: ordinal % 499 === 0 ? 'matching' : 'ordinary',
  }),
) {
  const directory = await mkdtemp(join(tmpdir(), 'jsonl-session-scheduling-'));
  directories.push(directory);
  const path = join(directory, 'synthetic.jsonl');
  await writeFile(path, Array.from({ length: count }, (_, ordinal) => JSON.stringify(recordAt(ordinal))).join('\n'));
  const session = await IntegratedJsonlSession.open(path, {
    uri: new URL(`file:///${path.replaceAll('\\', '/')}`).toString(),
    backgroundIndexing: false,
    ...options,
  });
  sessions.push(session);
  return session;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function intent(session: IntegratedJsonlSession, predicate?: Predicate): AnalysisIntentV1 {
  const summary = session.getSummary();
  return {
    version: 1, intentRevision: 1, dimension: 'eventKind', scope: 'current-view',
    document: { documentId: summary.snapshot.documentId, generation: summary.snapshot.generation,
      ...(summary.snapshot.epoch === undefined ? {} : { sourceEpoch: summary.snapshot.epoch }) },
    profile: { id: summary.profileId, version: summary.profileVersion! },
    ...(predicate === undefined ? {} : { predicate }),
  };
}

describe('session opportunistic scheduling', () => {
  it('runs a deferred head once while indexing is incomplete, then retains tail and stratified sampling', async () => {
    const session = await fixture(100, { deferProfileDetection: true });
    const probes = vi.spyOn(JsonlFileEngine.prototype, 'inspectBackgroundRows');
    const firstPublication = deferred();
    const finalPublication = deferred();
    let publications = 0;
    session.onProgress(() => {
      publications += 1;
      if (publications === 1) firstPublication.resolve();
      if (publications === 2) finalPublication.resolve();
    });
    await session.getRows({ limit: 1 }, new AbortController().signal);
    await firstPublication.promise;
    expect(session.getSummary().indexingComplete).toBe(false);
    expect(probes).toHaveBeenCalledTimes(1);
    for (let page = 0; page < 3; page += 1) {
      await session.getRows({ limit: 1 }, new AbortController().signal);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(probes).toHaveBeenCalledTimes(1);
    expect(publications).toBe(1);
    const engine = (session as unknown as { engine: JsonlFileEngine }).engine;
    await engine.finishIndexing();
    await session.getRows({ limit: 1 }, new AbortController().signal);
    await finalPublication.promise;
    expect(probes.mock.calls.map(([options]) => options?.direction)).toEqual([
      undefined, undefined, 'backward', 'forward', 'forward', 'forward',
    ]);
    expect(session.getSummary().indexingComplete).toBe(true);
  });

  it.each(['matching', 'never-present'])('routes every sparse %s Insights slice through background pages', async (query) => {
    const session = await fixture(1_205, { autoDetectProfiles: false, insightsMaxMilliseconds: 60_000 });
    const foreground = vi.spyOn(JsonlFileEngine.prototype, 'getRows');
    const background = vi.spyOn(JsonlFileEngine.prototype, 'getBackgroundRows');
    const predicate: Predicate = { op: 'text_search', value: query, caseSensitive: false };
    const result = await session.getInsights(intent(session, predicate), new AbortController().signal);
    expect(foreground).not.toHaveBeenCalled();
    expect(background).toHaveBeenCalledTimes(3);
    expect(background.mock.calls.every(([options]) => options?.scanBudget?.maxExaminedRecords === 500)).toBe(true);
    expect(background.mock.calls.map(([options]) => options?.anchorOrdinal)).toEqual([undefined, '499', '999']);
    expect(result).toMatchObject({
      processedRecords: query === 'matching' ? '3' : '0', examinedRecords: '1205', truncated: false,
      provenance: { coverage: 'complete', predicateApplied: true },
    });
    const expected = await session.getRows({ limit: 500, predicate }, new AbortController().signal);
    expect(result.processedRecords).toBe(String(expected.rows.length));
    expect(result.categories.reduce((sum, category) => sum + category.count, 0)).toBe(expected.rows.length);
  });

  it('retains the head publication from an adopted rebuild before the first visible page', async () => {
    const session = await fixture(100, { deferProfileDetection: true });
    const probes = vi.spyOn(JsonlFileEngine.prototype, 'inspectBackgroundRows');
    const previous = session.getSummary();
    const rebuilt = await session.rebuild(new AbortController().signal);
    expect(rebuilt.snapshot.generation).not.toBe(previous.snapshot.generation);
    expect(rebuilt.indexingComplete).toBe(false);
    expect(probes).toHaveBeenCalledTimes(1);
    await session.getRows({ limit: 1 }, new AbortController().signal);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(probes).toHaveBeenCalledTimes(1);
    expect(session.getSummary().profileEpoch).toBe(rebuilt.profileEpoch);
  });

  it.each([
    { count: 1_205, budget: 1_000, truncated: true },
    { count: 1_000, budget: 1_000, truncated: false },
  ])('preserves the global $budget record budget for a $count-record zero-match source', async ({ count, budget, truncated }) => {
    const session = await fixture(count, {
      autoDetectProfiles: false, insightsMaxExaminedRecords: budget, insightsMaxMilliseconds: 60_000,
    });
    const background = vi.spyOn(JsonlFileEngine.prototype, 'getBackgroundRows');
    const result = await session.getInsights(intent(session, {
      op: 'text_search', value: 'never-present', caseSensitive: false,
    }), new AbortController().signal);
    expect(background).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ processedRecords: '0', examinedRecords: String(budget), truncated });
    expect(result.truncatedReason).toBe(truncated ? 'record_limit' : undefined);
  });

  it('keeps an inspectable record larger than 1 MiB within the remaining global byte budget', async () => {
    const session = await fixture(2, {
      autoDetectProfiles: false, maxRecordBytes: 2 * 1024 * 1024, insightsMaxMilliseconds: 60_000,
    }, (ordinal) => ({ ordinal, message: ordinal === 0 ? 'x'.repeat(1024 * 1024 + 64) : 'small' }));
    const result = await session.getInsights(intent(session), new AbortController().signal);
    expect(result).toMatchObject({ processedRecords: '2', examinedRecords: '2', truncated: false });
    expect(BigInt(result.examinedBytes)).toBeGreaterThan(1024n * 1024n);
  });

  it('continues across an uninspectable slice while retaining later matches and bounded provenance', async () => {
    const session = await fixture(605, { autoDetectProfiles: false, insightsMaxMilliseconds: 60_000 },
      (ordinal) => ordinal === 0 ? undefined : { ordinal, message: ordinal === 500 ? 'matching' : 'ordinary' });
    const result = await session.getInsights(intent(session, {
      op: 'text_search', value: 'matching', caseSensitive: false,
    }), new AbortController().signal);
    expect(result).toMatchObject({
      processedRecords: '1', examinedRecords: '605', truncated: true, truncatedReason: 'uninspectable_record',
      provenance: { coverage: 'bounded', predicateApplied: true },
    });
    expect(result.categories.reduce((sum, category) => sum + category.count, 0)).toBe(1);
  });
});
