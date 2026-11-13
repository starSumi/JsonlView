import { appendFile, mkdir, mkdtemp, opendir, open, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { opendirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KimiSessionNavigatorProvider } from '../../src/experimental/session-navigator/kimi-provider';
import { createSessionNavigatorProvider } from '../../src/experimental/session-navigator/provider-factory';
import { discoverDefaultSources, mergeSourceSettings, parseAuthorizedSources } from '../../src/experimental/session-navigator/source-config';
import { DEFAULT_SESSION_NAVIGATOR_BUDGET as defaults } from '../../src/experimental/session-navigator/types';

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, open: vi.fn(original.open), opendir: vi.fn(original.opendir) };
});
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return { ...original, opendirSync: vi.fn(original.opendirSync) };
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
  return sessionInWorkspace('wd_synthetic_0123456789ab', id, state, agentIds, legacy);
}

async function sessionInWorkspace(workspace: string, id: string, state: unknown, agentIds = ['main'], legacy = false): Promise<string> {
  const path = join(root, 'sessions', workspace, id);
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

async function setActivity(path: string, timestamp: string): Promise<void> {
  const activity = new Date(timestamp);
  await Promise.all([
    utimes(join(path, 'state.json'), activity, activity),
    utimes(join(path, 'agents', 'main', 'wire.jsonl'), activity, activity),
  ]);
}

function journalEvent(type: string, payload: Record<string, unknown>, seq = 1): unknown {
  return { kind: 'event', seq, envelope: { type, seq, timestamp: '2026-01-02T00:00:00.000Z', payload } };
}

function journalEventInEpoch(type: string, payload: Record<string, unknown>, epoch: string, seq = 1): unknown {
  const value = journalEvent(type, payload, seq) as { kind: string; seq: number; envelope: Record<string, unknown> };
  return { ...value, envelope: { ...value.envelope, epoch } };
}

async function serverJournal(id: string, records: readonly unknown[] = []): Promise<string> {
  const path = join(root, 'server', 'events', 'session_' + id + '.jsonl');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, [JSON.stringify({ kind: 'journal_header', version: 1, epoch: 'ep_synthetic', created_at: 1_700_000_000_000 }), ...records.map((value) => JSON.stringify(value))].join('\n') + '\n');
  return path;
}

function serverProvider(events = false): KimiSessionNavigatorProvider {
  return new KimiSessionNavigatorProvider({ provider: 'kimi', rootUri: pathToFileURL(join(root, 'server', ...(events ? ['events'] : []))).toString() });
}

