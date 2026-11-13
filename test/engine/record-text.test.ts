import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonlFileEngine } from '../../src/engine';
import * as sourceReads from '../../src/engine/snapshot-fingerprint';

const roots: string[] = [];
const engines: JsonlFileEngine[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(text: string | Buffer) {
  const root = await mkdtemp(join(tmpdir(), 'jsonlview-text-'));
  roots.push(root);
  const path = join(root, 'source.jsonl');
  await writeFile(path, text);
  const engine = await JsonlFileEngine.open(path);
  engines.push(engine);
  const page = await engine.getRows({ limit: 1 });
  return { engine, ref: page.rows[0]!.ref, path };
}

describe('bounded complete record text', () => {
  it('returns original UTF-8 record text without formatting, parsing or delimiter', async () => {
    const { engine, ref } = await fixture('  { "message": "你好" }\r\n{"other":true}\n');
    await expect(engine.getRecordText(ref, 100)).resolves.toEqual({
      sourceGeneration: ref.generation, text: '  { "message": "你好" }', complete: true,
    });
  });
  it('rejects oversized records before attempting a record-sized allocation', async () => {
    const { engine, ref } = await fixture(`{"message":"${'a'.repeat(200)}"}\n`);
    const reads = vi.spyOn(sourceReads, 'readFileHandle');
    await expect(engine.getRecordText(ref, 64)).resolves.toMatchObject({ text: '', complete: false });
    expect(reads).not.toHaveBeenCalled();
  });
  it('rejects forged coordinates, stale identity and unindexed ordinals', async () => {
    const { engine, ref } = await fixture('{"a":1}\n');
    await expect(engine.getRecordText({ ...ref, byteStart: '1' }, 100)).rejects.toMatchObject({ code: 'INVALID_RECORD_REF' });
    await expect(engine.getRecordText({ ...ref, generation: 'old' }, 100)).rejects.toMatchObject({ code: 'STALE_GENERATION' });
    await expect(engine.getRecordText({ ...ref, ordinal: '999999999999' }, 100)).rejects.toMatchObject({ code: 'INVALID_RECORD_REF' });
  });
  it('rejects changed sources and invalid UTF-8 rather than opening replacement characters', async () => {
    const changed = await fixture('{"a":1}\n');
    await writeFile(changed.path, '{"a":2}\n');
    await expect(changed.engine.getRecordText(changed.ref, 100)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    const invalid = await fixture(Buffer.from([0x7b, 0xff, 0x7d, 0x0a]));
    await expect(invalid.engine.getRecordText(invalid.ref, 100)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
  it('rejects budgets above the immutable one MiB cap', async () => {
    const { engine, ref } = await fixture('{}\n');
    await expect(engine.getRecordText(ref, 1_048_577)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
  it('rejects appended snapshots without starting a whole-source fingerprint', async () => {
    const { engine, ref, path } = await fixture('{}\n');
    await appendFile(path, '{}\n');
    const wholeRead = vi.spyOn(sourceReads, 'fingerprintWholeRange');
    await expect(engine.getRecordText(ref, 100)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    expect(wholeRead).not.toHaveBeenCalled();
  });
  it('rejects rewritten boundary bytes even when source metadata observations are unchanged', async () => {
    const { engine, ref, path } = await fixture('{"a":1}\n');
    vi.spyOn(engine, 'validateObservedSource').mockResolvedValue(true);
    await writeFile(path, '{"a":2}\n');
    const wholeRead = vi.spyOn(sourceReads, 'fingerprintWholeRange');
    await expect(engine.getRecordText(ref, 100)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    expect(wholeRead).not.toHaveBeenCalled();
  });
  it('bounds content verification independently of source size', async () => {
    const { engine, ref } = await fixture('{}\n'.repeat(700_000));
    const reads = vi.spyOn(sourceReads, 'readFileHandle');
    const wholeRead = vi.spyOn(sourceReads, 'fingerprintWholeRange');
    await expect(engine.getRecordText(ref, 100)).resolves.toMatchObject({ text: '{}', complete: true });
    expect(wholeRead).not.toHaveBeenCalled();
    const totalRequested = reads.mock.calls.reduce((total, call) => total + call[3], 0);
    expect(totalRequested).toBeLessThanOrEqual(4 * 64 * 1024 + 2);
  });
});
