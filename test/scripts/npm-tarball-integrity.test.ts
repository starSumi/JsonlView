// @ts-expect-error JavaScript release helper intentionally does not emit declarations.
import { inspectNpmTarball } from '../../scripts/npm-tarball-integrity.mjs';

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create } from 'tar';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('npm tarball integrity', () => {
  it('binds artifact bytes, embedded package identity, and a deterministic file inventory', async () => {
    const directory = await fixtureDirectory();
    const tarball = join(directory, 'candidate.tgz');
    await create({ cwd: directory, file: tarball, gzip: true, portable: true }, ['package']);

    const report = await inspectNpmTarball(tarball);

    expect(report.packageJson).toMatchObject({ name: '@sumi-labs/jsonl-view', version: '0.2.0' });
    expect(report.artifact.bytes).toBeGreaterThan(0);
    expect(report.artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.inventorySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.files.map((file: { path: string }) => file.path)).toEqual([
      'dist/extension.cjs',
      'package.json',
    ]);
  });

  it('rejects a duplicate path even when both entries have the same bytes', async () => {
    const directory = await fixtureDirectory();
    const tarball = join(directory, 'duplicate.tgz');
    await create({ cwd: directory, file: tarball, gzip: true, portable: true }, [
      'package/package.json',
      'package/package.json',
    ]);

    await expect(inspectNpmTarball(tarball)).rejects.toThrow(/duplicate path/i);
  });

  it('rejects an archive that is not rooted below package/', async () => {
    const directory = await fixtureDirectory();
    await writeFile(join(directory, 'outside.txt'), 'not an npm package\n', 'utf8');
    const tarball = join(directory, 'outside.tgz');
    await create({ cwd: directory, file: tarball, gzip: true, portable: true }, ['outside.txt']);

    await expect(inspectNpmTarball(tarball)).rejects.toThrow(/outside package/i);
  });
});

async function fixtureDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'jsonlview-npm-tarball-'));
  temporaryDirectories.push(directory);
  await mkdir(join(directory, 'package', 'dist'), { recursive: true });
  await writeFile(join(directory, 'package', 'package.json'), `${JSON.stringify({
    name: '@sumi-labs/jsonl-view',
    version: '0.2.0',
  })}\n`, 'utf8');
  await writeFile(join(directory, 'package', 'dist', 'extension.cjs'), 'module.exports = {};\n', 'utf8');
  return directory;
}
