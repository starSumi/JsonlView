import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { JsonlFileEngine } from '../../src/engine';

describe('dataset page projection', () => {
  it('attaches observations without extra detail reads or changing physical records', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jsonl-dataset-page-'));
    let engine: JsonlFileEngine | undefined;
    try {
      const file = join(directory, 'source.jsonl');
      const source = [JSON.stringify({ prompt: 'Question', response: 'Answer' }), '{invalid',
        JSON.stringify({ input_ids: [1, 2, 3], token_count: 9 })].join('\n');
      await writeFile(file, source);
      engine = await JsonlFileEngine.open(file);
      const detail = vi.spyOn(engine, 'getDetail');
      const page = await engine.getRows({ limit: 3, columns: [] });
      expect(page.rows.map((row) => row.ref.ordinal)).toEqual(['0', '1', '2']);
      expect(page.rows.map((row) => row.dataset?.scene)).toEqual(['instruction', 'unknown', 'tokenized']);
      expect(page.rows[1]?.dataset).toMatchObject({ valid: false, issues: ['invalid-record'] });
      expect(page.rows[2]?.dataset?.tokens).toMatchObject({ mismatch: true, sequences: [{ length: 3 }], declared: [{ value: 9 }] });
      expect(detail).not.toHaveBeenCalled();
      const provider = await engine.getRows({ limit: 3, columns: [], enricher: { profileId: 'kimi', project: () => undefined } });
      expect(provider.rows.map((row) => row.ref)).toEqual(page.rows.map((row) => row.ref));
      expect(provider.rows.every((row) => row.dataset === undefined)).toBe(true);
      const generic = await engine.getRows({ limit: 3, columns: [], enricher: { profileId: 'generic', project: () => undefined } });
      expect(generic.rows.map((row) => row.dataset)).toEqual(page.rows.map((row) => row.dataset));
      expect(await readFile(file, 'utf8')).toBe(source);
    } finally {
      await engine?.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps legacy projection defaults while allowing a page to omit unused scenes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jsonl-dataset-policy-'));
    let engine: JsonlFileEngine | undefined;
    try {
      const file = join(directory, 'source.jsonl');
      await writeFile(file, JSON.stringify({ prompt: 'Question', response: 'Answer' }));
      engine = await JsonlFileEngine.open(file);

      const legacy = await engine.getRows({ limit: 1, columns: [] });
      const compact = await engine.getRows({
        limit: 1,
        columns: [],
        projection: { conversation: false, dataset: false },
      });

      expect(legacy.rows[0]?.conversation).toBeDefined();
      expect(legacy.rows[0]?.dataset).toBeDefined();
      expect(compact.rows[0]).toMatchObject({
        ref: legacy.rows[0]?.ref,
        cells: [],
        genericSummary: legacy.rows[0]?.genericSummary,
      });
      expect(compact.rows[0]).not.toHaveProperty('conversation');
      expect(compact.rows[0]).not.toHaveProperty('dataset');
      expect(compact.projection).toEqual({ conversation: false, dataset: false });
      expect(compact.anchorOrdinal).toBe(legacy.anchorOrdinal);
      expect(compact.hasAfter).toBe(legacy.hasAfter);
    } finally {
      await engine?.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('inspects bounded page metadata without constructing display rows', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jsonl-inspection-page-'));
    let engine: JsonlFileEngine | undefined;
    try {
      const file = join(directory, 'source.jsonl');
      await writeFile(file, [JSON.stringify({ prompt: 'first' }), JSON.stringify({ prompt: 'second' })].join('\n'));
      engine = await JsonlFileEngine.open(file);
      const hydrated: string[] = [];
      const projectRow = vi.fn(Reflect.get(engine, 'projectRow') as (...args: unknown[]) => unknown);
      Reflect.set(engine, 'projectRow', projectRow);

      const inspected = await engine.inspectRows({
        limit: 1,
        onHydrated: ({ ref }) => hydrated.push(ref.ordinal),
      });
      expect(hydrated).toEqual(['0', '1']);
      expect(projectRow).not.toHaveBeenCalled();
      expect(inspected).not.toHaveProperty('rows');
      expect(inspected).not.toHaveProperty('columns');
      const visible = await engine.getRows({ limit: 1, columns: [] });

      expect(inspected).toEqual({
        anchorOrdinal: visible.anchorOrdinal,
        hasBefore: visible.hasBefore,
        hasAfter: visible.hasAfter,
        indexedRecords: visible.indexedRecords,
        totalRecords: visible.totalRecords,
      });
    } finally {
      await engine?.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('preserves backward cursors and scan truncation in inspection metadata', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jsonl-inspection-cursors-'));
    let engine: JsonlFileEngine | undefined;
    try {
      const file = join(directory, 'source.jsonl');
      await writeFile(file, Array.from({ length: 5 }, (_, index) => JSON.stringify({ index })).join('\n'));
      engine = await JsonlFileEngine.open(file);

      const backwardSamples: string[] = [];
      const backward = await engine.inspectRows({
        direction: 'backward', limit: 2,
        onHydrated: ({ ref }) => backwardSamples.push(ref.ordinal),
      });
      const visibleBackward = await engine.getRows({ direction: 'backward', limit: 2, columns: [] });
      expect(backward.anchorOrdinal).toBe(visibleBackward.anchorOrdinal);
      expect(backward.hasBefore).toBe(visibleBackward.hasBefore);
      expect(backward.hasAfter).toBe(visibleBackward.hasAfter);
      expect(backwardSamples).toEqual(['4', '3', '2']);

      const truncatedSamples: string[] = [];
      const truncated = await engine.inspectRows({
        limit: 3,
        scanBudget: { maxExaminedRecords: 2 },
        onHydrated: ({ ref }) => truncatedSamples.push(ref.ordinal),
      });
      expect(truncated.scan).toMatchObject({ examinedRecords: '2', cursorOrdinal: '1', truncatedReason: 'record_limit' });
      expect(truncatedSamples).toEqual(['0', '1']);
    } finally {
      await engine?.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
