import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEventKind, FieldStats, ProblemRef, RecordRef, RowProjection } from '../../src/shared/types';
import { EmptyState, ProblemsView, SchemaView, TimelineView, buildSchemaTree, fallbackColumns, getCellPreview, visibleSchemaNodes } from '../../src/webview/views';

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: vi.fn(({ count }: { count: number }) => ({
    getTotalSize: () => count * 40,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 40, size: 40 })),
  })),
}));

const ref = (ordinal: string): RecordRef => ({
  generation: 'g1', ordinal, byteStart: ordinal, byteEndExclusive: String(Number(ordinal) + 2),
  contentByteLength: '1', delimiterByteLength: 1, parseState: 'valid',
});

const profileRow = (kind: string, ordinal = '0'): RowProjection => ({
  ref: ref(ordinal), cells: [{ columnId: 'status', value: 'ok' }], genericSummary: 'summary',
  profile: {
    profileId: 'synthetic', eventKind: kind as AgentEventKind, summary: 'Event summary',
    actor: 'assistant', timestamp: '2026-10-06T00:00:00Z', status: 'ok', confidence: 'source', evidence: [],
  },
});

describe('webview semantic views', () => {
  it('renders empty state and resolves every event icon category', () => {
    expect(renderToStaticMarkup(<EmptyState title="Empty" detail="No rows" />)).toContain('No rows');
    const kinds = ['tool_call', 'tool_result', 'error', 'message', 'log', 'span', 'task', 'action', 'observation', 'patch', 'test', 'result', 'other'];
    const markup = renderToStaticMarkup(<TimelineView rows={kinds.map((kind, index) => profileRow(kind, String(index)))} onSelect={vi.fn()} />);
    expect(markup).toContain('Event summary');
    expect(markup).toContain('tool call');
    expect(markup).toContain('2026-10-06T00:00:00Z');
  });

  it('renders an empty timeline and skips rows without a semantic profile', () => {
    expect(renderToStaticMarkup(<TimelineView rows={[]} onSelect={vi.fn()} />)).toContain('No semantic events in this page');
    const { profile: _profile, ...rowWithoutProfile } = profileRow('message');
    const row = rowWithoutProfile;
    expect(renderToStaticMarkup(<TimelineView rows={[row]} onSelect={vi.fn()} />)).not.toContain('Event summary');
  });

  it('builds and expands a nested schema tree, including array paths', () => {
    const fields: FieldStats[] = [
      { path: { tokens: [{ kind: 'key', value: 'message' }, { kind: 'key', value: 'role' }] }, displayPath: '$.message.role', seenRecords: '2', validRecordsObserved: '2', kinds: { string: '2' }, missingRecords: '0', nullRecords: '0', examples: ['assistant'], firstSeenOrdinal: '0', lastSeenOrdinal: '1', confidence: 'complete' },
      { path: { tokens: [{ kind: 'key', value: 'items' }, { kind: 'index', value: 0 }] }, displayPath: '$.items[0]', seenRecords: '1', validRecordsObserved: '1', kinds: { object: '1' }, missingRecords: '1', nullRecords: '0', examples: [], firstSeenOrdinal: '0', lastSeenOrdinal: '0', confidence: 'sampled' },
    ];
    const root = buildSchemaTree(fields);
    expect(root.children.map((child) => child.label)).toEqual(['message', 'items']);
    const collapsed = visibleSchemaNodes(root, new Set());
    expect(collapsed).toHaveLength(1);
    const expanded = visibleSchemaNodes(root, new Set(['$', '$/key:message', '$/key:items']));
    expect(expanded.map((node) => node.label)).toEqual(['$', 'message', 'role', 'items', '[0]']);
    const markup = renderToStaticMarkup(<SchemaView fields={fields} total={2} loading={false} />);
    expect(markup).toContain('Observed JSON schema tree');
    expect(markup).toContain('message');
    expect(markup).toContain('Missing / null');
  });

  it('shows schema loading and empty states', () => {
    expect(renderToStaticMarkup(<SchemaView fields={[]} total={0} loading />)).toContain('Loading schema');
    expect(renderToStaticMarkup(<SchemaView fields={[]} total={0} loading={false} />)).toContain('No schema fields indexed');
  });

  it('renders partial problem scans, continuation, and selectable problem rows', () => {
    const onContinue = vi.fn();
    const onSelectOrdinal = vi.fn();
    const problem: ProblemRef = { code: 'INVALID_JSON', message: 'Malformed record', severity: 'error', ref: ref('7') };
    const visibleProblem = { ...problem, ordinal: '7' };
    const partial = renderToStaticMarkup(<ProblemsView problems={[visibleProblem]} onSelectOrdinal={onSelectOrdinal} complete={false} hasAfter onContinue={onContinue} />);
    expect(partial).toContain('Problem scan is partial');
    expect(partial).toContain('Malformed record');
    expect(partial).toContain('#7');
    expect(partial).toContain('Continue scan');
    const empty = renderToStaticMarkup(<ProblemsView problems={[]} onSelectOrdinal={onSelectOrdinal} complete={false} hasAfter onContinue={onContinue} loading />);
    expect(empty).toContain('Scanning the next problem window');
    expect(empty).toContain('Scanning problems');
  });

  it('keeps fallback columns bounded and joins visible cell previews', () => {
    const rows = [{ ...profileRow('message'), cells: [{ columnId: 'a', value: 'one' }, { columnId: 'b', preview: 'two' }, { columnId: 'a', value: 'duplicate' }] }];
    expect(fallbackColumns(rows).map((column) => column.id)).toEqual(['a', 'b']);
    expect(getCellPreview(rows[0]!)).toContain('one two duplicate');
  });
});
