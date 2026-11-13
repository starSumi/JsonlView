import { CategoricalAggregator, TimeBucketAggregator } from '../aggregation';
import type { GetRowsOptions, RowEnricher } from '../engine';
import type {
  AnalysisIntentV1,
  InsightSummary,
  RowPage,
  ScanTruncationReason,
} from '@shared/types';

const INSIGHT_PAGE_SIZE = 500;
const INSIGHT_ROW_PROJECTION = { conversation: false, dataset: false };
const INSIGHT_BUCKET_WIDTH_MS = 5 * 60 * 1_000;
const DEFAULT_INSIGHT_MAX_EXAMINED_RECORDS = 100_000;
const DEFAULT_INSIGHT_MAX_EXAMINED_BYTES = 64 * 1024 * 1024;
const DEFAULT_INSIGHT_MAX_MILLISECONDS = 5_000;
const HARD_INSIGHT_MAX_EXAMINED_RECORDS = 1_000_000;
const HARD_INSIGHT_MAX_EXAMINED_BYTES = 512 * 1024 * 1024;
const HARD_INSIGHT_MAX_MILLISECONDS = 60_000;

export interface InsightRowSource {
  getRows(options: GetRowsOptions): Promise<RowPage>;
}

export interface InsightQueryLimits {
  maxExaminedRecords: number | undefined;
  maxExaminedBytes: number | undefined;
  maxMilliseconds: number | undefined;
}

export interface InsightQueryRequest {
  source: InsightRowSource;
  generation: string;
  enricher: RowEnricher;
  intent: AnalysisIntentV1;
  signal: AbortSignal;
  limits: InsightQueryLimits;
}

export async function runInsightQuery(request: InsightQueryRequest): Promise<InsightSummary> {
  const { source, generation, enricher, intent, signal, limits } = request;
  const { dimension, predicate } = intent;
  throwIfAborted(signal);
  const categories = new CategoricalAggregator({
    selector: { kind: 'common', dimension },
    signal,
  });
  const time = new TimeBucketAggregator({
    bucketWidthMs: INSIGHT_BUCKET_WIDTH_MS,
    maxBuckets: 64,
    signal,
  });
  let anchorOrdinal: string | undefined;
  let examinedRecords = 0n;
  let examinedBytes = 0n;
  let truncatedReason: ScanTruncationReason | undefined;
  let sawUninspectableRecord = false;
  const maxExaminedRecords = boundedInsightLimit(
    limits.maxExaminedRecords,
    DEFAULT_INSIGHT_MAX_EXAMINED_RECORDS,
    HARD_INSIGHT_MAX_EXAMINED_RECORDS,
    'insightsMaxExaminedRecords',
  );
  const maxExaminedBytes = boundedInsightLimit(
    limits.maxExaminedBytes,
    DEFAULT_INSIGHT_MAX_EXAMINED_BYTES,
    HARD_INSIGHT_MAX_EXAMINED_BYTES,
    'insightsMaxExaminedBytes',
  );
  const maxMilliseconds = boundedInsightLimit(
    limits.maxMilliseconds,
    DEFAULT_INSIGHT_MAX_MILLISECONDS,
    HARD_INSIGHT_MAX_MILLISECONDS,
    'insightsMaxMilliseconds',
  );
  const deadlineEpochMs = Date.now() + maxMilliseconds;

  while (true) {
    throwIfAborted(signal);
    const remainingRecords = BigInt(maxExaminedRecords) - examinedRecords;
    const remainingBytes = BigInt(maxExaminedBytes) - examinedBytes;
    if (remainingRecords <= 0n) {
      truncatedReason = 'record_limit';
      break;
    }
    if (remainingBytes <= 0n) {
      truncatedReason = 'byte_limit';
      break;
    }
    // Bound physical work even when a sparse predicate returns no matched rows.
    const pageRecordLimit = Number(remainingRecords < BigInt(INSIGHT_PAGE_SIZE)
      ? remainingRecords : BigInt(INSIGHT_PAGE_SIZE));
    const page = await source.getRows({
      ...(anchorOrdinal === undefined ? {} : { anchorOrdinal }),
      columns: [],
      limit: INSIGHT_PAGE_SIZE,
      ...(predicate === undefined ? {} : { predicate }),
      ...(predicate === undefined ? {} : {
        onHydrated: (record) => { sawUninspectableRecord ||= record.value === undefined; },
      }),
      enricher,
      generation,
      projection: INSIGHT_ROW_PROJECTION,
      signal,
      scanBudget: {
        maxExaminedRecords: pageRecordLimit,
        maxExaminedBytes: remainingBytes,
        deadlineEpochMs,
      },
    });
    const scan = page.scan;
    if (scan === undefined) {
      throw new Error('The JSONL engine did not return scan accounting for an Insights request.');
    }
    examinedRecords += BigInt(scan.examinedRecords);
    examinedBytes += BigInt(scan.examinedBytes);
    let continueScanning = true;
    for (const row of page.rows) {
      if (!categories.add(row) || !time.add(row)) {
        continueScanning = false;
        truncatedReason = 'record_limit';
        break;
      }
    }
    if (!continueScanning) break;
    const continuesRecordSlice = scan.truncatedReason === 'record_limit'
      && BigInt(pageRecordLimit) < remainingRecords
      && page.hasAfter;
    if (scan.truncatedReason !== undefined && !continuesRecordSlice) {
      truncatedReason = scan.truncatedReason;
      break;
    }
    if (!page.hasAfter) {
      // The last physical slice may not contain the earlier uninspectable row.
      // Keep its coverage signal without stopping before later in-budget matches.
      if (sawUninspectableRecord) truncatedReason = 'uninspectable_record';
      break;
    }
    if (scan.cursorOrdinal === undefined || scan.examinedRecords === '0'
      || (anchorOrdinal !== undefined && BigInt(scan.cursorOrdinal) <= BigInt(anchorOrdinal))) {
      throw new Error('The JSONL engine returned a non-progressing Insights cursor.');
    }
    anchorOrdinal = scan.cursorOrdinal;
  }

  const categoryResult = categories.finish();
  const timeResult = time.finish();
  return {
    intent,
    provenance: {
      scope: intent.scope,
      predicateApplied: predicate !== undefined,
      coverage: truncatedReason === undefined
        && !categoryResult.meta.truncatedByRecordLimit
        && !timeResult.meta.truncatedByRecordLimit ? 'complete' : 'bounded',
    },
    categories: categoryResult.groups.map((group) => ({
      label: group.label,
      count: group.count,
    })),
    timeBuckets: timeResult.buckets.map((bucket) => ({
      start: bucket.label,
      count: bucket.count,
    })),
    processedRecords: String(Math.min(
      categoryResult.meta.processedRecords,
      timeResult.meta.processedRecords,
    )),
    examinedRecords: examinedRecords.toString(),
    examinedBytes: examinedBytes.toString(),
    truncated: truncatedReason !== undefined
      || categoryResult.meta.truncatedByRecordLimit
      || timeResult.meta.truncatedByRecordLimit,
    ...(truncatedReason === undefined ? {} : { truncatedReason }),
    capacityReached: categoryResult.meta.capacityReached || timeResult.meta.capacityReached,
    bucketWidthMs: INSIGHT_BUCKET_WIDTH_MS,
  };
}

function boundedInsightLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${String(maximum)}.`);
  }
  return candidate;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Operation cancelled.');
}
