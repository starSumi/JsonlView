import { mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KimiSessionNavigatorProvider } from '../../src/experimental/session-navigator/kimi-provider';
import { createSessionNavigatorProvider } from '../../src/experimental/session-navigator/provider-factory';
import { discoverDefaultSources, parseAuthorizedSources } from '../../src/experimental/session-navigator/source-config';
import { DEFAULT_SESSION_NAVIGATOR_BUDGET as defaults } from '../../src/experimental/session-navigator/types';

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, open: vi.fn(original.open) };
});

const signal = (): AbortSignal => new AbortController().signal;
let root: string;
let provider: KimiSessionNavigatorProvider;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'jsonlview-kimi-provider-'));
  await mkdir(join(root, 'sessions'));
  provider = new KimiSessionNavigatorProvider({ provider: 'kimi', rootUri: pathToFileURL(root).toString() });
  vi.mocked(open).mockClear();
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function session(id: string, state: unknown, agentIds = ['main'], legacy = false): Promise<string> {
  const path = join(root, 'sessions', 'wd_synthetic_0123456789ab', id);
  const metadataPath = join(path, ...(legacy ? ['session-meta'] : []), 'state.json');
  await mkdir(dirname(metadataPath), { recursive: true });
  await writeFile(metadataPath, typeof state === 'string' ? state : JSON.stringify(state));
  for (const agentId of agentIds) {
    const wire = join(path, 'agents', agentId, 'wire.jsonl');
    await mkdir(dirname(wire), { recursive: true });
    await writeFile(wire, 'PRIVATE_WIRE_BODY_NEVER_READ\n');
  }
  return path;
}

