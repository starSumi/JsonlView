import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JsonlFileEngine } from '../../src/engine';

describe('BFCL row projection', () => {
  it('attaches bounded BFCL insights through the existing dataset projection', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jsonl-bfcl-page-'));
    let engine: JsonlFileEngine | undefined;
    try {
      const row = {
        id: 'simple_1', multi_turn: false, functions: '[{"name":"f"}]', tools: '[]',
        missed_functions: '{}', initial_config: '{}', involved_classes: [], turns: '[]',
        language: 'Python', test_category: 'simple', subset: 'simple', ground_truth: '[]',
      };
      await writeFile(join(directory, 'bfcl.jsonl'), JSON.stringify(row));
      engine = await JsonlFileEngine.open(join(directory, 'bfcl.jsonl'));
      const page = await engine.getRows({ limit: 1, columns: [], projection: { conversation: false, dataset: true } });
      expect(page.rows[0]?.datasetInsights?.bfclV3).toMatchObject({ adapterId: 'bfcl-v3', recognized: true, valid: true });
      expect(page.rows[0]?.datasetInsights?.bfclV3).not.toHaveProperty('id');
      expect(page.rows[0]?.ref.ordinal).toBe('0');
    } finally {
      await engine?.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps generic rows on the existing dataset path without a BFCL extension', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jsonl-generic-page-'));
    let engine: JsonlFileEngine | undefined;
    try {
      await writeFile(join(directory, 'generic.jsonl'), JSON.stringify({ question: 'q', answer: 'a' }));
      engine = await JsonlFileEngine.open(join(directory, 'generic.jsonl'));
      const page = await engine.getRows({ limit: 1, columns: [], projection: { conversation: false, dataset: true } });
      expect(page.rows[0]?.dataset?.scene).toBe('qa');
      expect(page.rows[0]?.datasetInsights).toBeUndefined();
    } finally {
      await engine?.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ['multi-turn tool calls', { id: 'sample-1', multi_turn: false, functions: '[]', tools: '[]', turns: '[]', ground_truth: '{}', language: 'Python' }],
    ['a generic subset label', { id: 'sample-2', functions: '[]', tools: '[]', turns: '[]', ground_truth: '{}', language: 'Python', subset: 'train' }],
    ['a training split id that matches subset', { id: 'train_1', functions: '[]', tools: '[]', turns: '[]', ground_truth: '{}', language: 'Python', subset: 'train' }],
    ['one BFCL category field', { id: 'sample-3', functions: '[]', tools: '[]', turns: '[]', ground_truth: '{}', language: 'Python', test_category: 'evaluation' }],
  ] as const)('keeps generic dataset rows with %s out of BFCL insights', async (_description, value) => {
    const directory = await mkdtemp(join(tmpdir(), 'jsonl-bfcl-collision-'));
    let engine: JsonlFileEngine | undefined;
    try {
      await writeFile(join(directory, 'generic.jsonl'), JSON.stringify(value));
      engine = await JsonlFileEngine.open(join(directory, 'generic.jsonl'));
      const page = await engine.getRows({ limit: 1, columns: [], projection: { conversation: false, dataset: true } });
      expect(page.rows[0]?.datasetInsights).toBeUndefined();
      expect(page.rows[0]?.dataset).toBeDefined();
    } finally {
      await engine?.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not compute dataset-owned insights when the dataset projection is disabled', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jsonl-bfcl-no-projection-'));
    let engine: JsonlFileEngine | undefined;
    try {
      const row = { id: 'simple_1', multi_turn: false, functions: '[]', tools: '[]', turns: '[]', language: 'Python', test_category: 'simple', subset: 'simple', ground_truth: '{}' };
      await writeFile(join(directory, 'bfcl.jsonl'), JSON.stringify(row));
      engine = await JsonlFileEngine.open(join(directory, 'bfcl.jsonl'));
      const page = await engine.getRows({ limit: 1, columns: [], projection: { conversation: false, dataset: false } });
      expect(page.rows[0]?.dataset).toBeUndefined();
      expect(page.rows[0]?.datasetInsights).toBeUndefined();
    } finally {
      await engine?.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
