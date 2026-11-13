import { describe, expect, it } from 'vitest';
import {
  GENERIC_DATASET_ADAPTER_ID,
  LLAMA_FACTORY_V1_ADAPTER_ID,
  LLAMA_FACTORY_V1_ADAPTER_VERSION,
  SHAREGPT_V1_ADAPTER_ID,
  SFT_MASTER_CONVERSATION_V1_ADAPTER_ID,
  SFT_MASTER_KEYWORD_RESULT_V1_ADAPTER_ID,
  VIRTUALHOME_V1_ADAPTER_ID,
  LlamaFactoryV1DatasetAdapter,
  inspectLlamaFactoryDataset,
  type DatasetRecordSample,
} from '../../src/profiles';

const sft = {
  messages: [
    { role: 'system', content: 'synthetic system', loss_weight: 0 },
    { role: 'user', content: 'synthetic prompt' },
    { role: 'assistant', content: 'synthetic answer', loss_weight: 1 },
  ],
  metadata: { dataset_id: 'redacted-v1' },
};

const preference = {
  chosen_messages: [
    { role: 'user', content: 'synthetic prompt' },
    { role: 'assistant', content: 'synthetic chosen' },
  ],
  rejected_messages: [
    { role: 'user', content: 'synthetic prompt' },
    { role: 'assistant', content: 'synthetic rejected' },
  ],
};

const toolUse = {
  messages: [
    { role: 'user', content: 'synthetic request' },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'synthetic call' }],
      tool_calls: [{ id: 'call-redacted', function: { name: 'synthetic_tool', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'call-redacted', content: 'synthetic result' },
  ],
  tools: [{ type: 'function', function: { name: 'synthetic_tool' } }],
};

const multimodal = {
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'synthetic caption' },
        { type: 'image_url', image_url: { url: 'https://redacted.invalid/image' } },
      ],
    },
    { role: 'assistant', content: 'synthetic answer' },
  ],
};

function samples(values: readonly unknown[]): DatasetRecordSample[] {
  return values.map((value, index) => ({ value, ordinal: String(index + 1), parseState: 'valid' }));
}

const messageContainers = ['messages', 'chosen_messages', 'rejected_messages'] as const;

function rowWithMessages(container: (typeof messageContainers)[number], messages: readonly unknown[]): Record<string, unknown> {
  return container === 'messages' ? { messages } : { ...preference, [container]: messages };
}

