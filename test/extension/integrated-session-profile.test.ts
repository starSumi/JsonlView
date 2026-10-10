import { describe, expect, it } from 'vitest';
import type { AgentRowProjection, ColumnSpec } from '../../src/shared/types';
import {
  mergeRequestedColumns,
  profileColumns,
  profilePredicateFields,
} from '../../src/extension/integrated-session-profile';

describe('integrated session profile policy', () => {
  it('keeps profile columns first and de-duplicates requested columns within the cap', () => {
    const profile: ColumnSpec[] = [
      { id: 'eventKind', label: 'Event', source: 'profile' },
      { id: 'summary', label: 'Summary', source: 'profile' },
    ];
    const requested: ColumnSpec[] = [
      { id: 'summary', label: 'Requested summary', source: 'record' },
      { id: 'timestamp', label: 'Timestamp', source: 'record' },
    ];

    expect(mergeRequestedColumns(profile, requested)).toEqual([
      profile[0],
      profile[1],
      requested[1],
    ]);
  });

  it('provides stable columns for known and unknown profiles', () => {
    expect(profileColumns('generic')).toEqual([]);
    expect(profileColumns('codex-trace').map((column) => column.id)).toEqual([
      'eventKind', 'timestamp', 'summary', 'actor', 'status', 'sessionId', 'turnId',
    ]);
    expect(profileColumns('future-agent').map((column) => column.id)).toEqual([
      'eventKind', 'timestamp', 'actor', 'summary', 'status', 'model',
    ]);
  });

  it('exposes predicate fields without dropping derived or usage values', () => {
    const projection: AgentRowProjection = {
      profileId: 'codex-history',
      eventKind: 'message',
      actor: 'assistant',
      summary: 'hello',
      sessionId: 'session-1',
      usage: { input: 2, output: 3, cached: 1, total: 5 },
      derivedFields: { sourceKind: 'history' },
      evidence: [],
      confidence: 'source',
    };

    expect(profilePredicateFields(projection)).toMatchObject({
      profileId: 'codex-history',
      actor: 'assistant',
      summary: 'hello',
      sessionId: 'session-1',
      sourceKind: 'history',
      usageInput: 2,
      usageOutput: 3,
      usageCached: 1,
      usageTotal: 5,
    });
  });
});
