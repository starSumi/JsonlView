import { describe, expect, it } from 'vitest';
import { keyPath, type ColumnSpec, type RowProjection } from '../../src/shared/types';
import {
  datasetProvenanceTooltip,
  projectionIntentKey,
  selectedRecordColumnIds,
  workspaceAvailableColumns,
  workspaceBaseColumns,
  workspaceDatasetProjectionAvailable,
  workspaceHasPartialContinuation,
  workspacePageRange,
  workspacePartialBannerIdentity,
  workspacePartialScan,
  workspaceRecordColumnLimit,
  workspaceShowsPageControls,
  workspaceTableColumns,
} from '../../src/webview/features/workspace/projections';
import { createInitialState } from '../../src/webview/state';

const profileColumn: ColumnSpec = { id: 'summary', label: 'Summary', source: 'profile' };
const recordPath = keyPath('message');
const recordColumn: ColumnSpec = { id: JSON.stringify(recordPath.tokens), label: 'Message', source: 'record', path: recordPath };

function row(ordinal: string, columnIds: string[]): RowProjection {
  return {
    ref: {
      generation: 'g1',
      ordinal,
      byteStart: ordinal,
      byteEndExclusive: String(Number(ordinal) + 1),
      contentByteLength: '1',
      delimiterByteLength: 1,
      parseState: 'valid',
    },
    cells: columnIds.map((columnId) => ({ columnId, value: columnId })),
    genericSummary: ordinal,
  };
}

describe('workspace projections', () => {
  it('preserves the existing projection intent discriminants', () => {
    const state = createInitialState();
    const first = projectionIntentKey(state, { conversation: false, dataset: true });
    const next = projectionIntentKey({ ...state, query: 'needle' }, { conversation: false, dataset: true });

    expect(first).not.toBe(next);
    expect(projectionIntentKey(state, { conversation: false, dataset: true }))
      .toBe(first);
  });

  it('keeps column fallbacks and limits as pure projections', () => {
    const rows = [row('1', ['message', 'status']), row('2', ['message', 'actor'])];
    const base = workspaceBaseColumns([], rows);
    expect(base.map((column) => column.id)).toEqual(['message', 'status', 'actor']);
    expect(workspaceBaseColumns([profileColumn], rows)).toBeDefined();
    expect(selectedRecordColumnIds([profileColumn, recordColumn], [], { [recordColumn.id]: true })).toEqual(new Set([recordColumn.id]));
    expect(workspaceAvailableColumns([profileColumn, recordColumn], [], {})).toEqual([profileColumn, recordColumn]);
    expect(workspaceRecordColumnLimit([profileColumn])).toBe(63);
    expect(workspaceTableColumns([profileColumn, recordColumn], {}, []).map((column) => column.id))
      .toEqual(['__ordinal', 'summary', recordColumn.id]);
  });

  it('projects truncated page state without changing query ownership', () => {
    const page = {
      anchorOrdinal: '1',
      hasBefore: false,
      hasAfter: true,
      sortOffset: '0',
      sortNextOffset: '2',
      scan: { examinedRecords: '2', examinedBytes: '20', cursorOrdinal: '2', truncatedReason: 'record_limit' as const },
    };
    expect(workspacePartialScan(page)).toBe(true);
    expect(workspaceHasPartialContinuation(true, undefined, page)).toBe(true);
    expect(workspacePartialBannerIdentity(page)).toBe('1|0|2|2|2|record_limit');
    expect(workspacePageRange([row('1', ['message']), row('2', ['message'])])).toBe('Rows #1-#2');
    expect(workspaceShowsPageControls('table', [], page, true)).toBe(true);
    expect(workspaceShowsPageControls('schema', [], page, true)).toBe(false);
    expect(workspaceDatasetProjectionAvailable({ page, pageProjectionProfileId: 'codex-rollout', summary: undefined })).toBe(false);
  });

  it('keeps bounded dataset status wording stable', () => {
    expect(datasetProvenanceTooltip({
      version: 1,
      status: 'pending',
      samplePlan: { strategy: 'head', maxRecords: 32, maxBytes: 262144 },
    })).toBe('Dataset head sample pending');
    expect(datasetProvenanceTooltip({
      version: 1,
      status: 'timeout',
      samplePlan: { strategy: 'head', maxRecords: 32, maxBytes: 262144 },
      terminal: {
        stage: 'head-inspection',
        code: 'deadline_exceeded',
        retryable: true,
        action: 'reload',
      },
    })).toBe('Dataset detection timeout at head-inspection: deadline_exceeded. Reload to retry.');
  });
});
