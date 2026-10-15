import { describe, expect, it } from 'vitest';
import { DatasetHeadInspection } from '../../src/profiles/dataset-runtime';
import { isDatasetRuntimeProvenance } from '../../src/shared/transport/dataset-provenance';
import type { RecordRef } from '../../src/shared/types';

function ref(ordinal: string, bytes: string): RecordRef {
  return { generation: 'g1', ordinal, byteStart: '0', byteEndExclusive: bytes, contentByteLength: bytes, delimiterByteLength: 1, parseState: 'valid' };
}

function page(hasAfter = false) {
  return { hasAfter };
}

describe('dataset head runtime provenance', () => {
  it('uses only the first head prefix and marks a 33rd record partial', () => {
    const inspection = new DatasetHeadInspection();
    for (let index = 0; index < 33; index += 1) {
      inspection.accept({ value: { messages: [{ role: 'user', content: 'x' }] }, ref: ref(String(index), '1'), parseState: 'valid' });
    }
    const result = inspection.finish(page(true), true);
    expect(result.status).toBe('partial');
    if (result.status === 'partial') expect(result.coverage).toMatchObject({ sampledRecords: 32, examinedBytes: '32', partial: true, stoppedBy: 'record_limit' });
  });

  it('stops on the exact byte boundary before the oversized next record', () => {
    const inspection = new DatasetHeadInspection();
    inspection.accept({ value: { messages: [{ role: 'user', content: 'x' }] }, ref: ref('0', '262144'), parseState: 'valid' });
    inspection.accept({ value: { messages: [{ role: 'user', content: 'x' }] }, ref: ref('1', '1'), parseState: 'valid' });
    const result = inspection.finish(page(true), true);
    expect(result.status).toBe('partial');
    if (result.status === 'partial') expect(result.coverage).toMatchObject({ sampledRecords: 1, examinedBytes: '262144', stoppedBy: 'byte_limit' });
  });

  it('budgets huge decimal byte lengths safely and exposes invalid rows as fallback', () => {
    const inspection = new DatasetHeadInspection();
    inspection.accept({ value: undefined, ref: ref('0', '999999999999999999999'), parseState: 'oversized' });
    const result = inspection.finish(page(false), true);
    expect(result.status).toBe('fallback');
    if (result.status === 'fallback') expect(result.fallback.code).toBe('invalid_sample');
    expect(result).toMatchObject({ coverage: { sampledRecords: 0, validRecords: 0, invalidRecords: 0, examinedBytes: '0', partial: true, stoppedBy: 'uninspectable_record' } });
    expect(isDatasetRuntimeProvenance(result)).toBe(true);
    const invalid = new DatasetHeadInspection();
    invalid.accept({ value: null, ref: ref('0', '3'), parseState: 'blank' });
    expect(invalid.finish(page(false), true)).toMatchObject({ status: 'fallback', fallback: { code: 'invalid_sample' } });
  });

  it('retains prior coverage but falls back when a later oversized row is encountered', () => {
    const inspection = new DatasetHeadInspection();
    inspection.accept({ value: { messages: [{ role: 'user', content: 'ok' }] }, ref: ref('0', '10'), parseState: 'valid' });
    inspection.accept({ value: undefined, ref: ref('1', '999999999999999999999'), parseState: 'oversized' });
    inspection.accept({ value: { messages: [{ role: 'user', content: 'later' }] }, ref: ref('2', '3'), parseState: 'valid' });
    const result = inspection.finish(page(true), true);
    expect(result).toMatchObject({ status: 'fallback', adapterId: 'generic-jsonl', fallback: { code: 'invalid_sample' }, coverage: { sampledRecords: 1, validRecords: 1, invalidRecords: 0, examinedBytes: '10', partial: true, stoppedBy: 'uninspectable_record' } });
    expect(isDatasetRuntimeProvenance(result)).toBe(true);
  });

  it.each([
    { value: { instruction: 'summarize', input: 'text', output: 'short' } },
    { value: { question: 'What?', context: 'source', answer: 'answer' } },
    { value: { text: 'hello', label: 'positive' } },
  ])('keeps plain dataset shapes on the explicit generic fallback path', ({ value }) => {
    const inspection = new DatasetHeadInspection();
    inspection.accept({ value, ref: ref('0', '32'), parseState: 'valid' });
    const result = inspection.finish(page(false), true);
    expect(result).toMatchObject({ status: 'fallback', fallback: { code: 'unknown_shape' }, adapterId: 'generic-jsonl', shape: 'unknown' });
  });
});
