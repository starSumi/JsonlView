import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFile = promisify(execFileCallback);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function git(directory: string, args: string[]): Promise<void> {
  await execFile('git', ['-C', directory, ...args], { windowsHide: true });
}

describe('producer surface discovery provenance', () => {
  it('marks an untracked producer file as dirty and reports bounded coverage', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jsonl-view-discovery-'));
    temporaryDirectories.push(directory);
    await git(directory, ['init', '-q']);
    await git(directory, ['config', 'user.email', 'test@example.invalid']);
    await git(directory, ['config', 'user.name', 'JsonlView test']);
    await writeFile(join(directory, 'tracked.ts'), 'export const tracked = "events.jsonl";\n', 'utf8');
    await git(directory, ['add', 'tracked.ts']);
    await git(directory, ['commit', '-qm', 'fixture']);
    await writeFile(join(directory, 'untracked.ts'), 'export const untracked = "events.jsonl";\n', 'utf8');

    const output = join(await mkdtemp(join(tmpdir(), 'jsonl-view-discovery-output-')), 'report.json');
    temporaryDirectories.push(output.slice(0, output.lastIndexOf('\\')));
    const script = join(process.cwd(), 'scripts', 'discover-producer-surfaces.mjs');
    await execFile(process.execPath, [script, '--root', directory, '--out', output, '--max-files', '1'], {
      windowsHide: true,
    });
    const report = JSON.parse(await readFile(output, 'utf8')) as {
      source: { workingTreeClean: boolean };
      coverage: { truncated: boolean };
      summary: { filesExamined: number; coverageTruncated: boolean };
    };

    expect(report.source.workingTreeClean).toBe(false);
    expect(report.coverage.truncated).toBe(true);
    expect(report.summary).toMatchObject({ filesExamined: 1, coverageTruncated: true });
  }, 30_000);
});
