import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, open, rm, stat, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  fingerprintRange,
  fingerprintStableRange,
  fingerprintWholeRange,
  formatFingerprint,
} from '../../src/engine/snapshot-fingerprint';

const temporaryDirectories: string[] = [];
const openHandles: FileHandle[] = [];

afterEach(async () => {
  await Promise.all(openHandles.splice(0).map((handle) => handle.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createFixture(contents: Buffer | string): Promise<{ handle: FileHandle; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'jsonl-view-fingerprint-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'source.jsonl');
  await writeFile(path, contents);
  const handle = await open(path, 'r');
  openHandles.push(handle);
  return { handle, path };
}

function sha256(contents: Buffer | string): string {
  return createHash('sha256').update(contents).digest('hex');
}

describe('snapshot fingerprints', () => {
  it('hashes an absolute byte range and reports a short read at end of file', async () => {
    const { handle } = await createFixture('0123456789');

    const middle = await fingerprintRange(handle, 2n, 4);
    expect(middle).toEqual({ length: 4, hash: sha256('2345') });
    expect(formatFingerprint(middle)).toBe(`sha256:${sha256('2345')}:4`);

    await expect(fingerprintRange(handle, 8n, 8)).resolves.toEqual({
      length: 2,
      hash: sha256('89'),
    });
  });

  it('establishes a whole-file fingerprint only while source metadata remains stable', async () => {
    const contents = '{"id":1}\n{"id":2}\n';
    const { handle, path } = await createFixture(contents);
    const baseline = await stat(path, { bigint: true });

    await expect(
      fingerprintStableRange(handle, baseline.size, baseline.mtimeNs, baseline.ctimeNs),
    ).resolves.toEqual({ length: baseline.size, hash: sha256(contents) });

    await appendFile(path, '{"id":3}\n');
    await expect(
      fingerprintStableRange(handle, baseline.size, baseline.mtimeNs, baseline.ctimeNs),
    ).resolves.toBeUndefined();
  });

  it('checks cancellation and the generation guard before reading a whole range', async () => {
    const contents = Buffer.alloc(64, 0x61);
    const { handle } = await createFixture(contents);
    const controller = new AbortController();
    controller.abort();

    await expect(
      fingerprintWholeRange(handle, BigInt(contents.length), controller.signal),
    ).rejects.toThrow('fingerprint aborted');

    const staleGeneration = new Error('stale generation');
    await expect(
      fingerprintWholeRange(handle, BigInt(contents.length), undefined, () => {
        throw staleGeneration;
      }),
    ).rejects.toBe(staleGeneration);
  });
});
