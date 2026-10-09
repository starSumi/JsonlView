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

    const result = await runInsightQuery(request(source, controller.signal, { predicate }));

    expect(source.calls).toHaveLength(2);
    const first = source.calls[0]!;
    const second = source.calls[1]!;
    expect(first).toMatchObject({
      limit: 500,
      generation,
      signal: controller.signal,
      enricher,
      predicate,
      scanBudget: { maxExaminedRecords: 5, maxExaminedBytes: 100n },
    });
    expect(first.anchorOrdinal).toBeUndefined();
    expect(second).toMatchObject({
      anchorOrdinal: '1',
      limit: 500,
      generation,
      signal: controller.signal,
      enricher,
      predicate,
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

  it.each<ScanTruncationReason>(['byte_limit', 'time_limit'])(
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
    dimension: 'eventKind',
    predicate: undefined,
    signal,
    limits: defaultLimits,
    ...override,
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
