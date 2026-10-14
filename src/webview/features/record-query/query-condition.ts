import type { ColumnSpec, Predicate, RowFilter } from '../../../shared/types';
import { normalizePredicate } from '../../../shared/analysis-intent';
import { combinePredicates, predicateForFilter } from '../../query';
import { rowTypePredicate, type RowTypeSelection } from './query-selection';

export interface QueryConditionInput {
  query: string;
  filters: readonly RowFilter[];
  rowTypes?: RowTypeSelection;
  filterColumns: readonly ColumnSpec[];
}

export function compileQueryCondition(input: QueryConditionInput): Predicate | undefined {
  const predicate = combinePredicates(
    textPredicate(input.query),
    ...input.filters.map((filter) => predicateForFilter(filter, input.filterColumns)),
    rowTypePredicate(input.rowTypes),
  );
  return predicate === undefined ? undefined : normalizePredicate(predicate);
}

export function textPredicate(query: string): Predicate | undefined {
  const value = query.trim();
  return value ? { op: 'text_search', value, caseSensitive: false } : undefined;
}
