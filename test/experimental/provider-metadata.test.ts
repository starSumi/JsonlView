import { mkdir, mkdtemp, readFile, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeSessionNavigatorProvider } from '../../src/experimental/session-navigator/native-provider';
import { collectClaudeFiles } from '../../src/experimental/session-navigator/claude-metadata';
import { MetadataBudget, readMetadataRecords } from '../../src/experimental/session-navigator/provider-metadata';
import { DEFAULT_SESSION_NAVIGATOR_BUDGET } from '../../src/experimental/session-navigator/types';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

const cleanup: string[] = [];
const signal = () => new AbortController().signal;
const limits = { ...DEFAULT_SESSION_NAVIGATOR_BUDGET, maxMilliseconds: 10_000 };
afterEach(async () => { vi.restoreAllMocks(); for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true }); });
async function root(): Promise<string> { const path = await mkdtemp(join(tmpdir(), 'jsonlview-provider-metadata-')); cleanup.push(path); return path; }
async function transcript(path: string, rows: unknown[]): Promise<void> { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n'); }
const user = (sessionId: string, content: unknown, extra = {}) => ({ type: 'user', sessionId, uuid: 'message-only', timestamp: '2026-10-01T10:00:00Z', message: { role: 'user', content }, ...extra });
const provider = (path: string, kind: 'claude' | 'codex' = 'claude') => createNativeSessionNavigatorProvider({ provider: kind, rootUri: pathToFileURL(path).toString() });

describe('native provider metadata', () => {
  it.each(['canonical', 'alias'] as const)('maps Codex junction rollout paths relative to the %s source root', async (rootKind) => {
    const base = await root();
    const home = join(base, 'actual-home');
    const alias = join(base, 'home-alias');
    const outside = join(base, 'outside');
    await transcript(join(home, 'sessions', 'child.jsonl'), [{ type: 'event_msg', payload: { type: 'user_message', message: 'Read a session through its alias' } }]);
    await transcript(join(outside, 'escape.jsonl'), [{ type: 'session_meta', payload: { id: 'escape' } }]);
    await symlink(home, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await symlink(outside, join(home, 'escaped'), process.platform === 'win32' ? 'junction' : 'dir');
    const db = new DatabaseSync(join(home, 'state_5.sqlite'));
    try {
      db.exec('CREATE TABLE threads (id TEXT, rollout_path TEXT)');
      const insert = db.prepare('INSERT INTO threads VALUES (?, ?)');
      insert.run('child', join(alias, 'sessions', 'child.jsonl'));
      insert.run('escape', join(home, 'escaped', 'escape.jsonl'));
    } finally { db.close(); }
    const selectedRoot = rootKind === 'canonical' ? home : alias;
    const result = await createNativeSessionNavigatorProvider({ provider: 'codex', rootUri: pathToFileURL(selectedRoot).toString(), stateRootUri: pathToFileURL(home).toString() }).scan(signal(), limits);
    expect(result.snapshot.entities.map((entity) => entity.nativeId)).toEqual(['child']);
    const location = result.snapshot.locations[0]!;
    expect(location.relativePath).toBe(join('sessions', 'child.jsonl'));
    expect(isAbsolute(location.relativePath)).toBe(false);
    expect(await realpath(join(selectedRoot, location.relativePath))).toBe(await realpath(join(home, 'sessions', 'child.jsonl')));
    expect(result.snapshot.entities[0]?.firstMessagePreview).toBe('Read a session through its alias');
  });

  it('keeps Claude subagent identity distinct from its shared sessionId and derives its explicit layout parent', async () => {
    const path = await root();
    await transcript(join(path, 'history.jsonl'), [user('fake-history', 'Do not display history')]);
    await transcript(join(path, 'telemetry', 'events.jsonl'), [user('fake-telemetry', 'Do not display telemetry')]);
    await transcript(join(path, 'projects', 'project', 'parent.jsonl'), [user('parent', 'Review the parser')]);
    await transcript(join(path, 'projects', 'project', 'parent', 'subagents', 'agent-child.jsonl'), [user('parent', 'Inspect edge cases', { agentId: 'child', isSidechain: true })]);
    await transcript(join(path, 'projects', 'project', 'missing', 'subagents', 'agent-orphan.jsonl'), [user('missing', [{ type: 'text', text: 'Retain orphan work' }], { agentId: 'orphan', isSidechain: true })]);
    const result = await provider(path).scan(signal(), limits);
    expect(result.snapshot.entities).toHaveLength(3);
    expect(result.snapshot.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ nativeId: 'parent', label: 'Review the parser', relationship: 'root' }),
      expect.objectContaining({ nativeId: 'subagent:parent:child', label: 'Inspect edge cases', relationship: 'subagent', parentNativeId: 'parent' }),
      expect.objectContaining({ nativeId: 'subagent:missing:orphan', label: 'Retain orphan work', relationship: 'orphan' }),
    ]));
    expect(result.snapshot.relations).toEqual([expect.objectContaining({ fromNativeId: 'subagent:parent:child', toNativeId: 'parent' })]);
    expect(result.snapshot.locations.find((location) => location.nativeId === 'subagent:parent:child')?.relativePath).toContain('agent-child.jsonl');
  });

  it('retains Claude parent edges when pagination returns the child before its parent', async () => {
    const path = await root();
    const parentId = 'parent-page';
    const parentFile = join(path, 'projects', 'project', parentId + '.jsonl');
    const childFile = join(path, 'projects', 'project', parentId, 'subagents', 'agent-child-page.jsonl');
    await transcript(parentFile, [user(parentId, 'Parent session')]);
    await transcript(childFile, [user(parentId, 'Child session', { agentId: 'child-page', isSidechain: true })]);
    await utimes(parentFile, 1, 1);
    await utimes(childFile, 2, 2);
    const source = provider(path);
    const budget = { ...limits, maxEntities: 1, maxFiles: 1 };
    const first = await source.scanPage!(signal(), budget);
    expect(first.snapshot.entities[0]).toMatchObject({ nativeId: 'subagent:' + parentId + ':child-page', relationship: 'orphan' });
    expect(first.snapshot.entities[0]?.parentNativeId).toBeUndefined();
    expect(first.snapshot.relations).toEqual([expect.objectContaining({ fromNativeId: 'subagent:' + parentId + ':child-page', toNativeId: parentId, kind: 'parent' })]);
    const second = await source.scanPage!(signal(), budget, first.nextCursor);
    expect(second.snapshot.entities[0]).toMatchObject({ nativeId: parentId, relationship: 'root' });
  });

  it('reads prefix previews and latest tail titles from multi-megabyte transcripts with bounded IO', async () => {
    const path = await root();
    const file = join(path, 'large.jsonl');
    await transcript(file, [user('large', 'A bounded first user preview'), { type: 'assistant', message: { content: 'x'.repeat(5 * 1024 * 1024) } }, { type: 'custom-title', sessionId: 'large', customTitle: 'Latest provider name', timestamp: '2026-10-02T10:00:00Z' }]);
    const scanBudget = { ...limits, maxBytes: 180 * 1024 };
    const result = await provider(path).scan(signal(), scanBudget);
    expect(result.snapshot.entities[0]).toMatchObject({ nativeId: 'large', vendorTitle: 'Latest provider name', label: 'Latest provider name', firstMessagePreview: 'A bounded first user preview', activityAt: '2026-10-02T10:00:00.000Z' });
    const meter = new MetadataBudget(scanBudget, signal());
    const sampled = await readMetadataRecords(file, meter);
    expect(meter.bytes).toBeLessThanOrEqual(160 * 1024);
    expect(sampled.sampled).toBe(true);
    expect(JSON.stringify(result.snapshot)).not.toContain('x'.repeat(300));
  });

  it('chooses meaningful user text after instructions/tool results and bounds the preview', async () => {
    const path = await root();
    await transcript(join(path, 'session.jsonl'), [
      user('preview', '# AGENTS.md instructions for a synthetic project'),
      user('preview', [{ type: 'tool_result', content: 'must not become preview' }]),
      user('preview', 'injected context', { isMeta: true }),
      user('preview', [{ type: 'text', text: 'Build a parser ' + 'detail '.repeat(100) }]),
    ]);
    const entity = (await provider(path).scan(signal(), limits)).snapshot.entities[0];
    expect(entity?.firstMessagePreview).toMatch(/^Build a parser /u);
    expect(entity?.firstMessagePreview?.length).toBe(240);
    expect(entity?.vendorTitle).toBeUndefined();
  });

  it('reserves tail record budget for the latest title instead of exhausting it on prefix records', async () => {
    const path = await root();
    const file = join(path, 'session.jsonl');
    await transcript(file, [user('tail-budget', 'First meaningful request'), ...Array.from({ length: 20 }, () => ({ type: 'progress' })), { type: 'assistant', message: { content: 'x'.repeat(200_000) } }, ...Array.from({ length: 20 }, () => ({ type: 'progress' })), { type: 'custom-title', sessionId: 'tail-budget', customTitle: 'Newest title' }]);
    const result = await provider(path).scan(signal(), { ...limits, maxRecords: 4 });
    expect(result.snapshot.entities[0]).toMatchObject({ label: 'Newest title', firstMessagePreview: 'First meaningful request' });
  });

  it('keeps a layout-identified orphan when its oversized message cannot be sampled', async () => {
    const path = await root();
    await transcript(join(path, 'projects', 'project', 'missing', 'subagents', 'agent-huge.jsonl'), [user('missing', 'x'.repeat(200_000), { agentId: 'huge', isSidechain: true })]);
    const result = await provider(path).scan(signal(), limits);
    expect(result.snapshot.entities[0]).toMatchObject({ nativeId: 'subagent:missing:huge', relationship: 'orphan' });
    expect(result.snapshot.entities[0]?.firstMessagePreview).toBeUndefined();
  });

  it('deduplicates repeated session identities and excludes set-aside transcript copies', async () => {
    const path = await root();
    await transcript(join(path, 'projects', 'one', 'session.jsonl'), [user('same-session', 'One')]);
    await transcript(join(path, 'projects', 'two', 'session.jsonl'), [user('same-session', 'Two')]);
    await transcript(join(path, 'projects', 'one', 'session.orphaned-old-copy.jsonl'), [user('excluded', 'Old')]);
    const result = await provider(path).scan(signal(), limits);
    expect(result.snapshot.entities.map((entity) => entity.nativeId)).toEqual(['same-session']);
    expect(result.snapshot.locations).toHaveLength(1);
  });

  it('selects recently active transcripts before applying the file cap', async () => {
    const path = await root();
    await transcript(join(path, 'a-old.jsonl'), [user('old', 'Old')]);
    await transcript(join(path, 'z-new.jsonl'), [user('new', 'New')]);
    await utimes(join(path, 'a-old.jsonl'), 1, 1);
    await utimes(join(path, 'z-new.jsonl'), 2, 2);
    const result = await provider(path).scan(signal(), { ...limits, maxFiles: 1 });
    expect(result.snapshot.entities[0]?.nativeId).toBe('new');
    expect(result.snapshot.truncated).toBe(true);
  });

  it('enforces shared metadata byte/record budgets and cancellation', async () => {
    const path = await root();
    const file = join(path, 'session.jsonl');
    await transcript(file, [user('s', 'One'), user('s', 'Two'), user('s', 'Three')]);
    const meter = new MetadataBudget({ ...limits, maxBytes: 400, maxRecords: 1 }, signal());
    await readMetadataRecords(file, meter);
    expect(meter.records).toBe(1);
    expect(meter.bytes).toBeLessThanOrEqual(400);
    expect(meter.truncated).toBe(true);
    const controller = new AbortController(); controller.abort();
    await expect(collectClaudeFiles(path, new MetadataBudget(limits, controller.signal))).rejects.toThrow('cancelled');
  });

  it('reports an unreadable Claude projects directory instead of an empty successful scan', async () => {
    const path = await root();
    await mkdir(join(path, 'projects'));
    vi.mocked(fsPromises.readdir).mockRejectedValueOnce(Object.assign(new Error('Metadata directory access denied'), { code: 'EACCES' }));
    await expect(provider(path).scan(signal(), limits)).rejects.toThrow('Metadata directory access denied');
  });

  it('reads Codex nickname/role, explicit names, and meaningful rollout fallback without persisting bodies', async () => {
    const path = await root();
    const db = new DatabaseSync(join(path, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads (id TEXT, rollout_path TEXT, title TEXT, name TEXT, agent_nickname TEXT, agent_role TEXT, preview TEXT, first_user_message TEXT); CREATE TABLE thread_spawn_edges(parent_thread_id TEXT, child_thread_id TEXT);');
    const insert = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    insert.run('parent', join(path, 'parent.jsonl'), 'Generated title', 'Explicit name', '', '', '', '');
    insert.run('child', join(path, 'child.jsonl'), '', null, 'Ada', 'explorer', '', '');
    insert.run('fallback', join(path, 'fallback.jsonl'), '', null, '', '', '', '');
    db.exec("INSERT INTO thread_spawn_edges VALUES ('parent', 'child')"); db.close();
    await transcript(join(path, 'fallback.jsonl'), [{ type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for synthetic workspace' }] } }, { type: 'event_msg', payload: { type: 'user_message', message: 'Fix source metadata' } }, { type: 'response_item', payload: { role: 'assistant', content: [{ type: 'output_text', text: 'private assistant body' }] } }]);
    const before = await readFile(join(path, 'state_5.sqlite'));
    const result = await provider(path, 'codex').scan(signal(), limits);
    expect(result.snapshot.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ nativeId: 'parent', vendorTitle: 'Explicit name' }),
      expect.objectContaining({ nativeId: 'child', vendorTitle: 'Ada · explorer', relationship: 'subagent' }),
      expect.objectContaining({ nativeId: 'fallback', firstMessagePreview: 'Fix source metadata', label: 'Fix source metadata' }),
    ]));
    expect(await readFile(join(path, 'state_5.sqlite'))).toEqual(before);
    expect(JSON.stringify(result.snapshot)).not.toContain('private assistant body');
  });

  it('returns a coherent Codex snapshot when a WAL commit follows the advisory fingerprint', async () => {
    const path = await root();
    const db = new DatabaseSync(join(path, 'state_5.sqlite'));
    try {
      db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE threads (id TEXT, rollout_path TEXT, title TEXT);');
      db.prepare('INSERT INTO threads VALUES (?, ?, ?)').run('s', join(path, 's.jsonl'), 'Before');
      const source = provider(path, 'codex');
      const originalProbe = source.probe.bind(source);
      let priorFingerprint = '';
      vi.spyOn(source, 'probe').mockImplementationOnce(async (scanSignal) => {
        priorFingerprint = await originalProbe(scanSignal);
        db.exec("UPDATE threads SET title = 'After committed write'");
        return priorFingerprint;
      });
      const result = await source.scan(signal(), limits);
      expect(result.snapshot.entities[0]?.vendorTitle).toBe('After committed write');
      expect(result.fingerprint).toBe(priorFingerprint);
      expect(await originalProbe(signal())).not.toBe(result.fingerprint);
    } finally { db.close(); }
  });

  it('retains Codex children as orphans when the entity cap excludes their parent', async () => {
    const path = await root();
    const db = new DatabaseSync(join(path, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads (id TEXT, rollout_path TEXT, title TEXT, updated_at INTEGER); CREATE TABLE thread_spawn_edges(parent_thread_id TEXT, child_thread_id TEXT);');
    const insert = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?)');
    insert.run('parent', join(path, 'p.jsonl'), 'Parent', 1);
    insert.run('child', join(path, 'c.jsonl'), 'Child', 2);
    db.exec("INSERT INTO thread_spawn_edges VALUES ('parent', 'child')"); db.close();
    const result = await provider(path, 'codex').scan(signal(), { ...limits, maxEntities: 1 });
    expect(result.snapshot.entities[0]).toMatchObject({ nativeId: 'child', relationship: 'orphan' });
    expect(result.snapshot.entities[0]?.parentNativeId).toBeUndefined();
    expect(result.snapshot.relations).toEqual([]);
  });

  it('never relabels Codex children as roots when unrelated edges or a relation cap intervene', async () => {
    const path = await root();
    const db = new DatabaseSync(join(path, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads (id TEXT, rollout_path TEXT, title TEXT); CREATE TABLE thread_spawn_edges(parent_thread_id TEXT, child_thread_id TEXT PRIMARY KEY);');
    const insert = db.prepare('INSERT INTO threads VALUES (?, ?, ?)');
    insert.run('parent', join(path, 'p.jsonl'), 'Parent');
    insert.run('z-child', join(path, 'c.jsonl'), 'Child');
    db.exec("INSERT INTO thread_spawn_edges VALUES ('unrelated-parent', 'a-unrelated'), ('parent', 'z-child')"); db.close();
    const result = await provider(path, 'codex').scan(signal(), { ...limits, maxRelations: 1 });
    expect(result.snapshot.entities.find((entity) => entity.nativeId === 'z-child')).toMatchObject({ relationship: 'subagent', parentNativeId: 'parent' });
    const capped = await provider(path, 'codex').scan(signal(), { ...limits, maxRelations: 0 });
    expect(capped.snapshot.entities.find((entity) => entity.nativeId === 'z-child')).toMatchObject({ relationship: 'orphan' });
    expect(capped.snapshot.relations).toEqual([]);
    expect(capped.snapshot).toMatchObject({ truncated: true, truncatedReason: 'relation_limit' });
  });
});
