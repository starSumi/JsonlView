import { spawnSync } from 'node:child_process';
import { link, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const { createMutableSyntheticFixture } = await import(fileURLToPath(new URL('../../scripts/synthetic-cdp-fixture.mjs', import.meta.url)));
const { isExpectedPageNavigation, parsePageCursorOrdinal, samePageNavigationState } = await import(
  fileURLToPath(new URL('../../scripts/page-navigation-measurement.mjs', import.meta.url)),
);
const { CdpClient, findCdpTargetWithinDeadline, runCdpMeasurement } = await import(
  fileURLToPath(new URL('../../scripts/cdp-measurement-lifecycle.mjs', import.meta.url)),
);

const smokeScript = fileURLToPath(new URL('../../scripts/vscode-cdp-smoke.mjs', import.meta.url));
const fixtureScript = fileURLToPath(new URL('../../scripts/synthetic-cdp-fixture.mjs', import.meta.url));
const syntheticRecord = '{"message":"Synthetic acceptance event 0"}\n';

class PreparationCancellationSocket extends EventTarget {
  readyState = 0;
  respondToCancellation: boolean;
  commands: Array<{ id: number; method: string; params: { expression?: string } }> = [];
  preparationRequestId: number | undefined;

  constructor(respondToCancellation = true) {
    super();
    this.respondToCancellation = respondToCancellation;
    queueMicrotask(() => {
      this.readyState = 1;
      this.dispatchEvent(new Event('open'));
    });
  }

  send(payload: string) {
    const command = JSON.parse(payload) as { id: number; method: string; params: { expression?: string } };
    this.commands.push(command);
    if (command.params.expression === 'cancel-page-probe' && !this.respondToCancellation) return;
    if (command.params.expression === 'prepare-hangs') {
      this.preparationRequestId = command.id;
      return;
    }
    queueMicrotask(() => {
      if (command.params.expression === 'cancel-page-probe' && this.preparationRequestId !== undefined) {
        this.dispatchResponse({
          id: this.preparationRequestId,
          result: { exceptionDetails: { text: 'Page preparation cancelled.' } },
        });
        this.preparationRequestId = undefined;
      }
      this.dispatchResponse({ id: command.id, result: { result: { value: true } } });
    });
  }

  private dispatchResponse(response: { id: number; result: unknown }) {
    const message = new Event('message');
    Object.defineProperty(message, 'data', { value: JSON.stringify(response) });
    this.dispatchEvent(message);
  }

  close() {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
}

async function withTempRoot(check: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'jsonlview-smoke-'));
  try {
    await check(root);
  } finally {
    await removeOwnedTempRoot(root);
  }
}

