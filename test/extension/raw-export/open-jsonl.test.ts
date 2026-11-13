import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SnapshotIdentity } from '../../../src/shared/types';
import { exportOpenRawJsonl, type OpenRawJsonlSource } from '../../../src/extension/raw-export/open-jsonl';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'jsonlview-open-export-'));
  roots.push(root);
  const sourcePath = join(root, 'source.jsonl');
  const destination = join(root, 'export.jsonl');
  const raw = '{"all":1}\r\ninvalid\n{"all":2}';
  await writeFile(sourcePath, raw);
  let identity: SnapshotIdentity | undefined = {
    documentId: 'open-doc', generation: 'gen-1', epoch: 2,
    uri: sourcePath, scheme: 'file', sizeBytes: String(Buffer.byteLength(raw)),
    mtimeMs: 1, prefixFingerprint: 'prefix', observedAt: '2026-11-06T00:00:00Z',
  };
  const source: OpenRawJsonlSource = { sourcePath, currentIdentity: () => identity, isUnchanged: async () => true };
  return { source, destination, raw, retire: () => { identity = undefined; },
    replace: () => { identity = { ...identity!, generation: 'gen-2' }; } };
}

describe('open-source raw export adapter', () => {
  it('copies the complete source including malformed rows, CRLF and final undelimited bytes', async () => {
    const test = await fixture();
    const result = await exportOpenRawJsonl(test.source, test.destination);
    expect(result.status).toBe('committed');
    expect(await readFile(test.destination, 'utf8')).toBe(test.raw);
  });

  it('rejects a retired document without opening the source or creating a target', async () => {
    const test = await fixture();
    test.retire();
    await expect(exportOpenRawJsonl(test.source, test.destination)).rejects.toMatchObject({ code: 'source-not-authorized' });
    await expect(readFile(test.destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fences a generation changed during the initial source-validation await', async () => {
    const test = await fixture();
    test.source.isUnchanged = async () => { test.replace(); return true; };
    await expect(exportOpenRawJsonl(test.source, test.destination)).rejects.toMatchObject({ code: 'source-changed' });
    await expect(readFile(test.destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('revokes publication when the last panel closes during the final validation await', async () => {
    const test = await fixture();
    let calls = 0;
    test.source.isUnchanged = async () => { if (++calls === 3) test.retire(); return true; };
    await expect(exportOpenRawJsonl(test.source, test.destination)).rejects.toMatchObject({ code: 'source-not-authorized' });
    await expect(readFile(test.destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('honors cancellation before fingerprinting or writing', async () => {
    const test = await fixture();
    const cancellation = new AbortController();
    cancellation.abort();
    await expect(exportOpenRawJsonl(test.source, test.destination, cancellation.signal)).rejects.toMatchObject({ code: 'cancelled' });
    await expect(readFile(test.destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
