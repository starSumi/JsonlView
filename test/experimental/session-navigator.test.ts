import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CatalogStore, createSessionNavigatorProvider, discoverDefaultSources, mergeSourceSettings, parseAuthorizedSources, RevealIntentRegistry, sourceIdFor } from '../../src/experimental';
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

  it('discovers provider-owned default roots from their standard environment paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jsonlview-session-defaults-'));
    cleanup.push(root);
    const codexHome = join(root, 'codex-home');
    const codexStateHome = join(root, 'codex-state');
    const claudeHome = join(root, 'claude-home');
    await import('node:fs/promises').then(async ({ mkdir }) => {
      await mkdir(join(codexHome, 'sessions'), { recursive: true });
      await mkdir(codexStateHome, { recursive: true });
      await mkdir(join(claudeHome, 'projects'), { recursive: true });
    });
    await writeFile(join(codexStateHome, 'state_5.sqlite'), '', 'utf8');

    const discovered = discoverDefaultSources({
      env: { CODEX_HOME: codexHome, CODEX_SQLITE_HOME: codexStateHome, CLAUDE_CONFIG_DIR: claudeHome },
      homeDirectory: join(root, 'unused-home'),
    });
    expect(discovered.map((setting) => setting.provider)).toEqual(['codex', 'claude']);
    expect(discovered.map((setting) => setting.rootUri)).toEqual([
      pathToFileURL(codexHome).toString(),
      pathToFileURL(claudeHome).toString(),
    ]);
    expect(discovered[0]?.stateRootUri).toBe(pathToFileURL(codexStateHome).toString());
    const merged = mergeSourceSettings([
      { provider: 'codex', rootUri: pathToFileURL(join(codexHome, 'sessions')).toString() },
    ], discovered);
    expect(merged.filter((setting) => setting.provider === 'codex')).toEqual([discovered[0]]);
    const override = { provider: 'codex' as const, rootUri: discovered[0]!.rootUri, stateRootUri: pathToFileURL(join(root, 'custom-state')).toString() };
    expect(mergeSourceSettings([override], discovered)[0]).toEqual(override);
    expect(sourceIdFor({ provider: 'codex', rootUri: override.rootUri })).toBe(sourceIdFor({ provider: 'codex', rootUri: override.rootUri, stateRootUri: override.rootUri }));
    expect(parseAuthorizedSources([{ ...override, stateRootUri: 'https://invalid.example' }])).toEqual([]);
    const missingState = join(root, 'missing-state');
    expect(discoverDefaultSources({ env: { CODEX_HOME: codexHome, CODEX_SQLITE_HOME: missingState }, homeDirectory: root })[0]?.stateRootUri).toBe(pathToFileURL(missingState).toString());
  });

  it('does not fall back to rollout rows when Codex metadata is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jsonlview-no-state-'));
    cleanup.push(root);
    await writeFile(join(root, 'rollout.jsonl'), JSON.stringify({ type: 'event_msg', id: 'not-a-session' }));
    const provider = createSessionNavigatorProvider({ provider: 'codex', rootUri: pathToFileURL(root).toString() });
    await expect(provider.scan(new AbortController().signal, { maxEntities: 10, maxRelations: 10, maxRecords: 10, maxFiles: 4, maxBytes: 100_000, maxMilliseconds: 2_000 })).rejects.toThrow('state database was not found');
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
    const setting: AuthorizedSourceSetting = { provider: 'generic', rootUri: pathToFileURL(root).toString() };
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
    const stored = first.replaceSnapshot(sourceId, { ...scan.snapshot, truncated: true, truncatedReason: 'record_limit' }, scan.fingerprint);
    expect(stored.sourceGeneration).toBe('g-1');
    expect(first.listSources()[0]).toMatchObject({ sourceId, provider: 'claude', entityCount: 1 });
    first.close();

    const reopened = await CatalogStore.open(dbPath);
    expect(reopened.listSources()[0]).toMatchObject({ sourceId, generation: 'g-1', entityCount: 1, truncated: true });
    const children = reopened.getChildren(sourceId);
    expect(children.map((entity) => entity.nativeId)).toEqual(['s-1']);
    expect(reopened.getLocation({ sourceId, generation: 'g-1', nativeId: 's-1' })).toMatchObject({ relativePath: 'events.ndjson', rowOrdinal: '0' });
    expect(reopened.getLocation({ sourceId, generation: 'g-0', nativeId: 's-1' })).toBeUndefined();
    reopened.replaceSnapshot(sourceId, { ...scan.snapshot, truncated: false }, scan.fingerprint);
    expect(reopened.listSources()[0]?.truncated).toBe(false);
    reopened.close();
  });

  it('orders by provider activity by default and keeps product titles separate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jsonlview-session-order-'));
    cleanup.push(root);
    const dbPath = join(root, 'catalog.sqlite');
    const setting: AuthorizedSourceSetting = { provider: 'generic', rootUri: pathToFileURL(root).toString() };
    const sourceId = sourceIdFor(setting);
    const store = await CatalogStore.open(dbPath);
    store.syncSources([setting]);
    store.replaceSnapshot(sourceId, {
      schemaVersion: 1, provider: 'generic', sourceId, sourceGeneration: 'scan-1', snapshotId: 'snapshot-1',
      capturedAt: '2026-10-08T00:00:00.000Z', redaction: 'metadata-only', truncated: false,
      entities: [
        { sourceId, nativeId: 'old', kind: 'session', label: 'Old', vendorTitle: 'Old', titleSource: 'provider', startedAt: '2026-10-01T00:00:00.000Z', activityAt: '2026-10-02T00:00:00.000Z', relationship: 'root', confidence: 'source' },
        { sourceId, nativeId: 'new', kind: 'session', label: 'New', vendorTitle: 'New', titleSource: 'provider', startedAt: '2026-10-01T00:00:00.000Z', activityAt: '2026-10-07T00:00:00.000Z', relationship: 'root', confidence: 'source' },
      ],
      relations: [],
      locations: [
        { nativeId: 'old', relativePath: 'old.jsonl', rowOrdinal: '0' },
        { nativeId: 'new', relativePath: 'new.jsonl', rowOrdinal: '0' },
      ],
    }, 'fingerprint-1');
    expect(store.getChildren(sourceId).map((entity) => entity.nativeId)).toEqual(['new', 'old']);
    expect(store.getChildren(sourceId, undefined, 'title').map((entity) => entity.nativeId)).toEqual(['new', 'old']);
    store.setProductTitle(sourceId, 'old', 'Pinned investigation');
    expect(store.getChildren(sourceId, undefined, 'title').map((entity) => entity.label)).toEqual(['New', 'Pinned investigation']);
    expect(store.getChildren(sourceId, undefined, 'title')[1]).toMatchObject({ productTitle: 'Pinned investigation', vendorTitle: 'Old', titleSource: 'provider' });
    store.clearProductTitle(sourceId, 'old');
    store.close();
  });

  it('reads Codex state metadata and spawn edges without writing the provider database', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jsonlview-codex-native-'));
    cleanup.push(root);
    const sessions = join(root, 'sessions');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(sessions));
    const rollout = join(sessions, 'rollout-2026-10-08T00-00-00-child.jsonl');
    await writeFile(rollout, JSON.stringify({ private: 'body' }), 'utf8');
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(root, 'state_5.sqlite'));
    db.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, title TEXT NOT NULL, preview TEXT NOT NULL,
        recency_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE thread_spawn_edges (parent_thread_id TEXT NOT NULL, child_thread_id TEXT PRIMARY KEY, status TEXT NOT NULL);
    `);
    db.prepare('INSERT INTO threads(id, rollout_path, created_at, updated_at, title, preview, recency_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('root-1', join(sessions, 'root.jsonl'), 1_000, 1_100, 'Root title', 'root preview', 1_200);
    db.prepare('INSERT INTO threads(id, rollout_path, created_at, updated_at, title, preview, recency_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('child-1', rollout, 1_300, 1_500, '', 'child preview', 1_600);
    db.prepare('INSERT INTO thread_spawn_edges(parent_thread_id, child_thread_id, status) VALUES (?, ?, ?)').run('root-1', 'child-1', 'open');
    db.close();

    const setting: AuthorizedSourceSetting = { provider: 'codex', rootUri: pathToFileURL(root).toString() };
    const result = await createSessionNavigatorProvider(setting).scan(new AbortController().signal, {
      maxEntities: 10, maxRelations: 10, maxRecords: 10, maxFiles: 4, maxBytes: 100_000, maxMilliseconds: 2_000,
    });
    expect(result.snapshot.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ nativeId: 'child-1', firstMessagePreview: 'child preview', relationship: 'subagent', parentNativeId: 'root-1' }),
    ]));
    expect(result.snapshot.relations).toEqual(expect.arrayContaining([expect.objectContaining({ fromNativeId: 'child-1', toNativeId: 'root-1', kind: 'parent' })]));
    expect(JSON.stringify(result.snapshot)).not.toContain('private');

    const stateFileSetting: AuthorizedSourceSetting = { provider: 'codex', rootUri: pathToFileURL(join(root, 'state_5.sqlite')).toString() };
    const stateFileResult = await createSessionNavigatorProvider(stateFileSetting).scan(new AbortController().signal, {
      maxEntities: 10, maxRelations: 10, maxRecords: 10, maxFiles: 4, maxBytes: 100_000, maxMilliseconds: 2_000,
    });
    expect(stateFileResult.snapshot.entities).toEqual(expect.arrayContaining([expect.objectContaining({ nativeId: 'child-1', relationship: 'subagent' })]));

    const stateHome = join(root, 'separate-state');
    await mkdir(stateHome);
    await copyFile(join(root, 'state_5.sqlite'), join(stateHome, 'state_5.sqlite'));
    await writeFile(join(root, 'session_index.jsonl'), JSON.stringify({ thread_id: 'child-1', thread_name: 'Title in provider home' }));
    const separated = createSessionNavigatorProvider({ ...setting, stateRootUri: pathToFileURL(stateHome).toString() });
    const separatedResult = await separated.scan(new AbortController().signal, { maxEntities: 10, maxRelations: 10, maxRecords: 10, maxFiles: 4, maxBytes: 100_000, maxMilliseconds: 2_000 });
    expect(separatedResult.snapshot.entities).toEqual(expect.arrayContaining([expect.objectContaining({ nativeId: 'child-1', vendorTitle: 'Title in provider home' })]));
    const legacy = createSessionNavigatorProvider({ provider: 'codex', rootUri: pathToFileURL(sessions).toString() });
    const legacyResult = await legacy.scan(new AbortController().signal, { maxEntities: 10, maxRelations: 10, maxRecords: 10, maxFiles: 4, maxBytes: 100_000, maxMilliseconds: 2_000 });
    expect(legacyResult.snapshot.entities).toEqual(expect.arrayContaining([expect.objectContaining({ nativeId: 'child-1', vendorTitle: 'Title in provider home' })]));
  });

  it('detects WAL-only commits and reads committed metadata without checkpointing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jsonlview-wal-'));
    cleanup.push(root);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(root, 'state_5.sqlite'));
    try {
      db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE threads (id TEXT, rollout_path TEXT, updated_at INTEGER, title TEXT);');
      db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?)').run('s1', join(root, 's1.jsonl'), 1000, 'Before');
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      const provider = createSessionNavigatorProvider({ provider: 'codex', rootUri: pathToFileURL(root).toString() });
      const before = await provider.probe(new AbortController().signal);
      const mainBytes = await readFile(join(root, 'state_5.sqlite'));
      db.exec("UPDATE threads SET title='After', updated_at=2000");
      expect(await readFile(join(root, 'state_5.sqlite'))).toEqual(mainBytes);
      expect(await provider.probe(new AbortController().signal)).not.toBe(before);
      const snapshot = await provider.scan(new AbortController().signal, { maxEntities: 10, maxRelations: 10, maxRecords: 10, maxFiles: 4, maxBytes: 100_000, maxMilliseconds: 2_000 });
      expect(snapshot.snapshot.entities[0]?.vendorTitle).toBe('After');
      expect(await readFile(join(root, 'state_5.sqlite'))).toEqual(mainBytes);
    } finally { db.close(); }
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

  it('keeps Claude message UUIDs out of the session identity graph', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jsonlview-claude-session-'));
    cleanup.push(root);
    await writeFile(join(root, 'session.jsonl'), [
      JSON.stringify({ type: 'user', sessionId: 'session-1', id: 'message-1', parentUuid: 'message-0', customTitle: 'Claude session' }),
      JSON.stringify({ type: 'assistant', sessionId: 'session-1', id: 'message-2', parentUuid: 'message-1', summary: 'message summary' }),
    ].join('\n'), 'utf8');
    const result = await createSessionNavigatorProvider({ provider: 'claude', rootUri: pathToFileURL(root).toString() }).scan(new AbortController().signal, {
      maxEntities: 10, maxRelations: 10, maxRecords: 20, maxFiles: 4, maxBytes: 100_000, maxMilliseconds: 2_000,
    });
    expect(result.snapshot.entities.map((entity) => entity.nativeId)).toEqual(['session-1']);
    expect(result.snapshot.relations).toEqual([]);
  });
});
