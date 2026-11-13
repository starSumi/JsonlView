import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { buildIndex, stableJson } from '../../scripts/document-metadata.mjs';

const execFile = promisify(execFileCallback);

async function runMetadataCheck(metadata: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'jsonlview-doc-metadata-'));
  try {
    const docs = join(root, 'docs');
    await mkdir(docs, { recursive: true });
    const source = {
      id: 'source',
      path: 'docs/source.md',
      title: 'Source',
      kind: 'design',
      status: 'proposed',
      owner: 'product',
      tags: ['test'],
      evidence: [],
      revisit: 'review when the contract changes',
      rollback: 'withdraw this fixture document',
      ...metadata,
    };
    const toFrontMatterValue = (value: unknown) => JSON.stringify(value);
    const frontMatter = Object.entries(source).map(([key, value]) => `${key}: ${toFrontMatterValue(value)}`).join('\n');
    await writeFile(join(docs, 'source.md'), `---\n${frontMatter}\n---\n# Source\n\nFixture body.\n`);
    await writeFile(join(docs, 'target.md'), [
      '---',
      'id: "target"',
      'path: "docs/target.md"',
      'title: "Target"',
      'kind: "guide"',
      'status: "active"',
      'owner: "product"',
      'tags: ["test"]',
      'evidence: []',
      'revisit: "review when the contract changes"',
      'rollback: "withdraw this fixture document"',
      '---',
      '# Target',
      '',
      'Fixture body.',
      '',
    ].join('\n'));
    await writeFile(join(docs, 'index.json'), stableJson(await buildIndex(root)));
    const result = await execFile(process.execPath, ['scripts/check-doc-metadata.mjs', '--root', root], {
      cwd: process.cwd(),
      windowsHide: true,
    });
    return JSON.parse(result.stdout) as { ok: boolean; failures: string[] };
  } catch (error) {
    const output = (error as { stdout?: string }).stdout;
    if (typeof output === 'string') return JSON.parse(output) as { ok: boolean; failures: string[] };
    throw error;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

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

  it('accepts valid extension metadata and an indexed supersession target', async () => {
    const parsed = await runMetadataCheck({
      'x-priority': 'P1',
      'x-freshness': 'current',
      'x-review-cadence': 'review when the contract changes',
      'x-last-reviewed': '2026-11-01',
      'x-supersedes': 'docs/target.md',
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.failures).toEqual([]);
  });

  it('rejects unsupported priority/freshness values and impossible review dates', async () => {
    const parsed = await runMetadataCheck({
      'x-priority': 'P4',
      'x-freshness': 'evergreen',
      'x-last-reviewed': '2026-02-30',
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.failures).toEqual(expect.arrayContaining([
      expect.stringContaining('x-priority must be P0, P1, P2, or P3'),
      expect.stringContaining('x-freshness must be current, watch, or stale'),
      expect.stringContaining('x-last-reviewed must be a valid YYYY-MM-DD date'),
    ]));
  });

  it('requires supersession links to target an indexed Markdown document', async () => {
    const parsed = await runMetadataCheck({ 'x-supersedes': 'docs/not-indexed.md' });
    expect(parsed.ok).toBe(false);
    expect(parsed.failures).toContain('docs/source.md x-supersedes must point to an indexed Markdown document (found docs/not-indexed.md)');
  });
});
