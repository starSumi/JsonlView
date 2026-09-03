import { mkdtemp, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifySnapshotChange, createLocalSnapshot } from '../../src/extension/snapshot';

describe('snapshot reconciliation', () => {
  it('detects append without changing document identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jsonl-view-snapshot-'));
    const path = join(directory, 'events.jsonl');
    await writeFile(path, '{"id":1}\n');
    const first = await createLocalSnapshot(path, `file:///${path}`, 'doc');
    await appendFile(path, '{"id":2}\n');
    const second = await createLocalSnapshot(path, `file:///${path}`, 'doc');
    expect(classifySnapshotChange(first, second)).toBe('append');
  });

  it('detects same-size rewrite as replacement', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jsonl-view-snapshot-'));
    const path = join(directory, 'events.jsonl');
    await writeFile(path, '{"id":1}\n');
    const first = await createLocalSnapshot(path, `file:///${path}`, 'doc');
    await writeFile(path, '{"id":2}\n');
    const second = await createLocalSnapshot(path, `file:///${path}`, 'doc');
    expect(classifySnapshotChange(first, second)).toBe('replace');
  });
});

