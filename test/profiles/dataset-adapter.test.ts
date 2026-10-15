import { describe, expect, it } from 'vitest';
import {
  GENERIC_DATASET_ADAPTER_ID,
  LLAMA_FACTORY_V1_ADAPTER_ID,
  LLAMA_FACTORY_V1_ADAPTER_VERSION,
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

describe('LLaMA-Factory v1 dataset adapter', () => {
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

  it('keeps unknown content blocks visible through Generic fallback', () => {
    const result = inspectLlamaFactoryDataset(samples([{
      messages: [{ role: 'user', content: [{ type: 'future_block', value: 'redacted' }] }],
    }]));

    expect(result.detection.fallback).toMatchObject({ visible: true, code: 'unknown_shape' });
    expect(result.detection.reasons).toContainEqual(expect.objectContaining({ code: 'unknown' }));
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

  it('does not treat a tools declaration alone as tool-use evidence', () => {
    const result = inspectLlamaFactoryDataset(samples([{
      messages: [{ role: 'user', content: 'synthetic request' }, { role: 'assistant', content: 'synthetic answer' }],
      tools: [{ type: 'function', function: { name: 'declared_only' } }],
    }]));

    expect(result.detection.shape).toBe('sft');
  });
});
