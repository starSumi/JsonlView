import { describe, expect, it } from 'vitest';
import { analysisIntentEquals, normalizePredicate } from '../../src/shared/analysis-intent';
import type { AnalysisIntentV1, Predicate } from '../../src/shared/types';

describe('AnalysisIntent v1', () => {
  it('normalizes associative conditions without mutating source predicates', () => {
    const one: Predicate = { op: 'profile_exists', field: 'status' };
    const two: Predicate = { op: 'text_search', value: 'needle', caseSensitive: false };
    const source: Predicate = { op: 'and', args: [one, { op: 'and', args: [two] }] };
    expect(normalizePredicate(source)).toEqual(normalizePredicate({ op: 'and', args: [two, one] }));
    expect(source.args[1]).toEqual({ op: 'and', args: [two] });
  });

  it('ignores object key order but requires each source, profile and revision field to match', () => {
    const intent: AnalysisIntentV1 = { version: 1, intentRevision: 4, dimension: 'eventKind',
      scope: 'current-view', document: { documentId: 'doc', generation: 'g1', sourceEpoch: 1 },
      profile: { id: 'generic', version: '1' },
      predicate: { op: 'text_search', value: 'needle', caseSensitive: false } };
    expect(analysisIntentEquals(intent, { ...intent,
      predicate: { caseSensitive: false, value: 'needle', op: 'text_search' },
    })).toBe(true);
    for (const changed of [
      { ...intent, intentRevision: 5 },
      { ...intent, document: { ...intent.document, sourceEpoch: 2 } },
      { ...intent, document: { ...intent.document, generation: 'g2' } },
      { ...intent, profile: { ...intent.profile, version: '2' } },
    ]) expect(analysisIntentEquals(intent, changed)).toBe(false);
  });
});
