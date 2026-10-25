import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFile = promisify(execFileCallback);

describe('documentation front matter and generated index', () => {
  it('covers every product Markdown/MDX file with valid bounded metadata', async () => {
    const result = await execFile(process.execPath, ['scripts/check-doc-metadata.mjs'], {
      cwd: process.cwd(),
      windowsHide: true,
    });
    const parsed = JSON.parse(result.stdout) as { ok: boolean; documents: number; index: string; failures: string[] };
    expect(parsed.ok).toBe(true);
    expect(parsed.index).toBe('docs/index.json');
    expect(parsed.documents).toBeGreaterThan(0);
    expect(parsed.failures).toEqual([]);
  });
});
