import type {
  ColumnSpec,
  Predicate,
  RowPage,
  RowScanBudget,
  RowSort,
} from '../../shared/types';

/** Request owned by the record-page application use case, independent of VS Code transport. */
export interface RecordPageRequest {
  anchorOrdinal?: string;
  direction?: 'forward' | 'backward';
  limit: number;
  predicate?: Predicate;
  columns?: ColumnSpec[];
  sort?: RowSort;
  sortOffset?: string;
  scanBudget?: RowScanBudget;
}

/** Read-only port implemented by the current session adapter. */
export interface RecordPageReader {
  getRows(request: RecordPageRequest, signal: AbortSignal): Promise<RowPage>;
}
