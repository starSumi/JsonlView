// @ts-expect-error JavaScript CLI modules intentionally do not emit declarations.
import { parseArgs as parsePreflightArgs, stripLeadingScriptSeparator as stripPreflightSeparator } from '../../scripts/release-preflight.mjs';
// @ts-expect-error JavaScript CLI modules intentionally do not emit declarations.
import { parseArgs as parseNpmArgs, stripLeadingScriptSeparator as stripNpmSeparator } from '../../scripts/prepare-npm-package.mjs';
// @ts-expect-error JavaScript CLI modules intentionally do not emit declarations.
import { parseArguments as parseVsixArgs, stripLeadingScriptSeparator as stripVsixSeparator } from '../../scripts/package-vsix-candidate.mjs';
// @ts-expect-error JavaScript CLI modules intentionally do not emit declarations.
import { fetchLatestVersion, parseArgs as parseFreshnessArgs } from '../../scripts/check-dependency-freshness.mjs';

import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

// @ts-expect-error JavaScript CLI module intentionally does not emit declarations.
import { isWithin } from '../../scripts/path-boundary.mjs';

const execFile = promisify(execFileCallback);

describe('release CLI argument separators', () => {
  it('treats a different Windows volume as outside the producer checkout', () => {
    expect(isWithin('E:\\workspace\\JsonlView', 'C:\\Temp\\jsonlview-release\\report.json')).toBe(false);
  });

  it('parses bounded freshness retry options and one pnpm separator', () => {
    expect(parseFreshnessArgs([
      '--',
      '--out', 'freshness.json',
      '--timeout-ms', '5000',
      '--attempts', '2',
    ])).toMatchObject({
      out: expect.stringContaining('freshness.json'),
      timeoutMs: 5000,
      attempts: 2,
    });
    expect(() => parseFreshnessArgs(['--attempts', '5'])).toThrow(/between 1 and 4/i);
    expect(() => parseFreshnessArgs(['--', '--', '--out', 'x'])).toThrow(/usage/i);
  });

  it('retries transient registry responses and returns the compact latest document', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls < 2) return new Response('busy', { status: 503 });
      return new Response(JSON.stringify({ version: '9.8.7' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      await expect(fetchLatestVersion('example-package', { attempts: 2, timeoutMs: 1_000 })).resolves.toBe('9.8.7');
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not retry a non-transient registry response', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response('missing', { status: 404 });
    }) as typeof fetch;
    try {
      await expect(fetchLatestVersion('missing-package', { attempts: 4, timeoutMs: 1_000 }))
        .rejects.toThrow('registry returned HTTP 404');
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps direct node argv behavior unchanged', () => {
    expect(parsePreflightArgs([
      '--public',
      '--approved-npm-name',
      '@sumi-labs/jsonl-view',
      '--out',
      'report.json',
    ])).toMatchObject({
      public: true,
      approvedNpmName: '@sumi-labs/jsonl-view',
      out: 'report.json',
    });
    expect(parseNpmArgs([
      '--public',
      '--name',
      '@sumi-labs/jsonl-view',
      '--version',
      '0.1.0',
      '--native', 'native-candidate',
      '--dist', 'dist-candidate',
      '--output',
      'npm-candidate',
    ])).toMatchObject({
      public: true,
      name: '@sumi-labs/jsonl-view',
      version: '0.1.0',
      native: 'native-candidate',
      dist: 'dist-candidate',
      output: 'npm-candidate',
    });
    expect(parseVsixArgs(['--native', 'native.node', '--dist', 'dist-candidate', '--out', 'jsonl-view.vsix'])).toMatchObject({
      native: 'native.node',
      dist: 'dist-candidate',
      out: 'jsonl-view.vsix',
    });
  });

  it('accepts one separator forwarded by a pnpm script invocation', () => {
    expect(parsePreflightArgs(['--', '--public'])).toMatchObject({ public: true });
    expect(parseNpmArgs([
      '--',
      '--public',
      '--name',
      '@sumi-labs/jsonl-view',
      '--version',
      '0.1.0',
      '--native', 'native-candidate',
      '--dist', 'dist-candidate',
    ])).toMatchObject({
      public: true,
      name: '@sumi-labs/jsonl-view',
      version: '0.1.0',
      native: 'native-candidate',
      dist: 'dist-candidate',
    });
    expect(parseVsixArgs(['--', '--native', 'native.node', '--dist', 'dist-candidate', '--out', 'jsonl-view.vsix'])).toMatchObject({
      native: 'native.node',
      dist: 'dist-candidate',
      out: 'jsonl-view.vsix',
    });
  });

  it('consumes exactly one leading separator and leaves another visible', () => {
    const separators = ['--', '--', '--public'];
    expect(stripPreflightSeparator(separators)).toEqual(['--', '--public']);
    expect(stripNpmSeparator(separators)).toEqual(['--', '--public']);
    expect(stripVsixSeparator(separators)).toEqual(['--', '--public']);

    expect(() => parsePreflightArgs(separators)).toThrow(/missing value for --/i);
    expect(() => parseNpmArgs(separators)).toThrow(/missing value for --/i);
    expect(() => parseVsixArgs([...separators, '--native', 'native.node', '--dist', 'dist-candidate', '--out', 'jsonl-view.vsix']))
      .toThrow(/requires a value/i);
  });

  it('runs the scheduled benchmark through pnpm-style argv forwarding', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jsonlview-benchmark-cli-'));
    try {
      const script = fileURLToPath(new URL('../../scripts/benchmark-trend.mjs', import.meta.url));
      const cwd = fileURLToPath(new URL('../..', import.meta.url));
      const output = join(directory, 'trend.json');
      const history = join(directory, 'trend.jsonl');
      const work = join(directory, 'fixtures');
      const result = await execFile(process.execPath, [
        script,
        '--',
        '--records', '16',
        '--payload-bytes', '8',
        '--out', output,
        '--history', history,
        '--work', work,
      ], { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
      expect(result.stdout).toContain('"comparison"');
      const historyAfterFirstRun = (await readFile(history, 'utf8')).trim().split(/\r?\n/);
      expect(historyAfterFirstRun).toHaveLength(1);
      await execFile(process.execPath, [
        script,
        '--records', '16',
        '--payload-bytes', '8',
        '--out', output,
        '--history', history,
        '--work', work,
        '--no-append',
      ], { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
      const historyAfterReadOnlyRecheck = (await readFile(history, 'utf8')).trim().split(/\r?\n/);
      expect(historyAfterReadOnlyRecheck).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it('does not swallow a second benchmark separator', async () => {
    const script = fileURLToPath(new URL('../../scripts/benchmark-trend.mjs', import.meta.url));
    const cwd = fileURLToPath(new URL('../..', import.meta.url));
    await expect(execFile(process.execPath, [script, '--', '--', '--records', '1'], {
      cwd,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    })).rejects.toThrow(/unknown argument: --/i);
  });

  it('rejects unsupported engine benchmark arguments instead of silently changing the workload', async () => {
    const script = fileURLToPath(new URL('../../scripts/benchmark-engine.mjs', import.meta.url));
    const cwd = fileURLToPath(new URL('../..', import.meta.url));
    await expect(execFile(process.execPath, [script, '--query', 'level == error'], {
      cwd,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    })).rejects.toThrow(/unknown argument: --query/i);
  }, 15_000);

  it('rejects unknown, missing, and repeated separators in the newline benchmark', async () => {
    const script = fileURLToPath(new URL('../../scripts/benchmark-newline-scanners.mjs', import.meta.url));
    const cwd = fileURLToPath(new URL('../..', import.meta.url));
    for (const args of [
      ['--unknown'],
      ['--rounds'],
      ['--', '--', '--rounds', '1'],
    ]) {
      await expect(execFile(process.execPath, [script, ...args], {
        cwd,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
      })).rejects.toThrow(/unknown argument|requires a value/i);
    }
  }, 15_000);
});
