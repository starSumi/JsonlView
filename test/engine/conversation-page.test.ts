import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { JsonlFileEngine } from '../../src/engine';
import { MAX_CONVERSATION_CHARACTERS } from '../../src/profiles/conversation-projection';

describe('conversation row page hydration', () => {
  it('retains actual bounded source and invalid records without extra detail hydration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jsonl-conversation-'));
    let engine: JsonlFileEngine | undefined;
    try {
      const file = join(directory, 'source.jsonl');
      await writeFile(file, [JSON.stringify({ message: { role: 'assistant', content: 'Actual ' + 'a'.repeat(3000) } }),
        '{invalid', JSON.stringify({ prompt: 'Dataset prompt', answer: 'Dataset answer' })].join('\n'));
      engine = await JsonlFileEngine.open(file);
      const detail = vi.spyOn(engine, 'getDetail');
      const page = await engine.getRows({ limit: 3, columns: [] });
      expect(page.rows.map((row) => row.ref.ordinal)).toEqual(['0', '1', '2']);
      expect(page.rows[0]?.conversation?.parts[0]).toMatchObject({ role: 'assistant', label: 'Record' });
      expect(page.rows[0]?.conversation?.parts[0]?.text).toHaveLength(MAX_CONVERSATION_CHARACTERS);
      expect(page.rows[0]?.conversation?.truncated).toBe(true);
      expect(page.rows[1]?.ref.parseState).toBe('invalid_json');
      expect(page.rows[1]?.conversation).toEqual({ parts: [], truncated: false });
      expect(page.rows[2]?.conversation?.parts.map((part) => part.text)).toEqual(['Dataset prompt', 'Dataset answer']);
      expect(detail).not.toHaveBeenCalled();
    } finally {
      await engine?.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
