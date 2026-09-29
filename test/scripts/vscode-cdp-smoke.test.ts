import { spawnSync } from 'node:child_process';
import { link, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const { createMutableSyntheticFixture } = await import(fileURLToPath(new URL('../../scripts/synthetic-cdp-fixture.mjs', import.meta.url)));

const smokeScript = fileURLToPath(new URL('../../scripts/vscode-cdp-smoke.mjs', import.meta.url));
const fixtureScript = fileURLToPath(new URL('../../scripts/synthetic-cdp-fixture.mjs', import.meta.url));
const syntheticRecord = '{"message":"Synthetic acceptance event 0"}\n';

async function withTempRoot(check: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'jsonlview-smoke-'));
  try {
    await check(root);
  } finally {
    const relativeRoot = relative(resolve(tmpdir()), await realpath(root));
    if (!relativeRoot || relativeRoot.startsWith('..') || isAbsolute(relativeRoot)) {
      throw new Error('Refusing to remove an unexpected smoke test directory');
    }
    await rm(root, { recursive: true, force: true });
  }
}

function runSmoke(output: string, ...argumentsToPass: string[]) {
  return spawnSync(process.execPath, [smokeScript, '1', output, ...argumentsToPass], {
    encoding: 'utf8',
    timeout: 5_000,
    env: { ...process.env, JSONLVIEW_CDP_SETTLE_MS: '0' },
  });
}

function prepareFixture(output: string) {
  const result = spawnSync(process.execPath, [fixtureScript, output, '2'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout).fixture as string;
}

describe('synthetic CDP smoke fixture boundary', () => {
  for (const modeArguments of [
    ['--follow-file', 'victim.jsonl'],
    ['--append-file', 'victim.jsonl'],
    ['--change-file', 'victim.jsonl', '--change-kind', 'replace'],
  ]) {
    it(`rejects the disabled mutation mode ${modeArguments[0]} before contacting CDP`, async () => {
      await withTempRoot(async (root) => {
        const output = join(root, 'output');
        const victim = join(root, 'victim.jsonl');
        await mkdir(output);
        await writeFile(victim, syntheticRecord);

        const result = runSmoke(output, ...modeArguments);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('File mutation modes using a supplied path are disabled');
        expect(await readFile(victim, 'utf8')).toBe(syntheticRecord);
        expect(await readdir(output)).toEqual([]);
      });
    });
  }

  it('rejects invalid synthetic change kinds before creating a run directory', async () => {
    await withTempRoot(async (root) => {
      const output = join(root, 'output');
      const result = runSmoke(output, '--synthetic-change', 'replace');

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('--synthetic-change requires append, truncate, or rewrite');
      await expect(readdir(output)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('never accepts an external path alongside an owned synthetic change', async () => {
    await withTempRoot(async (root) => {
      const output = join(root, 'output');
      const victim = join(root, 'victim.jsonl');
      await writeFile(victim, syntheticRecord);

      const result = runSmoke(output, '--synthetic-change', 'truncate', '--change-file', victim);

      expect(result.status).toBe(1);
      expect(await readFile(victim, 'utf8')).toBe(syntheticRecord);
      await expect(readdir(output)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('applies append, same-size rewrite, and truncate through its creation handle', async () => {
    await withTempRoot(async (root) => {
      const owned = await createMutableSyntheticFixture(root, 2);
      try {
        const original = await readFile(owned.fixture, 'utf8');
        await owned.change('append');
        const appended = await readFile(owned.fixture, 'utf8');
        expect(appended.startsWith(original)).toBe(true);
        expect(appended.trim().split('\n')).toHaveLength(3);

        await owned.change('rewrite');
        const rewritten = await readFile(owned.fixture, 'utf8');
        expect(rewritten.length).toBe(appended.length);
        expect(JSON.parse(rewritten.split('\n')[0]!).level).toBe('warn');

        await owned.change('truncate');
        expect(await readFile(owned.fixture, 'utf8')).toBe('');
      } finally {
        await owned.close();
      }
    });
  });

  it('refuses to mutate a run-owned fixture after it gains another hard link', async () => {
    await withTempRoot(async (root) => {
      const owned = await createMutableSyntheticFixture(root, 2);
      try {
        const original = await readFile(owned.fixture, 'utf8');
        await link(owned.fixture, join(root, 'alias.jsonl'));

        await expect(owned.change('truncate')).rejects.toThrow(/no longer identifies the owned file/);
        expect(await readFile(owned.fixture, 'utf8')).toBe(original);
        expect(await readFile(join(root, 'alias.jsonl'), 'utf8')).toBe(original);
      } finally {
        await owned.close();
      }
    });
  });

  it('never writes to an unrelated file when the fixture path is replaced by its hard link', async (context) => {
    await withTempRoot(async (root) => {
      const owned = await createMutableSyntheticFixture(root, 2);
      const victim = join(root, 'victim.jsonl');
      await writeFile(victim, syntheticRecord);
      try {
        try {
          await unlink(owned.fixture);
          await link(victim, owned.fixture);
        } catch (error) {
          if (error && typeof error === 'object' && 'code' in error
            && ['EPERM', 'EACCES', 'ENOTSUP'].includes(String(error.code))) {
            context.skip();
            return;
          }
          throw error;
        }
        await expect(owned.change('truncate')).rejects.toThrow(/no longer identifies the owned file/);
        expect(await readFile(victim, 'utf8')).toBe(syntheticRecord);
        expect(await readFile(owned.fixture, 'utf8')).toBe(syntheticRecord);
      } finally {
        await owned.close();
      }
    });
  });

  it('creates a private run directory and does not overwrite an existing result path', async () => {
    await withTempRoot(async (root) => {
      const output = join(root, 'output');
      const existingResult = join(output, 'result.json');
      await mkdir(output);
      await writeFile(existingResult, 'keep this evidence');

      const result = runSmoke(output, '--inspect-only');
      const entries = await readdir(output, { withFileTypes: true });

      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain('must be outside the product checkout');
      expect(entries.filter((entry) => entry.isDirectory() && entry.name.startsWith('cdp-run-'))).toHaveLength(1);
      expect(await readFile(existingResult, 'utf8')).toBe('keep this evidence');
    });
  });

  it('creates fixtures in unique child directories without forgeable owner metadata', async () => {
    await withTempRoot(async (root) => {
      const output = join(root, 'output');
      await mkdir(output);

      const firstFixture = prepareFixture(output);
      const secondFixture = prepareFixture(output);
      const entries = await readdir(output, { withFileTypes: true });

      expect(firstFixture).not.toBe(secondFixture);
      expect(entries.filter((entry) => entry.isDirectory() && entry.name.startsWith('synthetic-fixture-'))).toHaveLength(2);
      expect(firstFixture.endsWith('synthetic.jsonl')).toBe(true);
      expect(secondFixture.endsWith('synthetic.jsonl')).toBe(true);
      expect(await readdir(resolve(firstFixture, '..'))).not.toContain('fixture-owner.json');
      expect(await readdir(resolve(secondFixture, '..'))).not.toContain('fixture-owner.json');
    });
  });

  it('rejects a smoke output path that traverses a symbolic-link ancestor', async () => {
    await withTempRoot(async (root) => {
      const external = join(root, 'external');
      const linkParent = join(root, 'link-parent');
      const output = join(linkParent, 'output');
      await mkdir(external);
      try {
        await symlink(external, linkParent, 'junction');
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error
          && ['EPERM', 'EACCES', 'ENOTSUP'].includes(String(error.code))) return;
        throw error;
      }

      const result = runSmoke(output);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('cannot pass through a symbolic-link or junction ancestor');
    });
  });
});
