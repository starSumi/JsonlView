import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

import { listDocuments, loadIndex, readDocument, searchDocuments, summarizeIndex } from '../../scripts/docs-index.mjs';

const execFile = promisify(execFileCallback);

describe('documentation index CLI', () => {
  it('lists deterministic front matter projections and filters by lifecycle metadata', async () => {
    const loaded = await loadIndex(process.cwd());
    const all = listDocuments(loaded.index);
    const active = listDocuments(loaded.index, { status: 'active' });

    expect(all.length).toBeGreaterThan(0);
    expect(all).toEqual([...all].sort((left, right) => left.id.localeCompare(right.id) || left.path.localeCompare(right.path)));
    expect(active.every((document) => document.status === 'active')).toBe(true);
  });

  it('searches the generated projection and reads a source with integrity checks', async () => {
    const loaded = await loadIndex(process.cwd());
    const matches = searchDocuments(loaded.index, 'Documentation Metadata Contract');
    expect(matches.map((document) => document.id)).toContain('metadata-index');

    const document = await readDocument(loaded, 'metadata-index');
    expect(document.metadata.id).toBe('metadata-index');
    expect(document.body).toContain('Lifecycle operations');
  });

  it('returns stable aggregate counts and keeps mutating commands read-only', async () => {
    const loaded = await loadIndex(process.cwd());
    const summary = summarizeIndex(loaded.index);
    expect(summary.documents).toBe(loaded.index.documents.length);
    expect(summary.byKind).toHaveProperty('decision');
    expect(summary.items).toHaveLength(summary.documents);
    expect(summary.items.every((item) => item.summary.length <= 280)).toBe(true);

    await expect(execFile(process.execPath, ['scripts/docs-index.mjs', 'create'], { cwd: process.cwd(), windowsHide: true })).rejects.toMatchObject({
      code: 1,
    });
  });
});
