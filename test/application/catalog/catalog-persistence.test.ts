import * as fs from 'node:fs/promises';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type CatalogPersistenceFileSystem,
  CatalogPersistenceError,
  computeCatalogChecksum,
  persistCatalog,
  serializeCatalogSnapshot,
} from '../../../src/application/catalog/catalog-persistence';
import type { CatalogSnapshot } from '../../../src/application/catalog/catalog-model';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'jsonlview-catalog-persistence-'));
  directories.push(directory);
  return directory;
}

function snapshot(): CatalogSnapshot {
  return {
    schemaVersion: 1,
    provider: 'generic',
    sourceId: 'source-1',
    sourceGeneration: 'generation-1',
    snapshotId: 'snapshot-1',
    capturedAt: '2026-11-02T00:00:00.000Z',
    redaction: 'metadata-only',
    entities: [{ sourceId: 'source-1', nativeId: 'entity-1', kind: 'session', label: 'Session', confidence: 'source' }],
    relations: [],
    locations: [{ nativeId: 'entity-1', relativePath: 'session.jsonl', rowOrdinal: '0' }],
    truncated: false,
  };
}

function fileSystem(overrides: Partial<CatalogPersistenceFileSystem> = {}): CatalogPersistenceFileSystem {
  return {
    open: (path, flags) => fs.open(path, flags),
    writeFile: (path, contents) => fs.writeFile(path, contents, 'utf8'),
    readFile: (path) => fs.readFile(path),
    rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
    remove: (path) => fs.rm(path, { force: true }),
    ...overrides,
  };
}

function errorOf(result: Awaited<ReturnType<typeof persistCatalog>>): Error {
  if (result.ok) throw new Error('Expected persistence to fail.');
  return result.error;
}

describe('persistCatalog', () => {
  it('writes canonical bytes, verifies them, and atomically renames the temporary file', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'catalog.json');
    const value = snapshot();

    const result = await persistCatalog(value, path);

    expect(result).toEqual({ ok: true, value: undefined });
    expect(await readFile(path, 'utf8')).toBe(serializeCatalogSnapshot(value));
    expect(computeCatalogChecksum(JSON.parse(await readFile(path, 'utf8')) as CatalogSnapshot)).toBe(computeCatalogChecksum(value));
    await expect(fs.access(`${path}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses a collision-safe temporary suffix without overwriting a pre-existing .tmp file', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'catalog.json');
    const collisionPath = `${path}.tmp`;
    await writeFile(collisionPath, 'keep this unrelated file', 'utf8');

    const result = await persistCatalog(snapshot(), path);

    expect(result.ok).toBe(true);
    expect(await readFile(collisionPath, 'utf8')).toBe('keep this unrelated file');
    expect((await readdir(directory)).filter((entry) => entry.startsWith('catalog.json.tmp.'))).toEqual([]);
  });

  it('replaces an existing regular target only after the temporary bytes verify', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'catalog.json');
    await writeFile(path, 'old catalog', 'utf8');

    const result = await persistCatalog(snapshot(), path);

    expect(result.ok).toBe(true);
    expect(await readFile(path, 'utf8')).toBe(serializeCatalogSnapshot(snapshot()));
  });

  it('reports a checksum mismatch and removes only its temporary file', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'catalog.json');
    await writeFile(path, 'previous catalog', 'utf8');
    const injectedFileSystem = fileSystem({ readFile: async () => Buffer.from('corrupted catalog', 'utf8') });

    const result = await persistCatalog(snapshot(), path, { fileSystem: injectedFileSystem });

    expect(result.ok).toBe(false);
    expect(errorOf(result)).toBeInstanceOf(CatalogPersistenceError);
    expect((errorOf(result) as CatalogPersistenceError).code).toBe('verify');
    expect(await readFile(path, 'utf8')).toBe('previous catalog');
    await expect(fs.access(`${path}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns a readback error and cleans up when verification cannot read the temporary file', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'catalog.json');
    const injectedFileSystem = fileSystem({ readFile: async () => { throw new Error('readback unavailable'); } });

    const result = await persistCatalog(snapshot(), path, { fileSystem: injectedFileSystem });

    expect(result.ok).toBe(false);
    expect((errorOf(result) as CatalogPersistenceError).code).toBe('verify');
    await expect(fs.access(`${path}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('supports direct writes with optional verification disabled', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'catalog.json');
    let readCalls = 0;
    const injectedFileSystem = fileSystem({ readFile: async () => { readCalls += 1; throw new Error('readback should not run'); } });

    const result = await persistCatalog(snapshot(), path, { atomicWrite: false, verifyAfterWrite: false, fileSystem: injectedFileSystem });

    expect(result).toEqual({ ok: true, value: undefined });
    expect(readCalls).toBe(0);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ sourceId: 'source-1', schemaVersion: 1 });
  });

  it('returns a write error for a missing direct-write parent', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'missing', 'catalog.json');

    const result = await persistCatalog(snapshot(), path, { atomicWrite: false });

    expect(result.ok).toBe(false);
    expect((errorOf(result) as CatalogPersistenceError).code).toBe('write');
  });

  it('returns a rename error, cleans up, and leaves a conflicting directory intact', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'catalog-directory');
    await fs.mkdir(path);

    const result = await persistCatalog(snapshot(), path);

    expect(result.ok).toBe(false);
    expect((errorOf(result) as CatalogPersistenceError).code).toBe('rename');
    expect((await fs.stat(path)).isDirectory()).toBe(true);
    await expect(fs.access(`${path}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