describe('Kimi metadata-only Navigator provider', () => {
  it('constructs lazily and dispatches only after an explicit setting', () => {
    expect(vi.mocked(open)).not.toHaveBeenCalled();
    expect(createSessionNavigatorProvider({ provider: 'kimi', rootUri: pathToFileURL(root).toString() })).toBeInstanceOf(KimiSessionNavigatorProvider);
    expect(parseAuthorizedSources([{ provider: 'kimi', rootUri: pathToFileURL(root).toString() }])).toHaveLength(1);
    expect(parseAuthorizedSources([{ provider: 'kimi', rootUri: 'https://example.com/home' }])).toEqual([]);
    expect(() => new KimiSessionNavigatorProvider({ provider: 'kimi', rootUri: 'https://example.com/home' })).toThrow('file URIs');
  });

  it('reads current state metadata, preserves parent links and never opens wire or external references', async () => {
    const path = await session('session-a', { id: 'session-a', title: 'Synthetic session', lastPrompt: 'A bounded metadata preview', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_001_000, lastTurnReason: 'cancelled',
      agents: { main: { type: 'main' }, 'agent-0': { type: 'sub', parentAgentId: 'main', homedir: 'DO_NOT_TRAVERSE' }, 'agent-1': { type: 'sub', parentAgentId: 'agent-0' } },
      custom: { secret: 'DO_NOT_PROJECT' }, cwd: 'DO_NOT_PROJECT_PATH' }, ['main', 'agent-0', 'agent-1']);
    await writeFile(join(root, 'session_index.jsonl'), JSON.stringify({ sessionDir: 'DO_NOT_TRAVERSE', sessionId: 'outside' }));
    await writeFile(join(root, 'credentials.json'), 'DO_NOT_READ');
    const result = await provider.scan(signal(), defaults);
    expect(result.snapshot).toMatchObject({ provider: 'kimi', redaction: 'metadata-only', truncated: false });
    expect(result.snapshot.entities).toHaveLength(3);
    const main = result.snapshot.entities.find((entity) => entity.kind === 'session')!;
    const child = result.snapshot.entities.find((entity) => entity.label === 'Kimi agent agent-0')!;
    expect(main).toMatchObject({ label: 'Synthetic session', titleSource: 'provider', firstMessagePreview: 'A bounded metadata preview', status: 'cancelled', startedAt: '2023-11-14T22:13:20.000Z', activityAt: '2023-11-14T22:13:21.000Z' });
    expect(child).toMatchObject({ parentNativeId: main.nativeId, relationship: 'subagent' });
    expect(result.snapshot.relations).toHaveLength(2);
    expect(result.snapshot.locations.every((location) => location.relativePath.endsWith('/wire.jsonl') && location.rowOrdinal === '0')).toBe(true);
    expect(vi.mocked(open).mock.calls.map((call) => call[0])).toEqual([join(path, 'state.json')]);
    expect(JSON.stringify(result.snapshot)).not.toMatch(/PRIVATE_WIRE_BODY|DO_NOT_|credentials|session_index/u);
    expect(await readFile(join(path, 'agents', 'main', 'wire.jsonl'), 'utf8')).toBe('PRIVATE_WIRE_BODY_NEVER_READ\n');
  });

  it('supports the observed legacy metadata directory and ISO clocks', async () => {
    await session('legacy', { customTitle: 'Legacy title', createdAt: '2024-01-01T00:00:00.000Z', updatedAt: 'invalid', agents: { main: {} } }, ['main'], true);
    const result = await provider.scan(signal(), defaults);
    expect(result.snapshot.entities[0]).toMatchObject({ vendorTitle: 'Legacy title', startedAt: '2024-01-01T00:00:00.000Z' });
    expect(result.snapshot.entities[0]).not.toHaveProperty('activityAt');
    expect(result.snapshot.truncated).toBe(false);
  });

  it('keeps malformed status metadata from aborting discovery of a healthy sibling', async () => {
    await session('a-malformed-status', { title: 'Malformed status', lastTurnReason: { toString: 0 } });
    await session('b-healthy', { title: 'Healthy sibling', lastTurnReason: 'completed' });
    const result = await provider.scan(signal(), defaults);
    expect(result.snapshot.entities).toHaveLength(2);
    expect(result.snapshot.entities[0]).toMatchObject({ label: 'Malformed status' });
    expect(result.snapshot.entities[0]).not.toHaveProperty('status');
    expect(result.snapshot.entities[1]).toMatchObject({ label: 'Healthy sibling', status: 'completed' });
    expect(result.snapshot.truncated).toBe(false);
  });

  it('keeps unknown parent agents orphaned and relation bounds explicit', async () => {
    await session('unknown-parent', { title: 'Orphans', agents: { main: {}, 'agent-0': { parentAgentId: '../outside' }, 'agent-1': { parentAgentId: 'main' } } }, ['main', 'agent-0', 'agent-1']);
    const result = await provider.scan(signal(), { ...defaults, maxRelations: 0 });
    expect(result.snapshot.entities.filter((entity) => entity.kind === 'subagent').every((entity) => entity.relationship === 'orphan' && entity.parentNativeId === undefined)).toBe(true);
    expect(result.snapshot.relations).toEqual([]);
    expect(result.snapshot.truncated).toBe(true);
  });

  it('binds continuation to inventory identity and advances stable bounded pages', async () => {
    for (const id of ['c', 'a', 'b']) await session(id, { title: id });
    const first = await provider.scanPage(signal(), { ...defaults, maxFiles: 1 });
    const second = await provider.scanPage(signal(), { ...defaults, maxFiles: 1 }, first.nextCursor);
    const third = await provider.scanPage(signal(), { ...defaults, maxFiles: 1 }, second.nextCursor);
    expect([first, second, third].map((page) => page.snapshot.entities[0]!.label)).toEqual(['a', 'b', 'c']);
    expect(new Set([first, second, third].map((page) => page.snapshot.entities[0]!.nativeId)).size).toBe(3);
    expect(third.nextCursor).toBeUndefined();
    expect(await provider.probe(signal())).toBe(first.fingerprint);
    await expect(provider.scanPage(signal(), defaults, 'arbitrary')).rejects.toThrow('invalid or stale');
    await session('d', { title: 'd' });
    await expect(provider.scanPage(signal(), defaults, first.nextCursor)).rejects.toThrow('invalid or stale');
  });

  it('bounds metadata reads and preserves discoverable malformed or oversized sessions', async () => {
    await session('a-malformed', '{bad');
    await session('b-huge', { title: 'x'.repeat(70_000) });
    await session('c-small', { lastPrompt: 'A'.repeat(800) });
    const result = await provider.scan(signal(), defaults);
    expect(result.snapshot.entities).toHaveLength(3);
    expect(result.snapshot.entities.every((entity) => entity.label.length <= 240)).toBe(true);
    expect(result.snapshot.truncated).toBe(true);
    expect(vi.mocked(open).mock.calls).toHaveLength(2);
    vi.mocked(open).mockClear();
    const empty = await provider.scan(signal(), { ...defaults, maxBytes: 0 });
    expect(empty.snapshot.entities).toEqual([]);
    expect(empty.snapshot.truncated).toBe(true);
    expect(vi.mocked(open)).not.toHaveBeenCalled();
  });

  it('stops record-limited pages without skipping the next session', async () => {
    for (const id of ['a', 'b', 'c']) await session(id, { title: id });
    const first = await provider.scanPage(signal(), { ...defaults, maxRecords: 1 });
    expect(first.snapshot.entities.map((entity) => entity.label)).toEqual(['a']);
    const second = await provider.scanPage(signal(), { ...defaults, maxRecords: 1 }, first.nextCursor);
    expect(second.snapshot.entities.map((entity) => entity.label)).toEqual(['b']);
  });

  it('does not descend session directory links or linked provider homes', async () => {
    const path = await session('actual', { title: 'Only once' });
    const link = join(root, 'sessions', 'wd_synthetic_0123456789ab', 'linked');
    await symlink(path, link, process.platform === 'win32' ? 'junction' : 'dir');
    expect((await provider.scan(signal(), defaults)).snapshot.entities).toHaveLength(1);
    const homeLink = join(root, 'home-link');
    await symlink(root, homeLink, process.platform === 'win32' ? 'junction' : 'dir');
    const linked = new KimiSessionNavigatorProvider({ provider: 'kimi', rootUri: pathToFileURL(homeLink).toString() });
    await expect(linked.scan(signal(), defaults)).rejects.toThrow('regular directory');
  });

  it('honors cancellation and deadline before opening source metadata', async () => {
    await session('a', { title: 'Deadline' });
    const aborted = new AbortController(); aborted.abort();
    await expect(provider.scan(aborted.signal, defaults)).rejects.toThrow('cancelled');
    const result = await provider.scan(signal(), { ...defaults, maxMilliseconds: 0 });
    expect(result.snapshot.entities).toEqual([]);
    expect(result.snapshot.truncated).toBe(true);
    expect(result.snapshot.truncatedReason).toBe('time_limit');
    expect(vi.mocked(open)).not.toHaveBeenCalled();
  });

  it('discovers default and override homes as candidates without scanning their journals', async () => {
    const defaultHome = join(root, '.kimi-code');
    await mkdir(join(defaultHome, 'sessions'), { recursive: true });
    const discovered = discoverDefaultSources({ env: {}, homeDirectory: root });
    expect(discovered.filter((source) => source.provider === 'kimi')).toEqual([{ provider: 'kimi', rootUri: pathToFileURL(defaultHome).toString() }]);
    const override = discoverDefaultSources({ env: { KIMI_CODE_HOME: root }, homeDirectory: root });
    expect(override.filter((source) => source.provider === 'kimi')).toEqual([{ provider: 'kimi', rootUri: pathToFileURL(root).toString() }]);
    expect(vi.mocked(open)).not.toHaveBeenCalled();
  });
});
