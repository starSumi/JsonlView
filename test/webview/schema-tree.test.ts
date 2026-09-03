import { describe, expect, it } from 'vitest';
import { buildSchemaTree, visibleSchemaNodes } from '../../src/webview/views';
import type { FieldStats } from '../../src/shared/types';

function field(path: string[], leaf: string): FieldStats {
  return {
    path: { tokens: path.map((value) => ({ kind: 'key' as const, value })) },
    displayPath: `$${path.map((value) => `.${value}`).join('')}`,
    seenRecords: '4',
    validRecordsObserved: '4',
    kinds: { string: '4' },
    missingRecords: '0',
    nullRecords: '0',
    examples: [leaf],
    firstSeenOrdinal: '0',
    lastSeenOrdinal: '3',
    confidence: 'complete',
  };
}

describe('schema tree projection', () => {
  it('groups dotted JSON paths and expands only selected branches', () => {
    const root = buildSchemaTree([
      field(['payload', 'message'], 'hello'),
      field(['payload', 'status'], 'ok'),
      field(['meta', 'id'], '1'),
    ]);
    const collapsed = visibleSchemaNodes(root, new Set(['$']));
    expect(collapsed.map((row) => row.label)).toEqual(['$', 'payload', 'meta']);

    const payload = collapsed.find((row) => row.label === 'payload')!;
    const expanded = visibleSchemaNodes(root, new Set(['$', payload.id]));
    expect(expanded.map((row) => row.label)).toEqual(['$', 'payload', 'message', 'status', 'meta']);
  });
});
