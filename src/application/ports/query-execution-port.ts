import {
  createQueryAstV1,
  lowerQueryAstV1,
  type QueryAstV1,
} from '@shared/query-ast';
import {
  isQueryRequestDtoV1,
  QUERY_DTO_LIMITS,
  type QueryRequestDtoV1,
  type QuerySettlementDtoV1,
  type QuerySourceIdentityV1,
  type QueryTruncationV1,
} from '@shared/query-dto';
import type { RowPage } from '@shared/types';
import {
  assertRecordPageRequest,
  type RecordPageReader,
  type RecordPageRequest,
} from './record-page-reader';

/** Explicit result targets prevent a raw MCP page from being confused with a projected Webview page. */
export type QueryExecutionTargetV1 = 'record-page' | 'raw-records';

export interface QueryExecutionSourceV1 {
  readonly identity: QuerySourceIdentityV1;
  readonly recordPage: RecordPageReader;
  /** A future raw adapter may opt in; no raw adapter is installed by GET_ROWS. */
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
  readonly page: Omit<RecordPageRequest, 'predicate'>;
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
  ): Promise<QueryExecutionResultV1> {
    if (!isQueryRequestDtoV1(request.dto)) {
      throw new TypeError('Invalid query request DTO v1.');
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
      return {
        target: 'raw-records',
        result: execution.result,
        settlement: createCompletedSettlement(request.dto, execution.truncation),
      };
    }

    const predicate = lowerQueryAstV1(request.dto.ast);
    const pageRequest: RecordPageRequest = predicate === undefined
      ? { ...request.page }
      : { ...request.page, predicate };
    assertRecordPageRequest(pageRequest);
    const page = await source.recordPage.getRows(pageRequest, signal);
    const truncationReason = page.scan?.truncatedReason;
    return {
      target: 'record-page',
      page,
      settlement: truncationReason === undefined
        ? createCompletedSettlement(request.dto, undefined)
        : createCompletedSettlement(request.dto, {
          reason: truncationReason,
          ...(page.scan?.cursorOrdinal === undefined ? {} : { nextOrdinal: page.scan.cursorOrdinal }),
        }),
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
      maxBytes: String(QUERY_DTO_LIMITS.maxBytes),
      deadlineEpochMs,
      ...(scanBudget?.maxExaminedRecords === undefined ? {} : { maxExaminedRecords: scanBudget.maxExaminedRecords }),
      ...(scanBudget?.maxExaminedBytes === undefined ? {} : { maxExaminedBytes: String(scanBudget.maxExaminedBytes) }),
    },
    cancellation: { requestId },
  };
  return { target: 'record-page', dto, page: pageWithoutPredicate };
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
