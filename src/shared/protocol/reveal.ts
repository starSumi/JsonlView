export * from '../contracts/reveal';

import type { RevealResultOutcome } from '../contracts/reveal';

/** Host-local settlement data for the interactive record reveal lifecycle. */
export interface RevealResult {
  readonly outcome: RevealResultOutcome;
  readonly documentId: string;
  readonly generation: string;
  readonly epoch?: number;
  readonly requestId: string;
  readonly anchorOrdinal: string;
}

/** Authorized host-local target retained while a reveal is in flight. */
export interface RevealRowTarget {
  readonly sourceId: string;
  readonly nativeId: string;
  readonly anchorOrdinal: string;
}
