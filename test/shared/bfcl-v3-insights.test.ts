import { describe, expect, it } from 'vitest';
import { summarizeBfclV3Record, aggregateBfclV3Summaries } from '../../src/profiles/datasets/bfcl-v3';
import { PROTOCOL_VERSION } from '../../src/shared/types';
import { createProtocolEnvelope, isExtensionMessage } from '../../src/shared/transport';
import { isBfclV3RecordSummary, isBfclV3SampleSummary } from '../../src/shared/transport/bfcl-v3-insights';

describe('BFCL insights transport boundary', () => {
  it('accepts bounded adapter output and rejects source-bearing or malformed DTOs', () => {
    const summary = summarizeBfclV3Record({ id: 'simple_1', multi_turn: false, functions: '[]', tools: '[]', missed_functions: '{}', initial_config: '{}', involved_classes: [], turns: '[]', language: 'Python', test_category: 'simple', subset: 'simple', ground_truth: '[]' });
    expect(isBfclV3RecordSummary(summary)).toBe(true);
    expect(isBfclV3RecordSummary({ ...summary, prompt: 'private' })).toBe(false);
    expect(isBfclV3RecordSummary({ ...summary, functions: { ...summary.functions, definitions: -1 } })).toBe(false);
    expect(isBfclV3RecordSummary({ ...summary, nope: true })).toBe(false);
  });

  it('enforces sample coverage and rejects invalid aggregates', () => {
    const record = summarizeBfclV3Record({ id: 'simple_1', multi_turn: false, functions: '[]', tools: '[]', missed_functions: '{}', initial_config: '{}', involved_classes: [], turns: '[]', language: 'Python', test_category: 'simple', subset: 'simple', ground_truth: '[]' });
    const summary = aggregateBfclV3Summaries([record]);
    expect(isBfclV3SampleSummary(summary)).toBe(true);
    expect(isBfclV3SampleSummary({ ...summary, coverage: { ...summary.coverage, sampledRecords: 257 } })).toBe(false);
    expect(isBfclV3SampleSummary({ ...summary, distributions: [{ field: 'language', values: [{ value: 'x'.repeat(81), count: 1 }], otherObservations: 0 }] })).toBe(false);
  });

  it('validates BFCL insights only as a bounded ROWS projection', () => {
    const record = summarizeBfclV3Record({ id: 'simple_1', multi_turn: false, functions: '[]', tools: '[]', turns: '[]', language: 'Python', test_category: 'simple', subset: 'simple', ground_truth: '{}' });
    const row = {
      ref: { generation: 'g', ordinal: '0', byteStart: '0', byteEndExclusive: '2', contentByteLength: '1', delimiterByteLength: 1, parseState: 'valid' },
      cells: [], genericSummary: 'row', datasetInsights: { bfclV3: record },
    };
    const message = createProtocolEnvelope({ type: 'ROWS', documentId: 'd', generation: 'g', requestId: 'r', payload: {
      rows: [row], columns: [], anchorOrdinal: '0', hasBefore: false, hasAfter: false, indexedRecords: '1',
    }});
    expect(message.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(isExtensionMessage(message)).toBe(true);
    expect(isExtensionMessage({ ...message, payload: { ...message.payload, rows: [{ ...row, datasetInsights: {} }] } })).toBe(false);
    expect(isExtensionMessage({ ...message, payload: { ...message.payload, rows: [{ ...row, datasetInsights: { bfclV3: record, unknown: true } }] } })).toBe(false);
  });
});
