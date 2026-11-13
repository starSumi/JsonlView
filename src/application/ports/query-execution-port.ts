import {
  createQueryAstV1,
  lowerQueryAstV1,
  type QueryAstV1,
} from '@shared/contracts/query-ast';
import {
  isQueryRequestDtoV1,
  isQuerySettlementDtoV1,
  QUERY_DTO_LIMITS,
  type QueryRequestDtoV1,
  type QuerySettlementDtoV1,
  type QuerySourceIdentityV1,
  type QueryTruncationV1,
} from '@shared/contracts/query-dto';
import type { RowPage } from '@shared/types';
import {
  assertRecordPageRequest,
  type RecordPageReader,
  type RecordPageRequest,
  type RecordPageTimingObserver,
} from './record-page-reader';

/** Explicit result targets prevent a raw MCP page from being confused with a projected Webview page. */
export type QueryExecutionTargetV1 = 'record-page' | 'raw-records';

export interface QueryExecutionSourceV1 {
  readonly identity: QuerySourceIdentityV1;
  readonly recordPage: RecordPageReader;
  /** Host-owned raw adapters may opt in without changing projected page semantics. */
  readonly rawRecords?: RawRecordReaderV1;
}

export interface RawRecordReaderV1 {
  execute(request: QueryRequestDtoV1, signal: AbortSignal): Promise<RawRecordExecutionV1>;
}

export interface RawRecordExecutionV1 {
  readonly result: unknown;
  readonly truncation?: QueryTruncationV1;
}

export type QueryExecutionSourceResolverV1 = (
  identity: QuerySourceIdentityV1,
) => QueryExecutionSourceV1 | undefined;

export interface QueryExecutionRequestV1 {
  readonly target: QueryExecutionTargetV1;
  readonly dto: QueryRequestDtoV1;
  /** Presentation-only fields remain owned by the record-page application contract. */
  readonly page: Pick<RecordPageRequest, 'columns' | 'projection'>;
}

export type QueryExecutionResultV1 =
  | {
    readonly target: 'record-page';
    readonly page: RowPage;
    readonly settlement: QuerySettlementDtoV1;
  }
  | {
    readonly target: 'raw-records';
    readonly result: unknown;
    readonly settlement: QuerySettlementDtoV1;
  };

export class QueryExecutionSourceError extends Error {
  public readonly code = 'QUERY_SOURCE_UNAVAILABLE' as const;
}

export class QueryExecutionUnsupportedError extends Error {
  public readonly code = 'QUERY_TARGET_UNSUPPORTED' as const;
}

export class QueryExecutionCancelledError extends Error {
  public readonly code = 'QUERY_CANCELLED' as const;
}

/**
 * The one application execution port for versioned queries. It lowers the
 * versioned AST into the existing RecordPageRequest and delegates all scan,
 * predicate, projection, and lifecycle behavior to the current reader.
 */
export class QueryExecutionPort {
  private readonly resolveSource: QueryExecutionSourceResolverV1;

  public constructor(resolveSource: QueryExecutionSourceResolverV1) {
    this.resolveSource = resolveSource;
  }

  public async execute(
    request: QueryExecutionRequestV1,
    signal: AbortSignal,
    onTiming?: RecordPageTimingObserver,
  ): Promise<QueryExecutionResultV1> {
    if (!isQueryRequestDtoV1(request.dto)) {
      throw new TypeError('Invalid query request DTO v1.');
    }
    if (signal.aborted) throw new QueryExecutionCancelledError('The query was cancelled.');
    if (Date.now() >= request.dto.budget.deadlineEpochMs) {
      throw new QueryExecutionDeadlineError('The query deadline has elapsed.');
    }
    const source = this.resolveSource(request.dto.source);
    if (source === undefined || !sameSourceIdentity(source.identity, request.dto.source)) {
      throw new QueryExecutionSourceError('The query source is no longer available.');
    }
    if (request.target === 'raw-records') {
      if (source.rawRecords === undefined) {
        throw new QueryExecutionUnsupportedError('The raw-record query target is not installed for this source.');
      }
      const execution = await source.rawRecords.execute(request.dto, signal);
      const settlement = createCompletedSettlement(request.dto, execution.truncation);
      assertSettlement(settlement);
      return {
        target: 'raw-records',
        result: execution.result,
        settlement,
      };
    }

    if (request.target !== 'record-page') {
      throw new QueryExecutionUnsupportedError('The query target is not supported.');
    }
    const predicate = lowerQueryAstV1(request.dto.ast);
    const pageRequest: RecordPageRequest = {
      ...request.page,
      limit: request.dto.budget.limit,
      ...(request.dto.cursor.anchorOrdinal === undefined ? {} : { anchorOrdinal: request.dto.cursor.anchorOrdinal }),
      ...(request.dto.cursor.direction === undefined ? {} : { direction: request.dto.cursor.direction }),
      ...(request.dto.cursor.sort === undefined ? {} : { sort: request.dto.cursor.sort }),
      ...(request.dto.cursor.sortOffset === undefined ? {} : { sortOffset: request.dto.cursor.sortOffset }),
      maxReturnedBytes: request.dto.budget.maxBytes,
      ...(onTiming === undefined ? {} : { onTiming }),
      ...(request.dto.budget.maxExaminedRecords === undefined && request.dto.budget.maxExaminedBytes === undefined
        ? {}
        : {
          scanBudget: {
            ...(request.dto.budget.maxExaminedRecords === undefined ? {} : { maxExaminedRecords: request.dto.budget.maxExaminedRecords }),
            ...(request.dto.budget.maxExaminedBytes === undefined ? {} : { maxExaminedBytes: request.dto.budget.maxExaminedBytes }),
            deadlineEpochMs: request.dto.budget.deadlineEpochMs,
          },
        }),
      ...(predicate === undefined ? {} : { predicate }),
    };
    assertRecordPageRequest(pageRequest);
    const page = await source.recordPage.getRows(pageRequest, signal);
    const truncationReason = page.scan?.truncatedReason;
    const settlement = truncationReason === undefined
      ? createCompletedSettlement(request.dto, undefined)
      : createCompletedSettlement(request.dto, {
        reason: truncationReason,
        ...(page.scan?.cursorOrdinal === undefined ? {} : { nextOrdinal: page.scan.cursorOrdinal }),
      });
    assertSettlement(settlement);
    return {
      target: 'record-page',
      page,
      settlement,
    };
  }
}

