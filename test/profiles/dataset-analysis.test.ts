import { describe, expect, it } from 'vitest';
import { aggregateDatasetSummaries, DATASET_ANALYSIS_LIMITS, summarizeDatasetRecord } from '../../src/profiles/dataset-analysis';

describe('bounded dataset observations', () => {
  it.each([
    { value: { text: 'A corpus document' }, scene: 'pretraining', target: 'not-applicable' },
    { value: { instruction: 'Translate', input: 'hello', output: 'bonjour' }, scene: 'instruction', target: 'present' },
    { value: { prompt: 'Continue', response: 'a response' }, scene: 'instruction', target: 'present' },
    { value: { prompt: 'Continue' }, scene: 'instruction', target: 'missing' },
    { value: { question: 'Why?', answer: '' }, scene: 'qa', target: 'empty' },
    { value: { chosen: 'preferred', rejected: 'alternative' }, scene: 'preference', target: 'present' },
    { value: { chosen: 'preferred' }, scene: 'preference', target: 'missing' },
    { value: { text: 'Classify me', label: false }, scene: 'classification', target: 'present' },
    { value: { tokens: ['a', 'b'], token_count: 2 }, scene: 'tokenized', target: 'not-applicable' },
    { value: { custom: { retained: true } }, scene: 'unknown', target: 'unknown' },
  ])('observes $scene / $target using source structure', ({ value, scene, target }) => {
    const before = JSON.stringify(value);
    const summary = summarizeDatasetRecord(value, 'valid');
    expect(summary).toMatchObject({ version: 1, valid: true, scene, target });
    expect(JSON.stringify(value)).toBe(before);
  });

  it('uses explicit source paths and never copies body text or media addresses', () => {
    const summary = summarizeDatasetRecord({
      instruction: 'PRIVATE_BODY', output: 'PRIVATE_TARGET',
      images: ['https://example.invalid/private.png'],
      category: 'coding', split: 'train',
      payload: { instruction: 'must not unwrap', output: 'ignored' },
    });
    expect(summary.evidence).toContainEqual({ tokens: [{ kind: 'key', value: 'instruction' }] });
    expect(summary.media).toEqual({ image: 1, audio: 0, video: 0 });
    expect(summary.categories).toEqual([{ field: 'category', value: 'coding' }, { field: 'split', value: 'train' }]);
    expect(JSON.stringify(summary)).not.toMatch(/PRIVATE_BODY|PRIVATE_TARGET|https:|must not unwrap/);
  });

  it('counts actual array lengths separately from source declared counts and literal -100', () => {
    const summary = summarizeDatasetRecord({
      input_ids: [10, 11, 12], labels: [-100, 11], attention_mask: [1, 1, 'invalid'],
      token_count: 9, num_tokens: -2,
    });
    expect(summary.tokens.declared).toEqual([{ field: 'token_count', path: { tokens: [{ kind: 'key', value: 'token_count' }] }, value: 9 }]);
    expect(summary.tokens.sequences).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'input_ids', length: 3, inspected: 3, nonInteger: 0 }),
      expect.objectContaining({ field: 'labels', length: 2, negative100: 1 }),
      expect.objectContaining({ field: 'attention_mask', length: 3, nonInteger: 1 }),
    ]));
    expect(summary.issues).toEqual(expect.arrayContaining(['invalid-token-id', 'invalid-declared-count', 'token-count-mismatch', 'token-length-mismatch']));
    expect(summarizeDatasetRecord({ tokens: ['piece', 'another'], token_count: 2 }).issues).not.toContain('invalid-token-id');
  });

  it('observes ShareGPT roles, explicit loss weights and media without training-mask inference', () => {
    const summary = summarizeDatasetRecord({ conversations: [
      { from: 'human', value: 'question', loss_weight: 0 },
      { from: 'gpt', value: 'answer', loss_weight: 1 },
      { from: 'observation', value: 'tool output', loss_weight: [0, 1] },
      { role: 'assistant', content: [{ type: 'image_url', imageUrl: { url: 'file:///never-open' } }], loss_weight: -1 },
      { role: 'unknown-custom', content: 'x', loss_weight: 'invalid' },
      null,
    ] });
    expect(summary).toMatchObject({ scene: 'conversation', target: 'present', media: { image: 1, audio: 0, video: 0 } });
    expect(summary.messages).toMatchObject({ total: 6, observed: 6, roles: { user: 1, assistant: 2, tool: 1, unknown: 1 }, lossWeights: { specified: 5, zero: 1, positive: 1, negative: 1, array: 1, invalid: 1 } });
    expect(summary.issues).toEqual(expect.arrayContaining(['invalid-message', 'unknown-role', 'invalid-loss-weight']));
    expect(summarizeDatasetRecord({ messages: [{ role: 'assistant' }] }).target).toBe('missing');
    expect(summarizeDatasetRecord({ messages: [{ role: 'assistant', content: '' }] }).target).toBe('empty');
  });

  it.each([undefined, null, [], 'not an object'])('retains malformed or scalar records as invalid observations: %j', (value) => {
    expect(summarizeDatasetRecord(value)).toMatchObject({ valid: false, scene: 'unknown', target: 'unknown', issues: ['invalid-record'] });
  });

  it('honors parser failure and avoids recursive traversal of arbitrary body objects', () => {
    expect(summarizeDatasetRecord({ text: 'ignored' }, 'invalid_json').valid).toBe(false);
    const recursive: Record<string, unknown> = {}; recursive.content = recursive;
    expect(summarizeDatasetRecord({ prompt: 'p', response: recursive }).target).toBe('present');
  });

  it('does not inspect messages, content blocks or token values beyond their budgets', () => {
    const blocks: unknown[] = Array.from({ length: DATASET_ANALYSIS_LIMITS.blocks }, () => ({ type: 'text', value: 'x' }));
    Object.defineProperty(blocks, DATASET_ANALYSIS_LIMITS.blocks, { get() { throw new Error('block budget exceeded'); } });
    const messages: unknown[] = Array.from({ length: DATASET_ANALYSIS_LIMITS.messages }, () => ({ role: 'user', content: blocks }));
    Object.defineProperty(messages, DATASET_ANALYSIS_LIMITS.messages, { get() { throw new Error('message budget exceeded'); } });
    const tokens: unknown[] = Array.from({ length: DATASET_ANALYSIS_LIMITS.tokenValues }, () => 1);
    Object.defineProperty(tokens, DATASET_ANALYSIS_LIMITS.tokenValues, { get() { throw new Error('token budget exceeded'); } });
    const summary = summarizeDatasetRecord({ messages, input_ids: tokens });
    expect(summary).toMatchObject({ target: 'unknown', truncated: true, messages: { total: 65, observed: 64, truncated: true } });
    expect(summary.tokens.sequences[0]).toMatchObject({ length: 513, inspected: 512, truncated: true });
    expect(summary.issues).not.toContain('missing-target');
    expect(summary.issues).toContain('inspection-truncated');
  });

  it('uses one shared message budget across preference branches', () => {
    const chosen = Array.from({ length: 64 }, () => ({ role: 'assistant', content: 'chosen' }));
    const rejected: unknown[] = [];
    Object.defineProperty(rejected, 0, { get() { throw new Error('shared budget exceeded'); } });
    const summary = summarizeDatasetRecord({ chosen_messages: chosen, rejected_messages: rejected });
    expect(summary.messages).toMatchObject({ total: 65, observed: 64, truncated: true });
    expect(summary.scene).toBe('preference');
  });

  it('aggregates observed sample distributions without mixing declaration and measurement', () => {
    const records = [
      summarizeDatasetRecord({ text: 'a', input_ids: [1, 2], token_count: 4, label: 'positive' }),
      summarizeDatasetRecord({ text: 'b', input_ids: [3, 4, 5, 6], token_count: 6, label: 'negative' }),
      summarizeDatasetRecord(null),
    ];
    const summary = aggregateDatasetSummaries(records, { scope: 'visible-page', partial: true });
    expect(summary.coverage).toEqual({ requestedRecords: 3, sampledRecords: 3, validRecords: 2, invalidRecords: 1, partial: true });
    expect(summary.scenes).toEqual({ classification: 2, unknown: 1 });
    expect(summary.tokenLengths).toEqual([{ field: 'input_ids', statistics: { count: 2, min: 2, max: 4, mean: 3 } }]);
    expect(summary.declaredTokenCounts).toEqual([{ field: 'token_count', statistics: { count: 2, min: 4, max: 6, mean: 5 } }]);
    expect(summary.categories[0]?.values).toEqual([{ value: 'negative', count: 1 }, { value: 'positive', count: 1 }]);
  });

  it('caps category cardinality and record aggregation while preserving overflow counts', () => {
    const records = Array.from({ length: 256 }, (_, index) => summarizeDatasetRecord({ text: 'body', label: String(index) }));
    Object.defineProperty(records, 256, { get() { throw new Error('record budget exceeded'); } });
    const summary = aggregateDatasetSummaries(records, { scope: 'observed-sample' });
    expect(summary.coverage).toMatchObject({ requestedRecords: 257, sampledRecords: 256, partial: true });
    expect(summary.categories[0]?.values).toHaveLength(32);
    expect(summary.categories[0]?.otherObservations).toBe(224);
    expect(summarizeDatasetRecord({ text: 'body', category: 'x'.repeat(81) })).toMatchObject({ categories: [], truncated: true });
  });

  it('keeps means finite for large safe declared counts and empty samples explicit', () => {
    const records = Array.from({ length: 256 }, () => summarizeDatasetRecord({ text: 'body', token_count: Number.MAX_SAFE_INTEGER }));
    expect(aggregateDatasetSummaries(records, { scope: 'visible-page' }).declaredTokenCounts[0]?.statistics.mean).toBe(Number.MAX_SAFE_INTEGER);
    expect(aggregateDatasetSummaries([], { scope: 'visible-page' }).coverage).toMatchObject({ sampledRecords: 0, validRecords: 0, invalidRecords: 0, partial: false });
  });
});
