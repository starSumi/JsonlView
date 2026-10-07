import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CatalogStore, createSessionNavigatorProvider, parseAuthorizedSources, RevealIntentRegistry, sourceIdFor } from '../../src/experimental';
import type { AuthorizedSourceSetting } from '../../src/experimental';

const cleanup: string[] = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    const path = cleanup.pop();
    if (path !== undefined) await rm(path, { recursive: true, force: true });
  }
});

describe('session navigator source boundary', () => {
  it('uses a VS Code-valid Activity Bar container id and binds the view to it', async () => {
    const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
      contributes: {
        viewsContainers: { activitybar: Array<{ id: string }> };
        views: Record<string, Array<{ id: string }>>;
      };
    };
    const container = manifest.contributes.viewsContainers.activitybar.find((entry) => entry.id === 'jsonlViewSessionNavigator');
    expect(container).toBeDefined();
    expect(container?.id).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(manifest.contributes.views.jsonlViewSessionNavigator?.some((view) => view.id === 'jsonlView.sessionNavigator')).toBe(true);
  });

  it('consumes reveal intents once and clears stale targets explicitly', () => {
    const registry = new RevealIntentRegistry();
    const intent = { sourceId: 'source-1', catalogGeneration: 'g-1', nativeId: 'event-1', anchorOrdinal: '4' } as const;
    registry.set('file:///synthetic/events.jsonl', intent);
    expect(registry.take('file:///synthetic/events.jsonl')).toEqual(intent);
    expect(registry.take('file:///synthetic/events.jsonl')).toBeUndefined();
    registry.set('file:///synthetic/other.jsonl', intent);
    registry.clear('file:///synthetic/other.jsonl');
    expect(registry.take('file:///synthetic/other.jsonl')).toBeUndefined();
  });

  it('accepts only explicit file URI settings and derives opaque source ids', () => {
    const settings = parseAuthorizedSources([
      { provider: 'codex', rootUri: 'file:///E:/synthetic/sessions' },
      { provider: 'codex', rootUri: 'file:///E:/synthetic/sessions' },
      { provider: 'unknown', rootUri: 'file:///E:/synthetic/other' },
      { provider: 'claude', rootUri: 'https://example.invalid/private' },
    ]);
    expect(settings).toEqual([{ provider: 'codex', rootUri: 'file:///E:/synthetic/sessions' }]);
    expect(sourceIdFor(settings[0]!)).toMatch(/^codex-[a-f0-9]{24}$/u);
    expect(JSON.stringify(settings)).not.toContain('private');
  });

  it('scans bounded metadata and preserves locations without exposing message bodies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jsonlview-session-navigator-'));
    cleanup.push(root);
    const file = join(root, 'rollout.jsonl');
    await writeFile(file, [
      JSON.stringify({ type: 'session_meta', id: 'session-1', title: 'Synthetic session', prompt: 'private body' }),
      JSON.stringify({ type: 'subagent', id: 'agent-1', parentId: 'session-1', status: 'ready', message: { text: 'private body' } }),
      JSON.stringify({ type: 'event_msg', id: 'event-1', parentId: 'agent-1', summary: 'tool completed' }),
    ].join('\n'), 'utf8');
    const setting: AuthorizedSourceSetting = { provider: 'codex', rootUri: pathToFileURL(root).toString() };
    const provider = createSessionNavigatorProvider(setting);
    const result = await provider.scan(new AbortController().signal, {
      maxEntities: 20, maxRelations: 20, maxRecords: 20, maxFiles: 4, maxBytes: 1_000_000, maxMilliseconds: 2_000,
    });
    expect(result.snapshot.sourceId).toBe(sourceIdFor(setting));
    expect(result.snapshot.entities.map((entity) => entity.nativeId)).toEqual(['session-1', 'agent-1', 'event-1']);
    expect(result.snapshot.relations).toEqual(expect.arrayContaining([expect.objectContaining({ fromNativeId: 'agent-1', toNativeId: 'session-1', kind: 'parent' })]));
    expect(JSON.stringify(result.snapshot)).not.toContain('private body');
    expect(result.snapshot.locations).toEqual(expect.arrayContaining([expect.objectContaining({ relativePath: 'rollout.jsonl', rowOrdinal: '1' })]));
  });

  it('persists a derived catalog and restores it after reopening', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jsonlview-session-catalog-'));
    cleanup.push(root);
    const sourceRoot = join(root, 'source');
    const dbPath = join(root, 'catalog.sqlite');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(sourceRoot));
    const file = join(sourceRoot, 'events.ndjson');
    await writeFile(file, JSON.stringify({ type: 'session', id: 's-1', title: 'Persisted' }), 'utf8');
    const setting: AuthorizedSourceSetting = { provider: 'claude', rootUri: pathToFileURL(sourceRoot).toString() };
    const sourceId = sourceIdFor(setting);
    const provider = createSessionNavigatorProvider(setting);
    const scan = await provider.scan(new AbortController().signal, {
      maxEntities: 10, maxRelations: 10, maxRecords: 10, maxFiles: 4, maxBytes: 100_000, maxMilliseconds: 2_000,
    });
    const first = await CatalogStore.open(dbPath);
    first.syncSources([setting]);
    const stored = first.replaceSnapshot(sourceId, scan.snapshot, scan.fingerprint);
    expect(stored.sourceGeneration).toBe('g-1');
    expect(first.listSources()[0]).toMatchObject({ sourceId, provider: 'claude', entityCount: 1 });
    first.close();

    const reopened = await CatalogStore.open(dbPath);
    expect(reopened.listSources()[0]).toMatchObject({ sourceId, generation: 'g-1', entityCount: 1 });
    const children = reopened.getChildren(sourceId);
    expect(children.map((entity) => entity.nativeId)).toEqual(['s-1']);
    expect(reopened.getLocation({ sourceId, generation: 'g-1', nativeId: 's-1' })).toMatchObject({ relativePath: 'events.ndjson', rowOrdinal: '0' });
    expect(reopened.getLocation({ sourceId, generation: 'g-0', nativeId: 's-1' })).toBeUndefined();
    reopened.close();
  });

  it('cancels a scan before it reads a source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jsonlview-session-cancel-'));
    cleanup.push(root);
    const controller = new AbortController();
    controller.abort();
    const provider = createSessionNavigatorProvider({ provider: 'generic', rootUri: pathToFileURL(root).toString() });
    await expect(provider.scan(controller.signal, {
      maxEntities: 10, maxRelations: 10, maxRecords: 10, maxFiles: 4, maxBytes: 100_000, maxMilliseconds: 2_000,
    })).rejects.toThrow('cancelled');
  });
});