async function removeOwnedTempRoot(root: string): Promise<void> {
  const relativeRoot = relative(resolve(tmpdir()), await realpath(root));
  if (!relativeRoot || relativeRoot.startsWith('..') || isAbsolute(relativeRoot)) {
    throw new Error('Refusing to remove an unexpected smoke test directory');
  }
  await rm(root, { recursive: true, force: true });
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
  it('shares one deadline across the serial target scan', async () => {
    let now = 0;
    const budgets: number[] = [];

    await expect(findCdpTargetWithinDeadline({
      candidates: ['stale-1', 'stale-2', 'fixture'],
      probe: async (_candidate: string, remainingMs: number) => {
        budgets.push(remainingMs);
        now += remainingMs;
        throw new Error('CDP target detached.');
      },
      matches: () => false,
      timeoutMs: 30,
      timeoutMessage: 'Synthetic fixture target discovery exceeded 30 seconds.',
      now: () => now,
    })).rejects.toThrow('Synthetic fixture target discovery exceeded 30 seconds.');

    expect(budgets).toEqual([30]);
  });

  it('cancels stalled preparation before closing the CDP session', async () => {
    const socket = new PreparationCancellationSocket();
    const client = new CdpClient('ws://test.invalid', () => socket as unknown as WebSocket);
    let preparationSettled = false;
    let pendingAfterPageCancellation: number | undefined;
    let preparationSettledAtCancellation: boolean | undefined;

    const result = runCdpMeasurement({
      client,
      timeoutMs: 25,
      timeoutMessage: 'Page navigation CDP measurement exceeded 20 seconds.',
      cancelTimeoutMs: 100,
      task: async () => {
        await client.open();
        try {
          const response = await client.send('Runtime.evaluate', { expression: 'prepare-hangs' });
          if (response.exceptionDetails) throw new Error('Page preparation was cancelled.');
        } finally {
          preparationSettled = true;
        }
      },
      onTimeout: () => client.send('Runtime.evaluate', { expression: 'cancel-page-probe' }).then(() => {
        pendingAfterPageCancellation = client.pendingRequestCount;
        preparationSettledAtCancellation = preparationSettled;
      }),
    });

    await expect(result).rejects.toThrow('Page navigation CDP measurement exceeded 20 seconds.');
    expect(socket.commands.map((command) => command.params.expression)).toEqual([
      'prepare-hangs',
      'cancel-page-probe',
    ]);
    expect(socket.readyState).toBe(3);
    expect(pendingAfterPageCancellation).toBe(0);
    expect(preparationSettledAtCancellation).toBe(true);
    expect(client.pendingRequestCount).toBe(0);
    expect(preparationSettled).toBe(true);
  });

  it('closes CDP when page cancellation misses its grace period', async () => {
    const socket = new PreparationCancellationSocket(false);
    const client = new CdpClient('ws://test.invalid', () => socket as unknown as WebSocket);
    const startedAt = performance.now();

    const result = runCdpMeasurement({
      client,
      timeoutMs: 20,
      timeoutMessage: 'Page navigation CDP measurement exceeded 20 seconds.',
      cancelTimeoutMs: 25,
      task: async () => {
        await client.open();
        await client.send('Runtime.evaluate', { expression: 'prepare-hangs' });
      },
      onTimeout: () => client.send('Runtime.evaluate', { expression: 'cancel-page-probe' }),
    });

    await expect(result).rejects.toThrow('Page navigation CDP measurement exceeded 20 seconds.');
    expect(performance.now() - startedAt).toBeLessThan(1000);
    expect(socket.commands.map((command) => command.params.expression)).toEqual([
      'prepare-hangs',
      'cancel-page-probe',
    ]);
    expect(socket.readyState).toBe(3);
    expect(client.pendingRequestCount).toBe(0);
  });

  it('parses the cursor range without assuming row order', () => {
    expect(parsePageCursorOrdinal('Rows #100-#199')).toBe(100);
    expect(parsePageCursorOrdinal('Rows #0-#99')).toBe(0);
    expect(parsePageCursorOrdinal('Loading page...')).toBeUndefined();
    expect(parsePageCursorOrdinal('Rows #1.5-#9')).toBeUndefined();
  });

  it('requires one-page movement in the requested direction', () => {
    expect(isExpectedPageNavigation(1, 2, 'next')).toBe(true);
    expect(isExpectedPageNavigation(2, 1, 'previous')).toBe(true);
    expect(isExpectedPageNavigation(1, 3, 'next')).toBe(false);
    expect(isExpectedPageNavigation(2, 2, 'previous')).toBe(false);
    expect(isExpectedPageNavigation(1, 2, 'sideways')).toBe(false);
  });

  it('requires the measured page state to remain unchanged across the settle frames', () => {
    const committed = { page: 2, cursorText: 'Rows #100-#199', cursorOrdinal: 100, mountedOrdinal: 100, generation: 'g2' };
    expect(samePageNavigationState(committed, { ...committed })).toBe(true);
    expect(samePageNavigationState(committed, { ...committed, page: 3 })).toBe(false);
    expect(samePageNavigationState(committed, { ...committed, cursorOrdinal: 200 })).toBe(false);
    expect(samePageNavigationState(committed, { ...committed, mountedOrdinal: 101 })).toBe(false);
    expect(samePageNavigationState(committed, { ...committed, generation: 'g3' })).toBe(false);
  });

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

  it('rejects inspect-only mode before creating a page-navigation measurement run', async () => {
    await withTempRoot(async (root) => {
      const output = join(root, 'output');
      const result = runSmoke(output, '--inspect-only', '--measure-page-navigation');

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('--measure-page-navigation cannot be combined with --inspect-only');
      await expect(readdir(output)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('keeps query temporal association separate from page-navigation measurement', async () => {
    await withTempRoot(async (root) => {
      const output = join(root, 'output');
      const result = runSmoke(output, '--measure-page-navigation', '--measure-query-temporal-association');

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Page-navigation and query temporal-association measurement modes are separate');
      await expect(readdir(output)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('rejects inspect-only query temporal-association mode before creating a run directory', async () => {
    await withTempRoot(async (root) => {
      const output = join(root, 'output');
      const result = runSmoke(output, '--inspect-only', '--measure-query-temporal-association');

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('--measure-query-temporal-association cannot be combined with --inspect-only');
      await expect(readdir(output)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('rejects page-navigation measurement combined with a synthetic file mutation', async () => {
    await withTempRoot(async (root) => {
      const output = join(root, 'output');
      const result = runSmoke(output, '--measure-page-navigation', '--synthetic-change', 'append');

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('--measure-page-navigation cannot be combined with other smoke modes');
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
