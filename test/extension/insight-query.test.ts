import { describe, expect, it } from 'vitest';
import type { GetRowsOptions, RowEnricher } from '../../src/engine';
import {
  runInsightQuery,
  type InsightQueryLimits,
  type InsightQueryRequest,
  type InsightRowSource,
} from '../../src/extension/insight-query';
import type {
  AgentEventKind,
  AnalysisIntentV1,
  Predicate,
  RowPage,
  RowProjection,
  ScanTruncationReason,
} from '../../src/shared/types';

const generation = 'generation-1';
const enricher: RowEnricher = {
  profileId: 'test-profile',
  project: () => undefined,
};
const defaultLimits: InsightQueryLimits = {
  maxExaminedRecords: 5,
  maxExaminedBytes: 100,
  maxMilliseconds: 1_000,
};

describe('runInsightQuery', () => {
  it('keeps one generation, signal, enricher, deadline, and physical cursor across pages', async () => {
    const source = createSource(
      page({ rows: [row('0', 'message')], hasAfter: true, examinedRecords: '2', examinedBytes: '4', cursorOrdinal: '1' }),
      page({ rows: [row('2', 'usage')], examinedRecords: '1', examinedBytes: '5' }),
    );
    const controller = new AbortController();
    const predicate: Predicate = { op: 'text_search', value: 'query', caseSensitive: false };

    const result = await runInsightQuery(request(source, controller.signal, { intent: analysisIntent(predicate) }));

    expect(source.calls).toHaveLength(2);
    const first = source.calls[0]!;
    const second = source.calls[1]!;
    expect(first).toMatchObject({
      columns: [],
      limit: 500,
      generation,
      signal: controller.signal,
      enricher,
      predicate,
      projection: { conversation: false, dataset: false },
      scanBudget: { maxExaminedRecords: 5, maxExaminedBytes: 100n },
    });
    expect(first.anchorOrdinal).toBeUndefined();
    expect(second).toMatchObject({
      columns: [],
      anchorOrdinal: '1',
      limit: 500,
      generation,
      signal: controller.signal,
      enricher,
      predicate,
      projection: { conversation: false, dataset: false },
      scanBudget: { maxExaminedRecords: 3, maxExaminedBytes: 96n },
    });
    expect(second.scanBudget?.deadlineEpochMs).toBe(first.scanBudget?.deadlineEpochMs);
    expect(result).toMatchObject({
      processedRecords: '2',
      examinedRecords: '3',
      examinedBytes: '9',
      truncated: false,
    });
    expect(result.categories).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'message', count: 1 }),
      expect.objectContaining({ label: 'usage', count: 1 }),
    ]));
  });

  it('rejects an already-aborted query before reading a page', async () => {
    const source = createSource(page());
    const controller = new AbortController();
    controller.abort();

    await expect(runInsightQuery(request(source, controller.signal))).rejects.toThrow('Operation cancelled.');
    expect(source.calls).toHaveLength(0);
  });

  it('stops between pages when the caller aborts', async () => {
    const controller = new AbortController();
    const source = createSource(() => {
      controller.abort();
      return page({ hasAfter: true, examinedRecords: '1', cursorOrdinal: '0' });
    });

    await expect(runInsightQuery(request(source, controller.signal))).rejects.toThrow('Operation cancelled.');
    expect(source.calls).toHaveLength(1);
  });

  it('requires physical scan accounting from every page', async () => {
    const source = createSource(page({ includeScan: false }));

    await expect(runInsightQuery(request(source))).rejects.toThrow(
      'The JSONL engine did not return scan accounting for an Insights request.',
    );
  });

  it.each([
    ['a missing cursor', { examinedRecords: '1' }],
    ['zero examined records', { examinedRecords: '0', cursorOrdinal: '0' }],
  ])('rejects a non-progressing page with %s', async (_case, scan) => {
    const source = createSource(page({ hasAfter: true, ...scan }));

    await expect(runInsightQuery(request(source))).rejects.toThrow(
      'The JSONL engine returned a non-progressing Insights cursor.',
    );
  });

  it.each<ScanTruncationReason>(['byte_limit', 'time_limit', 'hydration_limit', 'uninspectable_record'])(
    'propagates a %s stop from row scanning',
    async (truncatedReason) => {
      const source = createSource(page({
        rows: [row('0', 'message')],
        examinedRecords: '1',
        examinedBytes: '10',
        truncatedReason,
      }));

      await expect(runInsightQuery(request(source))).resolves.toMatchObject({
        examinedRecords: '1',
        examinedBytes: '10',
        truncated: true,
        truncatedReason,
      });
    },
  );

  it('continues sparse internal record slices with the same deadline and remaining byte budget', async () => {
    const source = createSource(
      page({ rows: [row('0', 'message')], hasAfter: true, examinedRecords: '500', examinedBytes: '600',
        cursorOrdinal: '499', truncatedReason: 'record_limit' }),
      page({ hasAfter: true, examinedRecords: '500', examinedBytes: '700',
        cursorOrdinal: '999', truncatedReason: 'record_limit' }),
      page({ rows: [row('1200', 'usage')], examinedRecords: '205', examinedBytes: '400' }),
    );
    const result = await runInsightQuery(request(source, undefined, {
      limits: { ...defaultLimits, maxExaminedRecords: 2_000, maxExaminedBytes: 2_000 },
      intent: analysisIntent({ op: 'text_search', value: 'sparse', caseSensitive: false }),
    }));
    expect(source.calls.map((call) => call.scanBudget?.maxExaminedRecords)).toEqual([500, 500, 500]);
    expect(source.calls.map((call) => call.scanBudget?.maxExaminedBytes)).toEqual([2_000n, 1_400n, 700n]);
    expect(source.calls.map((call) => call.anchorOrdinal)).toEqual([undefined, '499', '999']);
    expect(new Set(source.calls.map((call) => call.scanBudget?.deadlineEpochMs)).size).toBe(1);
    expect(result).toMatchObject({ processedRecords: '2', examinedRecords: '1205', examinedBytes: '1700', truncated: false });
    expect(result.categories).toEqual(expect.arrayContaining([
      { label: 'message', count: 1 }, { label: 'usage', count: 1 },
    ]));
  });

  it('stops when a continued record slice reaches the remaining global budget', async () => {
    const source = createSource(
      page({ hasAfter: true, examinedRecords: '500', examinedBytes: '500', cursorOrdinal: '499', truncatedReason: 'record_limit' }),
      page({ hasAfter: true, examinedRecords: '1', examinedBytes: '1', cursorOrdinal: '500', truncatedReason: 'record_limit' }),
    );
    const result = await runInsightQuery(request(source, undefined, {
      limits: { ...defaultLimits, maxExaminedRecords: 501, maxExaminedBytes: 2_000 },
    }));
    expect(source.calls.map((call) => call.scanBudget?.maxExaminedRecords)).toEqual([500, 1]);
    expect(result).toMatchObject({ processedRecords: '0', examinedRecords: '501', truncated: true, truncatedReason: 'record_limit' });
  });

  it.each([
    ['a missing cursor', { examinedRecords: '500' }],
    ['zero examined records', { examinedRecords: '0', cursorOrdinal: '499' }],
  ])('rejects an internal record slice with %s', async (_case, scan) => {
    const source = createSource(page({ hasAfter: true, truncatedReason: 'record_limit', ...scan }));
    await expect(runInsightQuery(request(source, undefined, {
      limits: { ...defaultLimits, maxExaminedRecords: 2_000 },
    }))).rejects.toThrow('The JSONL engine returned a non-progressing Insights cursor.');
  });

  it.each(['499', '498'])('rejects a continued physical cursor that does not advance past 499 (%s)', async (cursorOrdinal) => {
    const source = createSource(
      page({ hasAfter: true, examinedRecords: '500', cursorOrdinal: '499', truncatedReason: 'record_limit' }),
      page({ hasAfter: true, examinedRecords: '500', cursorOrdinal, truncatedReason: 'record_limit' }),
    );
    await expect(runInsightQuery(request(source, undefined, {
      limits: { ...defaultLimits, maxExaminedRecords: 2_000 },
    }))).rejects.toThrow('The JSONL engine returned a non-progressing Insights cursor.');
  });

  it('preserves later matches and bounded coverage across an uninspectable record-limit slice', async () => {
    const source = createSource(
      (options) => {
        options.onHydrated?.({ ref: row('0', 'message').ref, parseState: 'invalid_json' });
        return page({ hasAfter: true, examinedRecords: '500', examinedBytes: '500', cursorOrdinal: '499', truncatedReason: 'record_limit' });
      },
      () => page({ rows: [row('500', 'message')], examinedRecords: '105', examinedBytes: '105', cursorOrdinal: '604' }),
    );
    const result = await runInsightQuery(request(source, undefined, {
      intent: analysisIntent({ op: 'text_search', value: 'message', caseSensitive: false }),
      limits: { ...defaultLimits, maxExaminedRecords: 2_000, maxExaminedBytes: 10_000 },
    }));
    expect(source.calls).toHaveLength(2);
    expect(source.calls[1]?.anchorOrdinal).toBe('499');
    expect(result).toMatchObject({
      processedRecords: '1', examinedRecords: '605', truncated: true, truncatedReason: 'uninspectable_record',
      provenance: { coverage: 'bounded', predicateApplied: true },
    });
  });

  it.each([
    ['insightsMaxExaminedRecords', { maxExaminedRecords: 0 }, 1_000_000],
    ['insightsMaxExaminedBytes', { maxExaminedBytes: 512 * 1024 * 1024 + 1 }, 512 * 1024 * 1024],
    ['insightsMaxMilliseconds', { maxMilliseconds: 1.5 }, 60_000],
  ])('rejects an invalid %s limit', async (name, override, maximum) => {
    const source = createSource(page());
    const limits = { ...defaultLimits, ...override };

    await expect(runInsightQuery(request(source, undefined, { limits }))).rejects.toThrow(
      `${name} must be an integer between 1 and ${String(maximum)}.`,
    );
    expect(source.calls).toHaveLength(0);
  });
});

