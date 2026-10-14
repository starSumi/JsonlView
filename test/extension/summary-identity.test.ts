import { describe, expect, it } from 'vitest';
import { summaryIdentityMatches } from '../../src/extension/summary-identity';
import type { DocumentSummary } from '../../src/shared/types';

const captured: DocumentSummary = {
  snapshot: { documentId: 'doc', generation: 'g1', epoch: 1, uri: 'file:///fixture.jsonl', scheme: 'file',
    sizeBytes: '10', mtimeMs: 0, prefixFingerprint: 'fixture', observedAt: '2026-01-01T00:00:00Z' },
  profileId: 'generic', profileVersion: '1', profileSuggestions: [], indexedBytes: '10',
  indexedRecords: '1', indexingComplete: true, validRecords: '1', problemRecords: '0',
};

describe('summary publication identity', () => {
  it('permits progress within the same authority and rejects each source/profile identity change', () => {
    expect(summaryIdentityMatches(captured, { ...captured, indexedRecords: '2' })).toBe(true);
    for (const current of [
      { ...captured, snapshot: { ...captured.snapshot, documentId: 'other' } },
      { ...captured, snapshot: { ...captured.snapshot, generation: 'g2' } },
      { ...captured, snapshot: { ...captured.snapshot, epoch: 2 } },
      { ...captured, profileId: 'codex' },
      { ...captured, profileVersion: '2' },
    ]) expect(summaryIdentityMatches(captured, current)).toBe(false);
  });
});
