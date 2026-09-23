/**
 * Public engine surface. Consumers should import only from this module; the
 * remaining files are implementation details and may change independently.
 */
export {
  JsonlFileEngine,
  type BackgroundIndexHandle,
  type EngineDiagnostics,
  type GetDetailOptions,
  type GetProblemsOptions,
  type GetRowsOptions,
  type IndexMoreOptions,
  type JsonlEngineOptions,
  type NativeNewlineScannerSetting,
  type JsonlOperationContext,
  type RowEnricher,
  type SourceRefreshKind,
  type SourceRefreshResult,
} from './jsonl-engine';
export type { RowScanBudget } from '../shared/types';
export { JsonlEngineError, isAbortError, type EngineErrorCode } from './errors';
export {
  evaluatePredicate,
  jsonKindOf,
  resolveFieldPath,
  type PredicateContext,
  type ResolvedField,
} from './predicate';
