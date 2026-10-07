import { describe, expect, it } from 'vitest';
import {
  buildSyntheticNavigationIndex,
  SyntheticNavigationAdapter,
  type NavigationBudget,
  type SyntheticNavigationRecord,
} from '../../src/experimental';

const capturedAt = '2026-10-07T00:00:00.000Z';

function budget(maxEntities = 500, maxRelations = 2_000): Required<NavigationBudget> {
  return { maxEntities, maxRelations, maxRecords: 2_000, maxDiagnostics: 1_000, maxMilliseconds: 1_000 };
}

describe('synthetic navigation provider adapter', () => {
  it('projects agent topology while dropping payload-shaped fields', () => {
    const records: readonly unknown[] = [
      { type: 'session', id: 'session-1', label: 'Session 1', prompt: 'do not expose this' },
      { type: 'team', id: 'team-1', label: 'Release team', parentId: 'session-1', confidence: 'correlated' },
      { type: 'workflow', id: 'workflow-1', label: 'Validation workflow', parentId: 'team-1' },
      { type: 'subagent', id: 'agent-1', label: 'Worker', parentId: 'team-1', relations: [{ kind: 'spawn', targetId: 'tool-1' }] },
      { type: 'tool', id: 'tool-1', label: 'Check', relations: [{ kind: 'uses', targetId: 'workflow-1' }] },
      { type: 'task', id: 'task-1', label: 'Forked task', relations: [{ kind: 'fork', targetId: 'agent-1' }] },
      { type: 'event', id: 'event-1', label: 'Child event', relations: [{ kind: 'child', targetId: 'task-1' }] },
    ];
    const result = buildSyntheticNavigationIndex({ sourceId: 'synthetic-agent', sourceGeneration: 'gen-1', capturedAt, records });
    expect(result.status).toBe('ok');
    expect(result.index.snapshot.redaction).toBe('metadata-only');
    expect(result.index.snapshot.entities.map((entity) => entity.kind)).toEqual([
      'session', 'team', 'workflow', 'subagent', 'tool', 'task', 'event',
    ]);
    expect(result.index.snapshot.relations.map((relation) => relation.kind)).toEqual([
      'parent', 'parent', 'parent', 'spawn', 'uses', 'fork', 'child',
    ]);
    const encoded = JSON.stringify(result.index.snapshot);
    expect(encoded).not.toContain('do not expose this');
    expect(encoded).not.toContain('prompt');
    expect(result.index.snapshot.entities.find((entity) => entity.nativeId === 'team-1')?.confidence).toBe('correlated');
  });

  it('reports malformed and unsupported records without poisoning valid rows', () => {
    const records: readonly unknown[] = [
      null,
      { type: 'future-provider-node', id: 'future-1', label: 'ignored' },
      { type: 'thread', id: 'thread-1', label: 'valid' },
      { type: 'thread', id: 'thread-1', label: 'duplicate' },
      { type: 'thread', id: 'thread-2', label: 'C:/private/prompt.txt' },
    ];
    const result = buildSyntheticNavigationIndex({ sourceId: 'synthetic-agent', sourceGeneration: 'gen-1', capturedAt, records });
    expect(result.status).toBe('ok');
    expect(result.index.acceptedRecords).toBe(1);
    expect(result.index.rejectedRecords).toBe(4);
    expect(result.index.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'malformed', 'unsupported', 'malformed', 'malformed',
    ]);
    expect(result.index.snapshot.entities.map((entity) => entity.nativeId)).toEqual(['thread-1']);
  });

  it('bounds entities and relations with explicit truncation reasons', () => {
    const entityBound = buildSyntheticNavigationIndex({
      sourceId: 'synthetic-agent', sourceGeneration: 'gen-1', capturedAt, maxEntities: 2,
      records: [
        { type: 'session', id: 's-1', label: 'one' },
        { type: 'thread', id: 't-1', label: 'two' },
        { type: 'task', id: 'task-1', label: 'three' },
      ],
    });
    expect(entityBound.index.snapshot.truncated).toBe(true);
    expect(entityBound.index.snapshot.truncatedReason).toBe('entity_limit');
    expect(entityBound.index.snapshot.entities).toHaveLength(2);

    const relationBound = buildSyntheticNavigationIndex({
      sourceId: 'synthetic-agent', sourceGeneration: 'gen-1', capturedAt, maxRelations: 1,
      records: [
        { type: 'session', id: 's-1', label: 'one' },
        { type: 'thread', id: 't-1', label: 'two', parentId: 's-1', relations: [{ kind: 'contains', targetId: 's-1' }] },
      ],
    });
    expect(relationBound.index.snapshot.relations).toHaveLength(1);
    expect(relationBound.index.snapshot.truncated).toBe(true);
    expect(relationBound.index.snapshot.truncatedReason).toBe('relation_limit');
  });

  it('bounds raw records and diagnostics before the projection can grow without limit', () => {
    const recordBound = buildSyntheticNavigationIndex({
      sourceId: 'synthetic-agent', sourceGeneration: 'gen-1', capturedAt, maxRecords: 2,
      records: [
        { type: 'session', id: 's-1', label: 'one' },
        { type: 'thread', id: 't-1', label: 'two' },
        { type: 'task', id: 'task-1', label: 'three' },
      ],
    });
    expect(recordBound.status).toBe('truncated');
    expect(recordBound.index.recordsExamined).toBe(2);
    expect(recordBound.index.recordsTruncated).toBe(true);
    expect(recordBound.index.snapshot.truncatedReason).toBe('record_limit');
    expect(recordBound.index.diagnostics.at(-1)).toMatchObject({ code: 'limit', reason: 'record_limit' });

    const diagnosticBound = buildSyntheticNavigationIndex({
      sourceId: 'synthetic-agent', sourceGeneration: 'gen-1', capturedAt, maxDiagnostics: 1,
      records: [null, { type: 'future', id: 'future-1' }, null],
    });
    expect(diagnosticBound.status).toBe('truncated');
    expect(diagnosticBound.index.diagnostics).toHaveLength(1);
    expect(diagnosticBound.index.diagnosticsTruncated).toBe(true);
    expect(diagnosticBound.index.snapshot.truncatedReason).toBe('diagnostic_limit');
  });

  it('keeps generations immutable across rebuilds and gives each projection a stable id', async () => {
    const adapter = new SyntheticNavigationAdapter('synthetic-agent');
    const firstRecords: readonly SyntheticNavigationRecord[] = [{ type: 'session', id: 's-1', label: 'first' }];
    const first = adapter.provider({ sourceGeneration: 'gen-1', capturedAt, records: firstRecords });
    const firstIndex = first.buildIndex();
    const rebuilt = first.rebuild({
      sourceGeneration: 'gen-2',
      capturedAt: '2026-10-07T00:01:00.000Z',
      records: [...firstRecords, { type: 'subagent', id: 'a-1', label: 'second', parentId: 's-1' }],
    });
    const secondIndex = rebuilt.buildIndex();

    expect(firstIndex.sourceGeneration).toBe('gen-1');
    expect(secondIndex.sourceGeneration).toBe('gen-2');
    expect(firstIndex.snapshot.snapshotId).not.toBe(secondIndex.snapshot.snapshotId);
    expect(firstIndex.snapshot.entities).toHaveLength(1);
    expect(secondIndex.snapshot.entities).toHaveLength(2);
    await expect(first.readSnapshot(new AbortController().signal, budget())).resolves.toMatchObject({ sourceGeneration: 'gen-1' });
    await expect(rebuilt.readSnapshot(new AbortController().signal, budget())).resolves.toMatchObject({ sourceGeneration: 'gen-2' });
  });

  it('honors negotiated facade bounds and cancellation before reading', async () => {
    const adapter = new SyntheticNavigationAdapter('synthetic-agent');
    const provider = adapter.provider({
      sourceGeneration: 'gen-1',
      capturedAt,
      records: [
        { type: 'session', id: 's-1', label: 'one' },
        { type: 'thread', id: 't-1', label: 'two', parentId: 's-1' },
      ],
    });
    const result = await provider.readSnapshot(new AbortController().signal, budget(1, 2_000));
    expect(result.entities).toHaveLength(1);
    expect(result.truncatedReason).toBe('entity_limit');

    const controller = new AbortController();
    controller.abort();
    await expect(provider.readSnapshot(controller.signal, budget())).rejects.toThrow('cancelled');
  });

  it('returns an explicit time-limit snapshot when the cooperative clock reaches its deadline', async () => {
    let tick = 0;
    const adapter = new SyntheticNavigationAdapter('synthetic-agent');
    const provider = adapter.provider({
      sourceGeneration: 'gen-1',
      capturedAt,
      now: () => (tick++ === 0 ? 100 : 105),
      records: [{ type: 'session', id: 's-1', label: 'one' }],
    });
    const result = await provider.readSnapshot(new AbortController().signal, { ...budget(), maxMilliseconds: 5 });
    expect(result.truncated).toBe(true);
    expect(result.truncatedReason).toBe('time_limit');
  });

  it('rejects unsafe identity, labels, and budgets before constructing a projection', () => {
    expect(() => buildSyntheticNavigationIndex({ sourceId: 'C:/private', sourceGeneration: 'gen-1', capturedAt, records: [] })).toThrow('opaque identifier');
    expect(() => buildSyntheticNavigationIndex({ sourceId: 'synthetic-agent', sourceGeneration: 'gen-1', capturedAt, maxEntities: 0, records: [] })).toThrow('maxEntities');
    const result = buildSyntheticNavigationIndex({ sourceId: 'synthetic-agent', sourceGeneration: 'gen-1', capturedAt, records: [
      { type: 'thread', id: 't-1', label: 'ok', relations: 'nope' },
      { type: 'thread', id: 't-2', label: 'bad\nlabel' },
    ] });
    expect(result.index.diagnostics.map((diagnostic) => diagnostic.reason)).toEqual(['invalid_relation', 'invalid_label']);
  });

  it('copies provider input and does not expose nested relation or unknown-field mutations', async () => {
    const adapter = new SyntheticNavigationAdapter('synthetic-agent');
    const relation = { kind: 'spawn', targetId: 'tool-1' };
    const record: Record<string, unknown> = { type: 'subagent', id: 'agent-1', label: 'Worker', relations: [relation], prompt: 'secret' };
    const provider = adapter.provider({ sourceGeneration: 'gen-1', capturedAt, records: [record] });
    relation.targetId = 'changed';
    record.label = 'changed';
    const snapshot = await provider.readSnapshot(new AbortController().signal, budget());
    expect(snapshot.entities[0]?.label).toBe('Worker');
    expect(snapshot.relations).toEqual([]);
  });

  it('rejects an oversized provider capture before copying records', () => {
    const adapter = new SyntheticNavigationAdapter('synthetic-agent');
    expect(() => adapter.provider({
      sourceGeneration: 'gen-1',
      capturedAt,
      maxRecords: 1,
      records: [
        { type: 'session', id: 's-1', label: 'one' },
        { type: 'session', id: 's-2', label: 'two' },
      ],
    })).toThrow('maxRecords capture budget');
  });
});
