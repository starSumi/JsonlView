import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error JavaScript CLI module intentionally does not emit declarations.
import { parseArgs } from '../../scripts/check-changelog.mjs';

const execFile = promisify(execFileCallback);
const temporaryDirectories: string[] = [];
const guardScript = join(process.cwd(), 'scripts', 'check-changelog.mjs');
const baselineChangelog = '# Changelog\n\n## Unreleased\n\n## 0.1.0 - 2026-01-01\n\n- Initial release.\n';

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('changelog release-note guard', () => {
  it('accepts one pnpm separator and rejects duplicate separators', () => {
    expect(parseArgs(['--', '--base', 'abc'])).toEqual({ base: 'abc', head: 'HEAD' });
    expect(() => parseArgs(['--', '--', '--base', 'abc'])).toThrow(/Unknown or incomplete argument/);
  });

  it('accepts an implementation change with a new Unreleased bullet', async () => {
    const { directory, base } = await createRepository();
    await writeFile(join(directory, 'src', 'feature.ts'), 'export const enabled = true;\n', 'utf8');
    await writeFile(join(directory, 'CHANGELOG.md'), `${baselineChangelog.replace('## Unreleased\n', '## Unreleased\n\n- Add the feature.\n')}`, 'utf8');
    await commit(directory, 'feat: add feature');

    await expect(runGuard(directory, base)).resolves.toMatchObject({ code: 0 });
  }, 20_000);

  it('rejects implementation changes without a changelog edit', async () => {
    const { directory, base } = await createRepository();
    await writeFile(join(directory, 'src', 'feature.ts'), 'export const enabled = true;\n', 'utf8');
    await commit(directory, 'feat: add feature');

    await expect(runGuard(directory, base)).resolves.toMatchObject({
      code: 1,
      output: expect.stringContaining('require a new bullet under ## Unreleased'),
    });
  }, 20_000);

  it('rejects a historical release-note edit without an Unreleased entry', async () => {
    const { directory, base } = await createRepository();
    await writeFile(join(directory, 'src', 'feature.ts'), 'export const enabled = true;\n', 'utf8');
    await writeFile(join(directory, 'CHANGELOG.md'), `${baselineChangelog}- Correct an old release note.\n`, 'utf8');
    await commit(directory, 'feat: add feature');

    await expect(runGuard(directory, base)).resolves.toMatchObject({
      code: 1,
      output: expect.stringContaining('adds no new bullet under ## Unreleased'),
    });
  }, 20_000);

  it('does not require release notes for tests-only changes', async () => {
    const { directory, base } = await createRepository();
    await mkdir(join(directory, 'test'), { recursive: true });
    await writeFile(join(directory, 'test', 'feature.test.ts'), 'expect(true).toBe(true);\n', 'utf8');
    await commit(directory, 'test: cover feature');

    await expect(runGuard(directory, base)).resolves.toMatchObject({
      code: 0,
      output: expect.stringContaining('No implementation-source changes'),
    });
  }, 20_000);
});

async function createRepository(): Promise<{ directory: string; base: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'jsonlview-changelog-'));
  temporaryDirectories.push(directory);
  await mkdir(join(directory, 'src'), { recursive: true });
  await writeFile(join(directory, 'CHANGELOG.md'), baselineChangelog, 'utf8');
  await git(directory, ['init', '-q']);
  await git(directory, ['config', 'user.email', 'test@example.invalid']);
  await git(directory, ['config', 'user.name', 'JsonlView tests']);
  await commit(directory, 'chore: create baseline');
  const base = (await git(directory, ['rev-parse', 'HEAD'])).trim();
  return { directory, base };
}

async function commit(directory: string, message: string): Promise<void> {
  await git(directory, ['add', '.']);
  await git(directory, ['commit', '-qm', message]);
}

async function git(directory: string, args: string[]): Promise<string> {
  const result = await execFile('git', ['-C', directory, ...args], { windowsHide: true });
  return result.stdout;
}

async function runGuard(directory: string, base: string): Promise<{ code: number; output: string }> {
  try {
    const result = await execFile(process.execPath, [guardScript, '--', '--base', base], {
      cwd: directory,
      windowsHide: true,
    });
    return { code: 0, output: result.stdout };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}
