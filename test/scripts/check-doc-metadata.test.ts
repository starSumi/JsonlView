import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFile = promisify(execFileCallback);

describe('documentation metadata catalog', () => {
  it('covers every product Markdown file with valid bounded metadata', async () => {
    const result = await execFile(process.execPath, ['scripts/check-doc-metadata.mjs'], {
      cwd: process.cwd(),
      windowsHide: true,
    });
    const parsed = JSON.parse(result.stdout) as { ok: boolean; documents: number; markdownFiles: number; failures: string[] };
    expect(parsed.ok).toBe(true);
    expect(parsed.documents).toBe(parsed.markdownFiles);
    expect(parsed.failures).toEqual([]);
  });
});
