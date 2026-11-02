import type {
  AnalysisIntentV1,
  ColumnSpec,
  DocumentSummary,
  FieldStats,
  InsightSummary,
  ProblemPage,
  RecordDetail,
  RecordRef,
  TemporaryPreviewStatus,
} from '@shared/types';
import type { ProblemPageReader, ProblemPageRequest } from './problem-page-reader';
import type { RecordPageReader, RecordPageRequest } from './record-page-reader';

/**
 * Host-owned session boundary used by application use cases and adapters.
 * This contract intentionally contains no VS Code, React, or transport types.
 */
export interface IJsonlSessionPort extends RecordPageReader, ProblemPageReader {
  getSummary(): DocumentSummary;
  getProfileColumns(): readonly ColumnSpec[];
  getProblems(request: ProblemPageRequest, signal: AbortSignal): Promise<ProblemPage>;
  getDetail(ref: RecordRef, full: boolean, signal: AbortSignal): Promise<RecordDetail>;
  getSchema(offset: number, limit: number, signal: AbortSignal): Promise<{
    fields: FieldStats[];
    totalFields: number;
    complete: boolean;
  }>;
  getInsights(intent: AnalysisIntentV1, signal: AbortSignal): Promise<InsightSummary>;
  setProfile(profileId: string, signal: AbortSignal): Promise<DocumentSummary>;
  setFollowMode(enabled: boolean): Promise<DocumentSummary>;
  rebuild(signal: AbortSignal): Promise<DocumentSummary>;
}

/** Metadata exposed by a session-owned temporary preview, when present. */
export type SessionPreviewStatus = TemporaryPreviewStatus;

/** @deprecated Import IJsonlSessionPort from application ports for new code. */
export type JsonlSessionPort = IJsonlSessionPort;

/** @deprecated Import RecordPageRequest from application ports for new code. */
export type RowsRequest = RecordPageRequest;

/** @deprecated Import ProblemPageRequest from application ports for new code. */
export type ProblemsRequest = ProblemPageRequest;