describe('LLaMA-Factory v1 dataset adapter', () => {
  it('recognizes sft-master conversation rows with a strategy-owned projection', () => {
    const row = {
      conversation_id: 1,
      category: 'dialogue',
      conversation: [{ human: '请提取关键词。', assistant: '关键词一;关键词二' }],
      dataset: 'psychology',
    };
    const result = inspectLlamaFactoryDataset(samples([row]));

    expect(result.detection).toMatchObject({ selectedAdapterId: SFT_MASTER_CONVERSATION_V1_ADAPTER_ID, shape: 'sft-master-conversation', confidence: 'high' });
    expect(result.records[0]?.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'conversation', count: 1 }),
      expect.objectContaining({ field: 'conversation_id', count: 1 }),
      expect.objectContaining({ field: 'dataset', count: 1 }),
    ]));
    expect(result.records[0]?.raw).toBe(row);
  });

  it('recognizes sft-master keyword result rows without conflating them with conversations', () => {
    const row = { input: '抽取关键词。', predict: '关键词一;关键词二', target: '关键词一;关键词二;关键词三' };
    const result = inspectLlamaFactoryDataset(samples([row]));

    expect(result.detection).toMatchObject({ selectedAdapterId: SFT_MASTER_KEYWORD_RESULT_V1_ADAPTER_ID, shape: 'keyword-result', confidence: 'high' });
    expect(result.records[0]?.fields).toEqual([
      expect.objectContaining({ field: 'input', count: 1 }),
      expect.objectContaining({ field: 'predict', count: 1 }),
      expect.objectContaining({ field: 'target', count: 1 }),
    ]);
  });

  it('fails closed when a recognized sft-master family has malformed required fields', () => {
    const result = inspectLlamaFactoryDataset(samples([{ input: 'x', predict: ['wrong'], target: 'z' }]));

    expect(result.detection).toMatchObject({ selectedAdapterId: GENERIC_DATASET_ADAPTER_ID, shape: 'unknown', fallback: { visible: true, code: 'unknown_shape' } });
    expect(result.detection.reasons).toContainEqual(expect.objectContaining({ code: 'missing_required_field' }));
  });

  it('recognizes one-object-per-line ShareGPT conversations without flattening the row', () => {
    const row = {
      conversations: [
        { from: 'human', value: 'Find the book.' },
        { from: 'gpt', value: 'I will search.' },
      ],
      system: 'You are a household agent.',
    };
    const result = inspectLlamaFactoryDataset(samples([row]));

    expect(result.detection).toMatchObject({ selectedAdapterId: SHAREGPT_V1_ADAPTER_ID, shape: 'sharegpt', confidence: 'high' });
    expect(result.records[0]).toMatchObject({ physicalOrdinal: '1', rawPreserved: true, raw: row, shape: 'sharegpt' });
    expect(result.records[0]?.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'conversations', count: 2 }),
      expect.objectContaining({ field: 'system', count: 1 }),
    ]));
  });

  it('recognizes bounded VirtualHome task rows and projects evaluation fields', () => {
    const row = {
      task: 'Find dictionary', description: 'Move towards the bookshelf.',
      action_list: ['Walk to bookshelf', 'Scan bookshelf'],
      SuccessOrFail: [true, false], FailReasons: ['', 'Not found'],
      revised_graph: { nodes: [] }, object_id_dict: { bookshelf: 319 },
    };
    const result = inspectLlamaFactoryDataset(samples([row]));

    expect(result.detection).toMatchObject({ selectedAdapterId: VIRTUALHOME_V1_ADAPTER_ID, shape: 'virtualhome', confidence: 'high' });
    expect(result.records[0]?.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'task', count: 1 }),
      expect.objectContaining({ field: 'action_list', count: 2 }),
      expect.objectContaining({ field: 'FailReasons', count: 2 }),
    ]));
    expect(result.records[0]?.raw).toBe(row);
  });

  it('does not reinterpret a top-level JSON array as a dataset framing', () => {
    const result = inspectLlamaFactoryDataset(samples([[{ conversations: [{ from: 'human', value: 'x' }] }]]));

    expect(result.detection).toMatchObject({ selectedAdapterId: GENERIC_DATASET_ADAPTER_ID, shape: 'unknown' });
    expect(result.detection.fallback).toMatchObject({ code: 'unsupported_framing', visible: true });
    expect(result.provenance.fallback?.message).toContain('one object per physical line');
  });

  it('selects SFT/messages with bounded provenance and preserves the physical row', () => {
    const result = inspectLlamaFactoryDataset(samples([sft]), {
      source: { fingerprint: 'sha256:redacted', generation: 'generation-7' },
    });

    expect(result.detection).toMatchObject({
      selectedAdapterId: LLAMA_FACTORY_V1_ADAPTER_ID,
      selectedAdapterVersion: LLAMA_FACTORY_V1_ADAPTER_VERSION,
      shape: 'sft',
      confidence: 'high',
    });
    expect(result.provenance).toMatchObject({
      adapterId: LLAMA_FACTORY_V1_ADAPTER_ID,
      adapterVersion: LLAMA_FACTORY_V1_ADAPTER_VERSION,
      framing: 'jsonl',
      clockBasis: 'record-order',
      sourceFingerprint: 'sha256:redacted',
      generation: 'generation-7',
    });
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({ physicalOrdinal: '1', shape: 'sft', rawPreserved: true, raw: sft });
    expect(result.records[0]?.fields).toEqual([expect.objectContaining({ field: 'messages', count: 3 })]);
  });

  it('keeps DPO branches grouped under one physical record', () => {
    const result = inspectLlamaFactoryDataset(samples([preference]));

    expect(result.detection.shape).toBe('preference');
    expect(result.records[0]?.fields).toEqual([
      expect.objectContaining({ field: 'chosen_messages', count: 2 }),
      expect.objectContaining({ field: 'rejected_messages', count: 2 }),
    ]);
    expect(result.records[0]?.physicalOrdinal).toBe('1');
  });

  it('distinguishes tool-use and multimodal content without fetching references', () => {
    const tool = inspectLlamaFactoryDataset(samples([toolUse]));
    const media = inspectLlamaFactoryDataset(samples([multimodal]));

    expect(tool.detection.shape).toBe('tool-use');
    expect(tool.records[0]?.fields).toEqual([
      expect.objectContaining({ field: 'messages', count: 3 }),
      expect.objectContaining({ field: 'tool_calls', count: 2 }),
    ]);
    expect(media.detection.shape).toBe('multimodal');
    expect(media.records[0]?.fields).toEqual([
      expect.objectContaining({ field: 'messages', count: 2 }),
      expect.objectContaining({ field: 'media_references', count: 1 }),
    ]);
  });

  it('returns a visible Generic fallback for unknown rows and keeps raw detail available', () => {
    const unknown = { unknown_shape: { redacted: true }, text: 'synthetic unknown' };
    const result = inspectLlamaFactoryDataset(samples([unknown]));

    expect(result.detection).toMatchObject({
      selectedAdapterId: GENERIC_DATASET_ADAPTER_ID,
      shape: 'unknown',
      confidence: 'none',
      fallback: expect.objectContaining({ visible: true, code: 'unknown_shape', fallbackAdapterId: GENERIC_DATASET_ADAPTER_ID }),
    });
    expect(result.provenance.fallback?.message).toContain('Generic JSONL fallback');
    expect(result.records[0]).toMatchObject({ shape: 'unknown', rawPreserved: true, raw: unknown });
  });

  it.each(messageContainers)('keeps unknown content blocks in %s visible through Generic fallback', (container) => {
    const row = rowWithMessages(container, [{ role: 'user', content: [{ type: 'future_block', value: 'redacted' }] }]);
    const result = inspectLlamaFactoryDataset(samples([row]));

    expect(result.detection.fallback).toMatchObject({ visible: true, code: 'unknown_shape' });
    expect(result.detection.reasons).toContainEqual(expect.objectContaining({
      path: { tokens: [{ kind: 'key', value: container }] },
      code: 'unknown',
    }));
    expect(result.detection.confidence).toBe('none');
    expect(result.records[0]?.raw).toBe(row);
  });

  it.each(messageContainers)('falls back when %s has a 33rd content block beyond the inspection limit', (container) => {
    const content = [
      ...Array.from({ length: 32 }, () => ({ type: 'text', text: 'synthetic block' })),
      { type: 'future_block', value: 'redacted' },
    ];
    const row = rowWithMessages(container, [{ role: 'user', content }]);
    const result = inspectLlamaFactoryDataset(samples([row]));

    expect(result.detection).toMatchObject({
      selectedAdapterId: GENERIC_DATASET_ADAPTER_ID,
      confidence: 'none',
      fallback: { visible: true, code: 'unknown_shape' },
    });
    expect(result.detection.reasons).toContainEqual(expect.objectContaining({ observation: expect.stringContaining('32-block inspection limit') }));
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({ physicalOrdinal: '1', shape: 'unknown', rawPreserved: true, fields: [] });
    expect(result.records[0]?.raw).toBe(row);
  });

  it.each(messageContainers)('falls back when %s has a 65th message beyond the inspection limit', (container) => {
    const messages = [
      ...Array.from({ length: 64 }, () => ({ role: 'user', content: 'synthetic message' })),
      { role: 'user', content: [{ type: 'future_block', value: 'redacted' }] },
    ];
    const row = rowWithMessages(container, messages);
    const result = inspectLlamaFactoryDataset(samples([row]));

    expect(result.detection).toMatchObject({
      selectedAdapterId: GENERIC_DATASET_ADAPTER_ID,
      confidence: 'none',
      fallback: { visible: true, code: 'unknown_shape' },
    });
    expect(result.detection.reasons).toContainEqual(expect.objectContaining({ observation: expect.stringContaining('64-message inspection limit') }));
    expect(result.records[0]?.raw).toBe(row);
  });

  it.each(messageContainers)('accepts %s at the nested inspection limits', (container) => {
    const row = rowWithMessages(container, [
      { role: 'user', content: Array.from({ length: 32 }, () => ({ type: 'text', text: 'synthetic block' })) },
      ...Array.from({ length: 63 }, () => ({ role: 'assistant', content: 'synthetic message' })),
    ]);
    const result = inspectLlamaFactoryDataset(samples([row]));

    expect(result.detection).toMatchObject({
      selectedAdapterId: LLAMA_FACTORY_V1_ADAPTER_ID,
      shape: container === 'messages' ? 'sft' : 'preference',
      confidence: 'high',
    });
    expect(result.detection.fallback).toBeUndefined();
  });

  it('checks all message containers before choosing preference semantics', () => {
    const row = {
      ...preference,
      messages: [{ role: 'user', content: [{ type: 'future_block', value: 'redacted' }] }],
    };
    const result = inspectLlamaFactoryDataset(samples([row]));

    expect(result.detection.fallback).toMatchObject({ visible: true, code: 'unknown_shape' });
    expect(result.records[0]?.raw).toBe(row);
  });

  it('keeps mixed known and unknown preference records in physical order through Generic fallback', () => {
    const unknown = rowWithMessages('rejected_messages', [{ role: 'assistant', content: [{ type: 'future_block' }] }]);
    const result = inspectLlamaFactoryDataset(samples([sft, unknown]));

    expect(result.detection.fallback).toMatchObject({ visible: true, code: 'unknown_shape' });
    expect(result.records.map((record) => [record.physicalOrdinal, record.shape])).toEqual([['1', 'unknown'], ['2', 'unknown']]);
    expect(result.records[0]?.raw).toBe(sft);
    expect(result.records[1]?.raw).toBe(unknown);
  });

  it('stops nested inspection without accessing messages or content blocks beyond the limits', () => {
    for (const container of messageContainers) {
      for (const limit of ['messages', 'blocks']) {
        const entries: unknown[] = Array.from({ length: limit === 'messages' ? 65 : 33 });
        Object.defineProperty(entries, entries.length - 1, { get: () => { throw new Error('Nested inspection exceeded its limit.'); } });
        const row = rowWithMessages(container, limit === 'messages' ? entries : [{ role: 'user', content: entries }]);
        const result = inspectLlamaFactoryDataset([{ value: row, byteLength: 1, ordinal: '7' }]);

        expect(result.detection.fallback).toMatchObject({ visible: true, code: 'unknown_shape' });
        expect(result.records[0]?.physicalOrdinal).toBe('7');
        expect(result.records[0]?.raw).toBe(row);
      }
    }
  });

  it('reports a missing preference branch as a bounded diagnostic', () => {
    const result = inspectLlamaFactoryDataset(samples([{ chosen_messages: [{ role: 'assistant', content: 'redacted' }] }]));

    expect(result.detection.fallback).toMatchObject({ visible: true, code: 'unknown_shape' });
    expect(result.detection.reasons).toContainEqual(expect.objectContaining({ code: 'missing_required_field' }));
  });

  it('fails closed on conflicting shapes instead of silently choosing a profile', () => {
    const conflict = {
      messages: [{ role: 'assistant', content: [{ type: 'image_url', image_url: { url: 'redacted' } }], tool_calls: [{ id: 'call-redacted' }] }],
    };
    const result = inspectLlamaFactoryDataset(samples([sft, conflict]));

    expect(result.detection.selectedAdapterId).toBe(GENERIC_DATASET_ADAPTER_ID);
    expect(result.detection.fallback).toMatchObject({ visible: true, code: 'conflicting_shapes' });
    expect(result.records).toHaveLength(2);
    expect(result.records.every((record) => record.shape === 'unknown')).toBe(true);
  });

  it('counts malformed physical samples and exposes bounded truncation', () => {
    const adapter = new LlamaFactoryV1DatasetAdapter();
    const result = adapter.inspect([
      ...samples([sft, sft, sft]),
      { value: undefined, ordinal: '4', parseState: 'invalid_json' },
    ], { samplePlan: { maxRecords: 2 }, source: { generation: 'generation-8' } });

    expect(result.provenance.coverage).toMatchObject({
      requestedRecords: 4,
      sampledRecords: 2,
      validRecords: 2,
      invalidRecords: 0,
      truncated: true,
      truncatedReason: 'record_limit',
    });
    expect(result.provenance.confidence).toBe('medium');
    expect(result.provenance.generation).toBe('generation-8');
  });

  it('does not admit a first row that exceeds the byte sample budget', () => {
    const result = inspectLlamaFactoryDataset(samples([sft]), { samplePlan: { maxBytes: 8 } });

    expect(result.provenance.coverage).toMatchObject({ sampledRecords: 0, examinedBytes: '0', truncated: true, truncatedReason: 'byte_limit' });
    expect(result.detection.fallback).toMatchObject({ visible: true, code: 'unknown_shape' });
  });

  it.each(['record_limit', 'byte_limit'] as const)('does not inspect rows excluded by the %s budget', (truncatedReason) => {
    const excluded: DatasetRecordSample = {
      byteLength: 2,
      get value() { throw new Error('An excluded row was inspected.'); },
    };
    const result = inspectLlamaFactoryDataset([
      { value: sft, byteLength: 1, ordinal: '4' },
      excluded,
    ], { samplePlan: truncatedReason === 'record_limit' ? { maxRecords: 1 } : { maxBytes: 1 } });

    expect(result.provenance.coverage).toMatchObject({
      sampledRecords: 1,
      examinedBytes: '1',
      truncated: true,
      truncatedReason,
    });
    expect(result.detection).toMatchObject({ shape: 'sft', confidence: 'medium' });
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.physicalOrdinal).toBe('4');
    expect(result.records[0]?.raw).toBe(sft);
  });

  it('does not treat a tools declaration alone as tool-use evidence', () => {
    const result = inspectLlamaFactoryDataset(samples([{
      messages: [{ role: 'user', content: 'synthetic request' }, { role: 'assistant', content: 'synthetic answer' }],
      tools: [{ type: 'function', function: { name: 'declared_only' } }],
    }]));

    expect(result.detection.shape).toBe('sft');
  });
});
