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
});
