import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('architecture boundary gate', () => {
  it('rejects forbidden alias imports whose filename contains replacement tokens', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'jsonlview-architecture-'));
    try {
      await mkdir(join(fixture, 'config'));
      await mkdir(join(fixture, 'src', 'private'), { recursive: true });
      await writeFile(join(fixture, 'config', 'webview-architecture.json'), JSON.stringify({
        facades: [], privateRoots: [],
        boundaryRules: [{ name: 'no-private-import', from: 'src/consumer.ts', forbiddenTargets: ['src/private'] }],
      }));
      await writeFile(join(fixture, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { paths: { '@private/*': ['src/private/*'] } },
      }));
      await writeFile(join(fixture, 'src', 'consumer.ts'), 'import { value } from "@private/literal$&";');
      await writeFile(join(fixture, 'src', 'private', 'literal$&.ts'), 'export const value = 1;');
      const result = spawnSync(process.execPath, [resolve('scripts/check-architecture.mjs')], {
        cwd: fixture, encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stderr)).toMatchObject({
        ok: false,
        failures: [{ kind: 'boundary-import', target: 'src/private/literal$&.ts' }],
      });
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('accepts the configured application and session dependency boundaries', () => {
    const output = execFileSync(process.execPath, ['scripts/check-architecture.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    const result = JSON.parse(output) as {
      ok: boolean;
      checked?: { boundaryRules?: number };
    };

    expect(result.ok).toBe(true);
    expect(result.checked?.boundaryRules).toBeGreaterThanOrEqual(4);
  });
});