type PageFactory = RowPage | ((options: GetRowsOptions) => RowPage | Promise<RowPage>);

function createSource(...pages: PageFactory[]): InsightRowSource & { calls: GetRowsOptions[] } {
  const calls: GetRowsOptions[] = [];
  return {
    calls,
    getRows: async (options) => {
      calls.push(options);
      const next = pages.shift();
      if (next === undefined) throw new Error('Unexpected Insights page request.');
      return typeof next === 'function' ? next(options) : next;
    },
  };
}

function request(
  source: InsightRowSource,
  signal = new AbortController().signal,
  override: Partial<InsightQueryRequest> = {},
): InsightQueryRequest {
  return {
    source,
    generation,
    enricher,
    intent: analysisIntent(),
    signal,
    limits: defaultLimits,
    ...override,
  };
}

function analysisIntent(predicate?: Predicate): AnalysisIntentV1 {
  return {
    version: 1, intentRevision: 1, dimension: 'eventKind', scope: 'current-view',
    document: { documentId: 'document', generation },
    profile: { id: 'test-profile', version: '1' },
    ...(predicate === undefined ? {} : { predicate }),
  };
}

function page(options: {
  rows?: RowProjection[];
  hasAfter?: boolean;
  examinedRecords?: string;
  examinedBytes?: string;
  cursorOrdinal?: string;
  truncatedReason?: ScanTruncationReason;
  includeScan?: boolean;
} = {}): RowPage {
  const rows = options.rows ?? [];
  return {
    rows,
    columns: [],
    anchorOrdinal: rows.at(-1)?.ref.ordinal ?? '0',
    hasBefore: false,
    hasAfter: options.hasAfter ?? false,
    indexedRecords: '10',
    ...((options.includeScan ?? true) ? {
      scan: {
        examinedRecords: options.examinedRecords ?? '1',
        examinedBytes: options.examinedBytes ?? '1',
        ...(options.cursorOrdinal === undefined ? {} : { cursorOrdinal: options.cursorOrdinal }),
        ...(options.truncatedReason === undefined ? {} : { truncatedReason: options.truncatedReason }),
      },
    } : {}),
  };
}

function row(ordinal: string, eventKind: AgentEventKind): RowProjection {
  return {
    ref: {
      generation,
      ordinal,
      byteStart: ordinal,
      byteEndExclusive: String(Number(ordinal) + 1),
      contentByteLength: '1',
      delimiterByteLength: 1,
      parseState: 'valid',
    },
    kind: 'object',
    cells: [],
    genericSummary: eventKind,
    profile: {
      profileId: enricher.profileId,
      eventKind,
      timestamp: '2026-10-09T00:00:00.000Z',
      summary: eventKind,
      evidence: [],
      confidence: 'source',
    },
  };
}
