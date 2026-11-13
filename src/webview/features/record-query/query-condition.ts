import type { ColumnSpec, Predicate, RowFilter } from '@shared/types';
import { normalizePredicate } from '@shared/analysis-intent';
import { createQueryAstV1, type QueryAstV1 } from '@shared/contracts/query-ast';
import { parseQueryDsl, type QueryDiagnostic, type QueryParseResult } from '@shared/query-parser';
import { combinePredicates, predicateForFilter } from '@webview/query';
import { rowTypePredicate, type RowTypeSelection } from './query-selection';

export interface QueryConditionInput {
  query: string;
  filters: readonly RowFilter[];
  rowTypes?: RowTypeSelection;
  filterColumns: readonly ColumnSpec[];
}

export interface DslQueryConditionResult {
  readonly ok: boolean;
  readonly ast: QueryAstV1 | undefined;
  readonly predicate: Predicate | undefined;
  readonly diagnostics: readonly QueryDiagnostic[];
}

export function compileQueryCondition(input: QueryConditionInput): Predicate | undefined {
  const predicate = combinePredicates(
    textPredicate(input.query),
    ...input.filters.map((filter) => predicateForFilter(filter, input.filterColumns)),
    rowTypePredicate(input.rowTypes),
  );
  return predicate === undefined ? undefined : normalizePredicate(predicate);
}

/** Compile an explicit DSL draft through the existing Predicate composition path. */
export function compileDslQueryCondition(input: QueryConditionInput): DslQueryConditionResult {
  const parsed: QueryParseResult = parseQueryDsl(input.query);
  if (!parsed.ok) {
    return {
      ok: false,
      ast: undefined,
      predicate: undefined,
      diagnostics: parsed.diagnostics,
    };
  }
  const predicate = combinePredicates(
    parsed.predicate,
    ...input.filters.map((filter) => predicateForFilter(filter, input.filterColumns)),
    rowTypePredicate(input.rowTypes),
  );
  const normalized = predicate === undefined ? undefined : normalizePredicate(predicate);
  return {
    ok: true,
    ast: createQueryAstV1(normalized),
    predicate: normalized,
    diagnostics: [],
  };
}

export function textPredicate(query: string): Predicate | undefined {
  const value = query.trim();
  return value ? { op: 'text_search', value, caseSensitive: false } : undefined;
}