/** Build the versioned DTO at a Host-owned source boundary. No path is accepted. */
export function createQueryExecutionRequestV1(
  source: QuerySourceIdentityV1,
  requestId: string,
  page: RecordPageRequest,
  nowEpochMs: number = Date.now(),
): QueryExecutionRequestV1 {
  const { predicate, ...pageWithoutPredicate } = page;
  const scanBudget = page.scanBudget;
  const deadlineEpochMs = scanBudget?.deadlineEpochMs
    ?? nowEpochMs + QUERY_DTO_LIMITS.maxBudgetAheadMs;
  const dto: QueryRequestDtoV1 = {
    schema: 'jsonlview.query-dto.v1',
    version: 1,
    requestId,
    source,
    ast: createQueryAstV1(predicate),
    cursor: {
      ...(page.anchorOrdinal === undefined ? {} : { anchorOrdinal: page.anchorOrdinal }),
      ...(page.direction === undefined ? {} : { direction: page.direction }),
      ...(page.sort === undefined ? {} : { sort: page.sort }),
      ...(page.sortOffset === undefined ? {} : { sortOffset: page.sortOffset }),
    },
    budget: {
      limit: page.limit,
      // RecordPageReader exposes examined-byte budgets separately. A DTO
      // request still carries a returned-byte ceiling for adapters that can
      // measure it; the portable page remains authoritative for execution.
      maxBytes: page.maxReturnedBytes ?? String(QUERY_DTO_LIMITS.maxBytes),
      deadlineEpochMs,
      ...(scanBudget?.maxExaminedRecords === undefined ? {} : { maxExaminedRecords: scanBudget.maxExaminedRecords }),
      ...(scanBudget?.maxExaminedBytes === undefined ? {} : { maxExaminedBytes: String(scanBudget.maxExaminedBytes) }),
    },
    cancellation: { requestId },
  };
  return {
    target: 'record-page',
    dto,
    page: {
      ...(pageWithoutPredicate.columns === undefined ? {} : { columns: pageWithoutPredicate.columns }),
      ...(pageWithoutPredicate.projection === undefined ? {} : { projection: pageWithoutPredicate.projection }),
    },
  };
}

export class QueryExecutionDeadlineError extends Error {
  public readonly code = 'QUERY_DEADLINE_EXCEEDED' as const;
}

function createCompletedSettlement(
  request: QueryRequestDtoV1,
  truncation: QuerySettlementDtoV1['truncation'],
): QuerySettlementDtoV1 {
  return truncation === undefined
    ? {
      schema: request.schema,
      version: request.version,
      source: request.source,
      requestId: request.requestId,
      status: 'completed',
    }
    : {
      schema: request.schema,
      version: request.version,
      source: request.source,
      requestId: request.requestId,
      status: 'truncated',
      truncation,
    };
}

function sameSourceIdentity(left: QuerySourceIdentityV1, right: QuerySourceIdentityV1): boolean {
  return left.sourceId === right.sourceId
    && left.documentId === right.documentId
    && left.generation === right.generation
    && left.epoch === right.epoch
    && left.fingerprint === right.fingerprint;
}

function assertSettlement(value: QuerySettlementDtoV1): void {
  if (!isQuerySettlementDtoV1(value)) throw new TypeError('Query execution produced an invalid settlement.');
}