describe('Kimi server journal Navigator provider', () => {
  it('keeps explicitly configured server and events roots beside the detected home', async () => {
    await serverJournal('explicit');
    const home = { provider: 'kimi' as const, rootUri: pathToFileURL(root).toString() };
    const configured = [home, ...[join(root, 'server'), join(root, 'server', 'events')].map((path) => ({ provider: 'kimi' as const, rootUri: pathToFileURL(path).toString() }))];
    expect(mergeSourceSettings(configured, [home])).toEqual(configured);
    await rm(join(root, 'server'), { recursive: true });
    expect(mergeSourceSettings(configured, [home])).toEqual(configured);
    expect(discoverDefaultSources({ env: { KIMI_CODE_HOME: root }, homeDirectory: root }).filter((source) => source.provider === 'kimi')).toEqual([home]);
  });

  it('does not classify empty or unrelated events directories as Kimi server roots', async () => {
    const server = join(root, 'server');
    const events = join(server, 'events');
    await mkdir(events, { recursive: true });
    const discoverKimi = (path: string) => discoverDefaultSources({ env: { KIMI_CODE_HOME: path }, homeDirectory: root }).filter((source) => source.provider === 'kimi');
    expect(discoverKimi(server)).toEqual([]);
    await writeFile(join(events, 'unrelated.jsonl'), 'DO_NOT_READ');
    await writeFile(join(events, 'session_.jsonl'), 'DO_NOT_READ');
    expect(discoverKimi(server)).toEqual([]);
    vi.mocked(open).mockClear();
    await writeFile(join(events, 'session_detected.jsonl'), 'DO_NOT_READ');
    expect(discoverKimi(server)).toEqual([{ provider: 'kimi', rootUri: pathToFileURL(server).toString() }]);
    expect(discoverKimi(events)).toEqual([{ provider: 'kimi', rootUri: pathToFileURL(events).toString() }]);
    expect(vi.mocked(open)).not.toHaveBeenCalled();
  });

  it('does not discover Kimi homes through linked roots or linked sessions directories', async () => {
    const linkedHome = join(root, 'linked-home');
    await symlink(root, linkedHome, process.platform === 'win32' ? 'junction' : 'dir');
    const linkedSessionsHome = join(root, 'linked-sessions-home');
    await mkdir(linkedSessionsHome);
    await symlink(join(root, 'sessions'), join(linkedSessionsHome, 'sessions'), process.platform === 'win32' ? 'junction' : 'dir');
    const discoverKimi = (path: string) => discoverDefaultSources({ env: { KIMI_CODE_HOME: path }, homeDirectory: root }).filter((source) => source.provider === 'kimi');
    expect(discoverKimi(linkedHome)).toEqual([]);
    expect(discoverKimi(linkedSessionsHome)).toEqual([]);
  });

  it('caps synchronous server-root discovery before opening a large directory fully', async () => {
    const server = join(root, 'bounded-server');
    const events = join(server, 'events');
    await mkdir(events, { recursive: true });
    const readSync = vi.fn(() => ({ name: 'unrelated.jsonl', isFile: () => true, isSymbolicLink: () => false }));
    const closeSync = vi.fn();
    vi.mocked(opendirSync).mockReturnValueOnce({ readSync, closeSync } as unknown as ReturnType<typeof opendirSync>);
    const sources = discoverDefaultSources({ env: { KIMI_CODE_HOME: server }, homeDirectory: root }).filter((source) => source.provider === 'kimi');
    expect(sources).toEqual([]);
    expect(readSync).toHaveBeenCalledTimes(16_384);
    expect(closeSync).toHaveBeenCalledOnce();
  });

  it('merges the home server layout by exact session id while retaining legacy subagents and paging', async () => {
    await sessionInWorkspace('wd_synthetic_0123456789ab', 'session_match-123', {
      title: 'Legacy title', agents: { main: {}, worker: { parentAgentId: 'main' } },
    }, ['main', 'worker']);
    await serverJournal('match-123', [journalEvent('session.meta.updated', { patch: { title: 'Server title', lastPrompt: 'Latest server prompt' } })]);
    await serverJournal('server-only', [journalEvent('session.meta.updated', { patch: { title: 'Server-only session' } })]);

    const pages = [];
    let page = await provider.scanPage(signal(), { ...defaults, maxFiles: 1 });
    pages.push(page);
    while (page.nextCursor !== undefined) {
      page = await provider.scanPage(signal(), { ...defaults, maxFiles: 1 }, page.nextCursor);
      pages.push(page);
    }
    const entities = pages.flatMap((result) => result.snapshot.entities);
    const main = entities.find((entity) => entity.vendorTitle === 'Server title')!;
    const child = entities.find((entity) => entity.kind === 'subagent')!;
    expect(entities).toHaveLength(3);
    expect(main.nativeId).toBe(child.parentNativeId);
    expect(main.firstMessagePreview).toBe('Latest server prompt');
    expect(entities.map((entity) => entity.label)).toContain('Server-only session');
    expect(pages.flatMap((result) => result.snapshot.locations).find((location) => location.nativeId === main.nativeId)?.relativePath)
      .toBe('server/events/session_match-123.jsonl');
    expect(pages.flatMap((result) => result.snapshot.locations).find((location) => location.nativeId === child.nativeId)?.relativePath)
      .toBe('sessions/wd_synthetic_0123456789ab/session_match-123/agents/worker/wire.jsonl');
    expect(pages.flatMap((result) => result.snapshot.relations)).toContainEqual(expect.objectContaining({ fromNativeId: main.nativeId, toNativeId: child.nativeId }));
  });

  it('uses legacy state as bounded fallback when a matched server journal omits title metadata', async () => {
    await sessionInWorkspace('wd_synthetic_0123456789ab', 'session_fallback-123', {
      title: 'Legacy fallback title', lastPrompt: 'Legacy fallback prompt', agents: { main: {} },
    }, ['main']);
    await serverJournal('fallback-123', [journalEvent('event.session.status_changed', { status: 'running' })]);
    const result = await provider.scan(signal(), defaults);
    expect(result.snapshot.entities).toHaveLength(1);
    expect(result.snapshot.entities[0]).toMatchObject({
      vendorTitle: 'Legacy fallback title', firstMessagePreview: 'Legacy fallback prompt', status: 'running',
    });
    expect(result.snapshot.locations[0]?.relativePath).toBe('server/events/session_fallback-123.jsonl');
    expect(vi.mocked(open).mock.calls.map((call) => call[0])).toContain(join(root, 'sessions', 'wd_synthetic_0123456789ab', 'session_fallback-123', 'state.json'));
    const limited = await provider.scan(signal(), { ...defaults, maxRecords: 1 });
    expect(limited.snapshot.entities[0]?.vendorTitle).toBe('Legacy fallback title');
    expect(limited.snapshot.truncated).toBe(true);
  });

  it('keeps server parent identity when only a legacy subagent wire exists', async () => {
    await sessionInWorkspace('wd_synthetic_0123456789ab', 'session_child-only-123', {
      title: 'Legacy parent title', agents: { worker: { parentAgentId: 'main' } },
    }, ['worker']);
    await serverJournal('child-only-123', [journalEvent('session.meta.updated', { patch: { title: 'Server parent title' } })]);
    const result = await provider.scan(signal(), defaults);
    const main = result.snapshot.entities.find((entity) => entity.kind === 'session');
    const child = result.snapshot.entities.find((entity) => entity.kind === 'subagent');
    expect(main).toBeDefined();
    expect(child?.parentNativeId).toBe(main?.nativeId);
    expect(result.snapshot.relations).toContainEqual(expect.objectContaining({ fromNativeId: main?.nativeId, toNativeId: child?.nativeId }));
  });

  it('projects only bounded metadata from server journals without optional envelope identity fields', async () => {
    const path = await serverJournal('metadata', [
      journalEvent('event.session.created', { session: { title: 'Old title', created_at: '2025-01-01T00:00:00.000Z', updated_at: '2025-01-02T00:00:00.000Z', last_prompt: 'Old prompt', metadata: { secret: 'DO_NOT_PROJECT' } } }),
      journalEvent('session.meta.updated', { type: 'misleading.type', patch: { title: 'Latest title', lastPrompt: 'Latest prompt', secret: 'DO_NOT_PROJECT' } }, 2),
      journalEvent('event.session.status_changed', { status: 'running' }, 3),
      journalEvent('tool.result', { output: 'PRIVATE_TOOL_OUTPUT', command: 'DO_NOT_EXECUTE' }, 4),
    ]);
    await writeFile(join(root, 'server', 'events', '__global__.jsonl'), 'DO_NOT_READ');
    await mkdir(join(root, 'server', 'instances'));
    await writeFile(join(root, 'server', 'instances', 'instance.json'), 'DO_NOT_READ');
    await writeFile(join(root, 'server', 'server.token'), 'DO_NOT_READ');
    await writeFile(join(root, 'server', 'server.log'), 'DO_NOT_READ');
    const result = await serverProvider().scan(signal(), defaults);
    expect(result.snapshot.entities).toHaveLength(1);
    expect(result.snapshot.entities[0]).toMatchObject({ label: 'Latest title', firstMessagePreview: 'Latest prompt', status: 'running', startedAt: '2025-01-01T00:00:00.000Z', activityAt: '2026-01-02T00:00:00.000Z' });
    expect(result.snapshot.locations).toEqual([{ nativeId: result.snapshot.entities[0]!.nativeId, relativePath: 'events/session_metadata.jsonl', rowOrdinal: '0' }]);
    expect(vi.mocked(open).mock.calls.map((call) => call[0])).toEqual([path]);
    expect(JSON.stringify(result.snapshot)).not.toMatch(/PRIVATE_|DO_NOT_|misleading/);
    expect((await serverProvider(true).scan(signal(), defaults)).snapshot.locations[0]?.relativePath).toBe('session_metadata.jsonl');
  });

  it('samples both ends for current metadata and keeps directory pagination resumable', async () => {
    const filler = Array.from({ length: 30 }, (_, index) => journalEventInEpoch('tool.result', { output: 'PRIVATE_' + 'x'.repeat(5_000) }, 'ep_synthetic', index + 2));
    const first = await serverJournal('sampled', [journalEventInEpoch('event.session.created', { session: { title: 'Old title' } }, 'ep_synthetic'), ...filler, journalEventInEpoch('session.meta.updated', { patch: { title: 'Tail title', lastPrompt: 'Tail prompt' } }, 'ep_synthetic', 33)]);
    const second = await serverJournal('next', [journalEvent('event.session.created', { session: { title: 'Next page' } })]);
    await utimes(first, new Date('2026-01-02'), new Date('2026-01-02'));
    await utimes(second, new Date('2026-01-01'), new Date('2026-01-01'));
    const current = serverProvider();
    const page = await current.scanPage(signal(), { ...defaults, maxFiles: 1 });
    expect(page.snapshot.entities[0]).toMatchObject({ label: 'Tail title', firstMessagePreview: 'Tail prompt' });
    expect(page.snapshot.truncated).toBe(true);
    expect(page.nextCursor).toBeDefined();
    const next = await current.scanPage(signal(), { ...defaults, maxFiles: 1 }, page.nextCursor);
    expect(next.snapshot.entities[0]?.label).toBe('Next page');
    expect(next.nextCursor).toBeUndefined();
  });

  it('invalidates server continuations after an append without reusing a stale probe', async () => {
    const path = await serverJournal('changed', [journalEvent('event.session.created', { session: { title: 'Before append' } })]);
    await serverJournal('other');
    const current = serverProvider();
    const page = await current.scanPage(signal(), { ...defaults, maxFiles: 1 });
    await appendFile(path, JSON.stringify(journalEvent('session.meta.updated', { patch: { title: 'After append' } }, 2)) + '\n');
    await expect(current.scanPage(signal(), defaults, page.nextCursor)).rejects.toMatchObject({ code: 'SESSION_SOURCE_CHANGED' });
    expect((await current.scan(signal(), defaults)).snapshot.entities.map((entity) => entity.label)).toContain('After append');
  });

  it('honors byte, record, file, entity, cancellation and deadline budgets', async () => {
    await serverJournal('a', [journalEvent('session.meta.updated', { patch: { title: 'A' } })]);
    await serverJournal('b', [journalEvent('session.meta.updated', { patch: { title: 'B' } })]);
    const current = serverProvider();
    for (const limits of [{ maxBytes: 0 }, { maxRecords: 0 }, { maxFiles: 0 }, { maxEntities: 0 }, { maxMilliseconds: 0 }]) {
      vi.mocked(open).mockClear();
      const page = await current.scan(signal(), { ...defaults, ...limits });
      expect(page.snapshot.entities).toEqual([]);
      expect(page.snapshot.truncated).toBe(true);
      expect(vi.mocked(open)).not.toHaveBeenCalled();
    }
    const limited = await current.scanPage(signal(), { ...defaults, maxRecords: 1 });
    expect(limited.snapshot.entities).toHaveLength(1);
    expect(limited.nextCursor).toBeDefined();
    const cancelled = new AbortController(); cancelled.abort();
    await expect(current.scan(cancelled.signal, defaults)).rejects.toThrow('cancelled');
  });

  it('reserves bounded record inspection for tail metadata even in a small file', async () => {
    await serverJournal('record-tail', [
      journalEventInEpoch('event.session.created', { session: { title: 'Old title' } }, 'ep_synthetic'),
      ...Array.from({ length: 20 }, (_, index) => journalEventInEpoch('tool.result', { output: 'inert' }, 'ep_synthetic', index + 2)),
      journalEventInEpoch('session.meta.updated', { patch: { title: 'Tail under record limit' } }, 'ep_synthetic', 22),
    ]);
    const result = await serverProvider().scan(signal(), { ...defaults, maxRecords: 2 });
    expect(result.snapshot.entities[0]?.label).toBe('Tail under record limit');
    expect(result.snapshot.truncated).toBe(true);
  });

  it('splits a constrained byte budget between header and current tail metadata', async () => {
    await serverJournal('byte-tail', [
      journalEventInEpoch('event.session.created', { session: { title: 'Old title' } }, 'ep_synthetic'),
      journalEventInEpoch('tool.result', { output: 'PRIVATE_' + 'x'.repeat(100_000) }, 'ep_synthetic', 2),
      journalEventInEpoch('session.meta.updated', { patch: { title: 'Latest within bytes' } }, 'ep_synthetic', 3),
    ]);
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let bytesRead = 0;
    vi.mocked(open).mockImplementationOnce(async (path, flags) => {
      const handle = await actual.open(path, flags);
      const read = handle.read.bind(handle);
      vi.spyOn(handle, 'read').mockImplementation(async (...args: Parameters<typeof handle.read>) => {
        const result = await read(...args); bytesRead += result.bytesRead; return result;
      });
      return handle;
    });
    const result = await serverProvider().scan(signal(), { ...defaults, maxBytes: 8_192 });
    expect(bytesRead).toBe(8_192);
    expect(result.snapshot.entities[0]?.label).toBe('Latest within bytes');
    expect(result.snapshot.truncated).toBe(true);
    expect(JSON.stringify(result.snapshot)).not.toContain('PRIVATE_');
  });

  it('isolates unreadable metadata and continues to healthy sibling journals', async () => {
    const unreadable = await serverJournal('unreadable');
    await serverJournal('healthy', [journalEvent('session.meta.updated', { patch: { title: 'Healthy journal' } })]);
    await utimes(unreadable, new Date('2030-01-01'), new Date('2030-01-01'));
    vi.mocked(open).mockRejectedValueOnce(Object.assign(new Error('access denied'), { code: 'EACCES' }));
    const result = await serverProvider().scan(signal(), defaults);
    expect(result.snapshot.entities).toHaveLength(2);
    expect(result.snapshot.truncated).toBe(true);
    expect(result.snapshot.entities.map((entity) => entity.label)).toContain('Healthy journal');
  });

  it('rejects a journal replaced between inventory and open before reading bytes', async () => {
    await serverJournal('replaced');
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const reads = vi.fn();
    vi.mocked(open).mockImplementationOnce(async (path, flags) => {
      await writeFile(path, 'REPLACED_BODY_NOT_READ');
      const handle = await actual.open(path, flags);
      vi.spyOn(handle, 'read').mockImplementation(reads);
      return handle;
    });
    await expect(serverProvider().scan(signal(), defaults)).rejects.toMatchObject({ code: 'SESSION_SOURCE_CHANGED' });
    expect(reads).not.toHaveBeenCalled();
  });

  it('preserves malformed or unsupported journals without treating their payload as metadata', async () => {
    const invalid = await serverJournal('invalid', [journalEvent('session.meta.updated', { patch: { title: 'DO_NOT_PROJECT' } })]);
    await writeFile(invalid, JSON.stringify({ kind: 'journal_header', version: 2, epoch: 'ep_future' }) + '\n' + JSON.stringify(journalEvent('session.meta.updated', { patch: { title: 'DO_NOT_PROJECT' } })) + '\n');
    const mismatched = await serverJournal('mismatch', [{ kind: 'event', seq: 1, envelope: { type: 'session.meta.updated', seq: 1, session_id: 'session_other', timestamp: 'invalid', payload: { patch: { title: 'DO_NOT_PROJECT' } } } }]);
    const sequenceMismatch = await serverJournal('sequence-mismatch', [
      { kind: 'event', seq: 1, envelope: { type: 'session.meta.updated', seq: 2, timestamp: '2026-01-02T00:00:00.000Z', payload: { patch: { title: 'DO_NOT_PROJECT' } } } },
      { kind: 'event', seq: 2, envelope: { type: 'session.meta.updated', seq: Number.MAX_SAFE_INTEGER + 1, timestamp: '2026-01-02T00:00:00.000Z', payload: { patch: { title: 'DO_NOT_PROJECT' } } } },
      { kind: 'event', seq: 3, envelope: { type: 'session.meta.updated', timestamp: '2026-01-02T00:00:00.000Z', payload: { patch: { title: 'DO_NOT_PROJECT' } } } },
    ]);
    const result = await serverProvider().scan(signal(), defaults);
    expect(result.snapshot.entities).toHaveLength(3);
    expect(result.snapshot.truncated).toBe(true);
    expect(JSON.stringify(result.snapshot)).not.toContain('DO_NOT_PROJECT');
    expect(result.snapshot.locations.map((location) => location.relativePath)).toEqual(expect.arrayContaining(['events/' + invalid.split(/[\\/]/).at(-1), 'events/' + mismatched.split(/[\\/]/).at(-1), 'events/' + sequenceMismatch.split(/[\\/]/).at(-1)]));
  });

  it('uses the latest valid header as the recovery epoch boundary', async () => {
    const path = await serverJournal('recovered', [journalEvent('session.meta.updated', { patch: { title: 'Old epoch title' } })]);
    const oldHeader = JSON.stringify({ kind: 'journal_header', version: 1, epoch: 'ep_old', created_at: 1_700_000_000_000 });
    const newHeader = JSON.stringify({ kind: 'journal_header', version: 1, epoch: 'ep_new', created_at: 1_800_000_000_000 });
    const oldEvent = JSON.stringify(journalEvent('session.meta.updated', { patch: { title: 'Must not cross epoch' } }, 1));
    const newEvent = JSON.stringify(journalEvent('session.meta.updated', { patch: { title: 'Recovered latest epoch' } }, 1));
    await writeFile(path, ['corrupt prefix', oldHeader, oldEvent, 'still corrupt', newHeader, newEvent].join('\n') + '\n');
    const result = await serverProvider().scan(signal(), defaults);
    expect(result.snapshot.entities[0]).toMatchObject({ label: 'Recovered latest epoch', startedAt: '2027-01-15T08:00:00.000Z' });
    expect(JSON.stringify(result.snapshot)).not.toContain('Must not cross epoch');
  });

  it('does not mix sampled metadata when a new epoch header falls inside the head-tail gap', async () => {
    const path = await serverJournal('epoch-gap');
    const oldHeader = JSON.stringify({ kind: 'journal_header', version: 1, epoch: 'ep_old', created_at: 1_700_000_000_000 });
    const newHeader = JSON.stringify({ kind: 'journal_header', version: 1, epoch: 'ep_new', created_at: 1_800_000_000_000 });
    const oldTitle = JSON.stringify(journalEventInEpoch('session.meta.updated', { patch: { title: 'Old epoch title' } }, 'ep_old'));
    const oldFiller = JSON.stringify(journalEventInEpoch('tool.result', { output: 'old_' + 'x'.repeat(10_000) }, 'ep_old', 2));
    const newFiller = JSON.stringify(journalEventInEpoch('tool.result', { output: 'new_' + 'y'.repeat(10_000) }, 'ep_new', 1));
    const newTitle = JSON.stringify(journalEventInEpoch('session.meta.updated', { patch: { title: 'Recovered from tail epoch' } }, 'ep_new', 2));
    await writeFile(path, [oldHeader, oldTitle, ...Array(9).fill(oldFiller), newHeader, ...Array(8).fill(newFiller), newTitle].join('\n') + '\n');
    const result = await serverProvider().scan(signal(), defaults);
    expect(result.snapshot.entities[0]?.vendorTitle).toBe('Recovered from tail epoch');
    expect(result.snapshot.entities[0]).not.toHaveProperty('startedAt');
    expect(result.snapshot.truncated).toBe(true);
    expect(JSON.stringify(result.snapshot)).not.toContain('Old epoch title');
  });

  it('validates optional volatile and offset envelope fields without rejecting valid annotations', async () => {
    await serverJournal('volatile-shape', [
      { kind: 'event', seq: 1, envelope: { type: 'session.meta.updated', seq: 1, volatile: true, offset: 0, timestamp: '2026-01-02T00:00:00.000Z', payload: { patch: { title: 'Valid annotation' } } } },
      { kind: 'event', seq: 2, envelope: { type: 'session.meta.updated', seq: 2, volatile: 'true', timestamp: '2026-01-02T00:00:00.000Z', payload: { patch: { title: 'DO_NOT_PROJECT' } } } },
      { kind: 'event', seq: 3, envelope: { type: 'session.meta.updated', seq: 3, offset: -1, timestamp: '2026-01-02T00:00:00.000Z', payload: { patch: { title: 'DO_NOT_PROJECT' } } } },
      { kind: 'event', seq: 4, envelope: { type: 'session.meta.updated', seq: 4, offset: 1.5, timestamp: '2026-01-02T00:00:00.000Z', payload: { patch: { title: 'DO_NOT_PROJECT' } } } },
    ]);
    const result = await serverProvider().scan(signal(), defaults);
    expect(result.snapshot.entities[0]?.label).toBe('Valid annotation');
    expect(result.snapshot.truncated).toBe(true);
    expect(JSON.stringify(result.snapshot)).not.toContain('DO_NOT_PROJECT');
  });

  it('does not follow journal links or linked events directories', async () => {
    const path = await serverJournal('actual');
    await symlink(path, join(dirname(path), 'session_linked.jsonl'), process.platform === 'win32' ? 'file' : 'file');
    expect((await serverProvider().scan(signal(), defaults)).snapshot.entities).toHaveLength(1);
    const linkedRoot = join(root, 'linked-server');
    await mkdir(linkedRoot);
    await symlink(dirname(path), join(linkedRoot, 'events'), process.platform === 'win32' ? 'junction' : 'dir');
    expect((await new KimiSessionNavigatorProvider({ provider: 'kimi', rootUri: pathToFileURL(linkedRoot).toString() }).scan(signal(), defaults)).snapshot.entities).toEqual([]);
  });
});

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

  it('uses the latest prompt instead of a replaceable New Session title', async () => {
    await session('replaceable', { title: 'New Session', titleKind: 'replaceable', lastPrompt: 'A recent prompt preview' });
    const result = await provider.scan(signal(), defaults);

    expect(result.snapshot.entities[0]).toMatchObject({
      label: 'A recent prompt preview', titleSource: 'first-message', firstMessagePreview: 'A recent prompt preview',
    });
    expect(result.snapshot.entities[0]).not.toHaveProperty('vendorTitle');
  });

  it('keeps malformed status metadata from aborting discovery of a healthy sibling', async () => {
    await session('a-malformed-status', { title: 'Malformed status', lastTurnReason: { toString: 0 } });
    await session('b-healthy', { title: 'Healthy sibling', lastTurnReason: 'completed' });
    const result = await provider.scan(signal(), defaults);
    expect(result.snapshot.entities).toHaveLength(2);
    const malformed = result.snapshot.entities.find((entity) => entity.label === 'Malformed status');
    const healthy = result.snapshot.entities.find((entity) => entity.label === 'Healthy sibling');
    expect(malformed).not.toHaveProperty('status');
    expect(healthy).toMatchObject({ status: 'completed' });
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
    for (const [id, time] of [['c', '2020-01-01T00:00:00.000Z'], ['a', '2021-01-01T00:00:00.000Z'], ['b', '2022-01-01T00:00:00.000Z']] as const) {
      const path = await session(id, { title: id });
      await setActivity(path, time);
    }
    const first = await provider.scanPage(signal(), { ...defaults, maxFiles: 1 });
    const second = await provider.scanPage(signal(), { ...defaults, maxFiles: 1 }, first.nextCursor);
    const third = await provider.scanPage(signal(), { ...defaults, maxFiles: 1 }, second.nextCursor);
    expect([first, second, third].map((page) => page.snapshot.entities[0]!.label)).toEqual(['b', 'a', 'c']);
    expect(new Set([first, second, third].map((page) => page.snapshot.entities[0]!.nativeId)).size).toBe(3);
    expect(third.nextCursor).toBeUndefined();
    expect(await provider.probe(signal())).toBe(first.fingerprint);
    await expect(provider.scanPage(signal(), defaults, 'arbitrary')).rejects.toThrow('malformed');
    await session('d', { title: 'd' });
    await expect(provider.scanPage(signal(), defaults, first.nextCursor)).rejects.toMatchObject({ code: 'SESSION_SOURCE_CHANGED' });
  });

  it('reuses a just-probed inventory for the changed-source first scan', async () => {
    await session('reuse-probe', { title: 'Reuse after probe' });
    vi.mocked(opendir).mockClear();

    const fingerprint = await provider.probe(signal());
    const directoryReadsAfterProbe = vi.mocked(opendir).mock.calls.length;
    const page = await provider.scanPage(signal(), defaults);

    expect(page.fingerprint).toBe(fingerprint);
    expect(vi.mocked(opendir)).toHaveBeenCalledTimes(directoryReadsAfterProbe);
  });

  it('does not consume a probed inventory when the caller fingerprint no longer matches', async () => {
    await session('fingerprint-bound', { title: 'Before change' });
    const probed = await provider.probe(signal());
    await session('fingerprint-changed', { title: 'After change' });
    const page = await provider.scanPage(signal(), defaults, undefined, 'different-' + probed);
    expect(page.fingerprint).not.toBe(probed);
    expect(page.snapshot.entities.map((entity) => entity.label)).toEqual(expect.arrayContaining(['After change']));
  });

  it('places recently active Kimi sessions on the first bounded page', async () => {
    const oldActivity = new Date('2020-01-01T00:00:00.000Z');
    await Promise.all(Array.from({ length: 64 }, async (_, index) => {
      const id = 'session-' + String(index).padStart(2, '0');
      const path = await session(id, { title: 'Older ' + String(index) });
      await setActivity(path, oldActivity.toISOString());
    }));
    const recentPath = await session('session-zz-recent', { title: 'Recent Kimi session' });
    const recentActivity = new Date('2025-01-01T00:00:00.000Z');
    await setActivity(recentPath, recentActivity.toISOString());

    const first = await provider.scanPage(signal(), { ...defaults, maxFiles: 64 });
    expect(first.snapshot.entities.map((entity) => entity.label)).toContain('Recent Kimi session');
    expect(first.nextCursor).toBeDefined();
    const second = await provider.scanPage(signal(), { ...defaults, maxFiles: 64 }, first.nextCursor);
    expect(second.snapshot.entities.map((entity) => entity.label)).toEqual(['Older 63']);
  });

  it('prioritizes recently active workspaces before the discovery budget expires', async () => {
    const oldActivity = new Date('2020-01-01T00:00:00.000Z');
    await Promise.all(Array.from({ length: 72 }, async (_, index) => {
      const workspace = 'wd_old_' + String(index).padStart(2, '0');
      const path = await sessionInWorkspace(workspace, 'session-old-' + String(index), { title: 'Older workspace ' + String(index) });
      await setActivity(path, oldActivity.toISOString());
    }));
    const recentPath = await sessionInWorkspace('wd_zz_recent', 'session-latest', { title: 'Latest workspace session' });
    await setActivity(recentPath, '2025-01-01T00:00:00.000Z');

    const first = await provider.scanPage(signal(), { ...defaults, maxFiles: 1 });
    expect(first.snapshot.entities.map((entity) => entity.label)).toEqual(['Latest workspace session']);
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
    for (const [id, time] of [['a', '2022-01-01T00:00:00.000Z'], ['b', '2021-01-01T00:00:00.000Z'], ['c', '2020-01-01T00:00:00.000Z']] as const) {
      await setActivity(await session(id, { title: id }), time);
    }
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
