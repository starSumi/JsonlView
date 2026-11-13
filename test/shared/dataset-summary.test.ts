import { describe, expect, it } from 'vitest';
import { summarizeDatasetRecord } from '../../src/profiles/dataset-analysis';
import { isDatasetRecordSummary } from '../../src/shared/transport/dataset-summary';
import { createProtocolEnvelope, isExtensionMessage } from '../../src/shared/transport';

describe('dataset observation transport boundary', () => {
  it('enforces the optional summary at the real ROWS receive boundary', () => {
    const message = (dataset?: unknown) => createProtocolEnvelope({ type: 'ROWS', documentId: 'doc', generation: 'g', requestId: 'r', delivery: 'reply',
      payload: { rows: [{ ref: { generation: 'g', ordinal: '0', byteStart: '0', byteEndExclusive: '10',
        contentByteLength: '9', delimiterByteLength: 1, parseState: 'valid' }, cells: [], genericSummary: 'Row',
        ...(dataset === undefined ? {} : { dataset }) }], columns: [], anchorOrdinal: '0', hasBefore: false, hasAfter: false, indexedRecords: '1' } });
    expect(isExtensionMessage(message())).toBe(true);
    expect(isExtensionMessage(message(summarizeDatasetRecord({ question: 'q', answer: 'a' })))).toBe(true);
    for (const invalid of [null, { scene: 'qa' }, { ...summarizeDatasetRecord({ text: 'Sample' }), body: 'Source' }]) {
      expect(isExtensionMessage(message(invalid))).toBe(false);
    }
  });
  it.each([null, 4, 'text', { scene: 'qa' }, { messages: null }])('rejects incomplete observations %j', (value) => {
    expect(isDatasetRecordSummary(value)).toBe(false);
  });

  it.each([
    { prompt: 'Question', response: 'Answer' }, { input_ids: [1, 2], labels: [-100], token_count: 8 },
    { label: 0, text: 'Classify' }, { chosen: 'Yes', rejected: 'No' },
    { messages: [{ role: 'assistant', content: 'Answer', loss_weight: [1] }, null, { role: 'user', loss_weight: 'bad' }] },
    { messages: Array.from({ length: 100 }, () => ({ role: 'user', content: [] })) },
    { language: 'x'.repeat(200), images: ['opaque'], audio: 'opaque' },
  ])('accepts actual bounded producer output %j', (value) => {
    expect(isDatasetRecordSummary(summarizeDatasetRecord(value))).toBe(true);
  });

  it('rejects oversized, malformed and body-bearing fields', () => {
    const fresh = () => summarizeDatasetRecord({ text: 'Sample', input_ids: [1, 2] });
    const invalid: unknown[] = [
      { ...fresh(), body: 'Unbounded source' }, { ...fresh(), scene: '__proto__' },
      { ...fresh(), evidence: Array.from({ length: 9 }, () => ({ tokens: [] })) },
      { ...fresh(), evidence: [{ tokens: Array.from({ length: 13 }, () => ({ kind: 'key', value: 'x' })) }] },
      { ...fresh(), evidence: [{ tokens: [{ kind: 'index', value: -1 }] }] },
      { ...fresh(), categories: [{ field: 'label', value: 'x'.repeat(81) }] },
      { ...fresh(), categories: Array.from({ length: 5 }, () => ({ field: 'label', value: 'x' })) },
      { ...fresh(), issues: ['invented'] }, { ...fresh(), media: { image: NaN, audio: 0, video: 0 } },
    ];
    const count = fresh(); count.messages.observed = 65; count.messages.total = 100; invalid.push(count);
    const sequences = fresh(); sequences.tokens.sequences[0]!.inspected = 513; invalid.push(sequences);
    const weights = fresh(); weights.messages.lossWeights.specified = 2; invalid.push(weights);
    for (const value of invalid) expect(isDatasetRecordSummary(value)).toBe(false);
  });
});
