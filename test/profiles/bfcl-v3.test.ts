import { describe, expect, it } from 'vitest';
import { aggregateBfclV3Summaries, isBfclV3Candidate, summarizeBfclV3Record } from '../../src/profiles/datasets/bfcl-v3';

const row = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'multiple_1', multi_turn: true,
  functions: JSON.stringify([{ name: 'find_item', parameters: { type: 'object', required: ['id'] } }]),
  tools: JSON.stringify([{ type: 'function', function: { name: 'find_item', parameters: { type: 'object', required: ['id'] } } }]),
  missed_functions: JSON.stringify({ '2': [[{ name: 'missing', parameters: {} }]] }),
  initial_config: JSON.stringify({ Service: { token: 'do-not-retain' } }),
  involved_classes: ['Service'],
  turns: JSON.stringify([[{ role: 'system', content: 'private prompt' }, { role: 'user', content: 'private request' }], [{ role: 'assistant', content: 'private call' }]]),
  language: 'Python', test_category: 'multiple', subset: 'multiple',
  ground_truth: JSON.stringify([["find_item(id='secret')"]]),
  ...overrides,
});

describe('BFCL v3 bounded adapter', () => {
  it('recognizes the pinned stringified JSON shape and retains only structural counts', () => {
    expect(isBfclV3Candidate(row())).toBe(true);
    const result = summarizeBfclV3Record(row());
    expect(result).toMatchObject({ recognized: true, valid: true, multiTurn: 'true', categories: { language: 'Python', testCategory: 'multiple', subset: 'multiple' } });
    expect(result.functions).toMatchObject({ state: 'valid', definitions: 1, validDefinitions: 1, parameterObjects: 1, requiredParameters: 1 });
    expect(result.tools).toMatchObject({ state: 'valid', definitions: 1, validDefinitions: 1 });
    expect(result.turns).toMatchObject({ state: 'valid', turns: 2, messages: 3, roles: { system: 1, user: 1, assistant: 1 } });
    expect(result.missedFunctions).toMatchObject({ state: 'valid', groups: 1, calls: 1 });
    expect(result.groundTruth).toMatchObject({ state: 'valid', groups: 1, calls: 1 });
    expect(result.initialConfig).toMatchObject({ state: 'valid', keys: 1 });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('accepts native involved_classes arrays and fails closed on malformed fields', () => {
    const result = summarizeBfclV3Record(row({ functions: '{bad', tools: 4, turns: JSON.stringify([{ role: 'wrong' }]), involved_classes: ['A', 4] }));
    expect(result.recognized).toBe(true);
    expect(result.valid).toBe(false);
    expect(result.functions.state).toBe('malformed');
    expect(result.tools.state).toBe('type-mismatch');
    expect(result.turns).toMatchObject({ state: 'valid', invalidTurns: 1 });
    expect(result.involvedClasses).toMatchObject({ state: 'valid', values: 1, distinctValues: 1 });
    expect(result.issues).toEqual(expect.arrayContaining(['malformed-json', 'type-mismatch']));
  });

  it('marks oversized JSON as bounded instead of parsing it into the DTO', () => {
    const result = summarizeBfclV3Record(row({ functions: JSON.stringify(['x'.repeat(70_000)]) }));
    expect(result.functions.state).toBe('over-budget');
    expect(result.truncated).toBe(true);
    expect(result.issues).toContain('over-budget');
  });

  it('accepts official object-shaped ground truth and observes missing required fields', () => {
    const objectGroundTruth = summarizeBfclV3Record(row({ ground_truth: '{}' }));
    expect(objectGroundTruth).toMatchObject({ valid: true, groundTruth: { state: 'empty' } });

    const missingFunctions = { ...row() };
    delete missingFunctions.functions;
    const result = summarizeBfclV3Record(missingFunctions);
    expect(isBfclV3Candidate(missingFunctions)).toBe(true);
    expect(result.valid).toBe(false);
    expect(result.issues).toContain('missing-field');
    expect(result.functions.state).toBe('missing');
  });

  it.each(['id', 'multi_turn'] as const)('recognizes BFCL rows with missing required %s so the defect is visible', (field) => {
    const missing = { ...row() };
    delete missing[field];
    const result = summarizeBfclV3Record(missing);
    expect(result.recognized).toBe(true);
    expect(result.valid).toBe(false);
    expect(result.issues).toContain('missing-field');
  });

  it('does not classify generic rows that only share turns and ground truth', () => {
    const generic = { id: 'sample-1', multi_turn: false, turns: '[]', ground_truth: '{}', language: 'Python' };
    expect(isBfclV3Candidate(generic)).toBe(false);
    expect(summarizeBfclV3Record(generic)).toMatchObject({ recognized: false, issues: ['not-bfcl'] });
  });

  it('bounds native involved classes before counting values', () => {
    const result = summarizeBfclV3Record(row({ involved_classes: Array.from({ length: 300 }, (_, index) => `class-${index}`) }));
    expect(result.involvedClasses).toMatchObject({ state: 'over-budget', values: 256, distinctValues: 256 });
    expect(result.valid).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.issues).toContain('over-budget');
  });

  it('aggregates partial samples with distributions and issue counts', () => {
    const first = summarizeBfclV3Record(row());
    const second = summarizeBfclV3Record(row({ multi_turn: false, language: 'Java', test_category: 'simple', subset: 'simple' }));
    const summary = aggregateBfclV3Summaries([first, second], { partial: true });
    expect(summary.coverage).toMatchObject({ requestedRecords: 2, sampledRecords: 2, recognizedRecords: 2, validRecords: 2, partial: true });
    expect(summary.multiTurn).toEqual({ true: 1, false: 1, missing: 0, invalid: 0 });
    expect(summary.functions).toMatchObject({ records: 2, definitions: 2, validDefinitions: 2 });
    expect(summary.distributions).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'language', values: expect.arrayContaining([{ value: 'Java', count: 1 }, { value: 'Python', count: 1 }]) }),
    ]));
  });

  it('accounts for category values beyond the bounded distribution window', () => {
    const records = Array.from({ length: 40 }, (_, index) => summarizeBfclV3Record(row({ language: `lang-${String(index)}` })));
    const summary = aggregateBfclV3Summaries(records);
    expect(summary.distributions.find((item) => item.field === 'language')?.otherObservations).toBe(8);
  });

  it('propagates record truncation into partial coverage', () => {
    const record = summarizeBfclV3Record(row({ functions: JSON.stringify(['x'.repeat(70_000)]) }));
    const summary = aggregateBfclV3Summaries([record]);
    expect(summary.coverage.partial).toBe(true);
    expect(summary.truncated).toBe(true);
  });
});
