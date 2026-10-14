import type { DocumentSummary } from '../shared/types';

/** Authority captured by a summary-producing operation, before asynchronous delivery. */
export function summaryIdentityMatches(captured: DocumentSummary, current: DocumentSummary): boolean {
  return captured.snapshot.documentId === current.snapshot.documentId
    && captured.snapshot.generation === current.snapshot.generation
    && captured.snapshot.epoch === current.snapshot.epoch
    && captured.profileId === current.profileId
    && captured.profileVersion === current.profileVersion;
}
