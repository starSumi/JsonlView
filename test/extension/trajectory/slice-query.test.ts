import { createHash } from 'node:crypto';
import * as fsPromises from 'node:fs/promises';
import { mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseTrajectoryRequest, serializeTrajectoryResult, TRAJECTORY_REQUEST_SCHEMA, type TrajectorySliceRequest } from '../../../src/shared/contracts/trajectory-slice';
import { canonicalJson, createTrajectoryCursor, parseTrajectoryCursor } from '../../../src/extension/trajectory/cursor';
import { TrajectorySliceQuery, type TrajectoryQueryOptions } from '../../../src/extension/trajectory/slice-query';
import { AuthorizedTrajectorySource, trajectorySnapshotId } from '../../../src/extension/trajectory/source';
import { parseTrajectorySpineRequest, queryTrajectorySpine, serializeTrajectorySpineResult, TRAJECTORY_SPINE_REQUEST_SCHEMA } from '../../../src/extension/trajectory/spine';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, stat: vi.fn(actual.stat) };
});

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const claude = (text: string, role = 'user') => ({ type: role, sessionId: 'synthetic', uuid: text.slice(0, 12), message: { role, content: text } });
const request = (extra: Partial<TrajectorySliceRequest> = {}): TrajectorySliceRequest => {
  const value = parseTrajectoryRequest({ schema: TRAJECTORY_REQUEST_SCHEMA, requestId: 'test', sourceId: 'source', predicate: { actor: 'user' }, ...extra });
  if (value === undefined) throw new Error('Invalid fixture');
  return value;
};
async function fixture(content: string | Buffer, overrides: Partial<TrajectoryQueryOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'jsonlview-trajectory-')); roots.push(root);
  const path = join(root, 'synthetic.jsonl'); await writeFile(path, content);
  const options: TrajectoryQueryOptions = { sources: new Map([['source', path]]), allowedRoots: [root], ...overrides };
  return { root, path, options, query: new TrajectorySliceQuery(options) };
}
function expectCode(result: { status: string; error?: { code: string } }, code: string) { expect(result).toMatchObject({ status: 'error', error: { code } }); }

describe('portable trajectory scan', () => {
  it('matches physical engine framing with BOM, blank/invalid rows, CRLF, UTF8 and no final newline', async () => {
    const first = Buffer.from(`\uFEFF${JSON.stringify(claude('你好'))}\r\n`);
    const blankAndBad = Buffer.from([10, 0xff, 10]);
    const last = Buffer.from(JSON.stringify(claude('last')));
    const { query } = await fixture(Buffer.concat([first, blankAndBad, last]));
    const result = await query.query(request());
    expect(result.status).toBe('complete');
    if (result.status === 'error') return;
    expect(result.records.map((row) => [row.ordinal, row.byteStart, row.byteEnd, row.text])).toEqual([
      ['0', '0', String(first.length - 2), '你好'],
      ['3', String(first.length + blankAndBad.length), String(first.length + blankAndBad.length + last.length), 'last'],
    ]);
    expect(result.usage).toMatchObject({ examinedBytes: String(first.length + blankAndBad.length + last.length), examinedRecords: 4 });
    const zero = { ...result, usage: { ...result.usage, returnedBytes: 0 } };
    expect(result.usage.returnedBytes).toBe(Buffer.byteLength(serializeTrajectoryResult(zero)));
  });
  it('does not create a phantom row after a trailing newline', async () => {
    const { query } = await fixture(`${JSON.stringify(claude('one'))}\n${JSON.stringify(claude('two'))}\n`);
    const result = await query.query(request());
    expect(result.status).toBe('complete');
    if (result.status !== 'error') expect(result.usage.examinedRecords).toBe(2);
  });
  it('advances hot cursors, counts actual read-ahead bytes, and fails cold no-progress honestly', async () => {
    const content = Array.from({ length: 240 }, (_, index) => JSON.stringify(claude(`${index}:${'x'.repeat(800)}`))).join('\n');
    const { query, options } = await fixture(content);
    const reads: { requested: number; actual: number }[] = [];
    const original = AuthorizedTrajectorySource.prototype.readAt;
    vi.spyOn(AuthorizedTrajectorySource.prototype, 'readAt').mockImplementation(async function (this: AuthorizedTrajectorySource, position, length, signal) {
      const data = await original.call(this, position, length, signal); reads.push({ requested: length, actual: data.length }); return data;
    });
    const first = await query.query(request({ limit: 100, maxOutputBytes: 262144 }));
    expect(first.status).toBe('partial');
    if (first.status !== 'partial') return;
    expect(parseTrajectoryCursor(first.cursor)?.nextOrdinal).toBe('100');
    expect(first.usage.examinedBytes).toBe(String(reads.reduce((sum, read) => sum + read.actual, 0)));
    let remaining = request().maxExaminedBytes;
    for (const read of reads) { expect(read.requested).toBeLessThanOrEqual(remaining); remaining -= read.actual; }
    reads.length = 0;
    const hot = await query.query(request({ cursor: first.cursor, limit: 1, maxExaminedBytes: 1024, maxOutputBytes: 8192 }));
    expect(hot.status).toBe('partial');
    if (hot.status !== 'partial') return;
    expect(hot.records[0]?.ordinal).toBe('100');
    expect(parseTrajectoryCursor(hot.cursor)?.nextOrdinal).toBe('101');
    expect(hot.usage.examinedBytes).toBe('1024');
    expect(reads.every((read) => read.requested <= 1024)).toBe(true);
    const cold = await new TrajectorySliceQuery(options).query(request({ cursor: first.cursor, maxExaminedBytes: 1024 }));
    expectCode(cold, 'BUDGET_TOO_SMALL');
  });
  it('returns the same page after locator eviction and cold reconstruction when budget suffices', async () => {
    const content = Array.from({ length: 140 }, (_, index) => JSON.stringify(claude(`row-${index}`))).join('\n');
    const { options } = await fixture(content);
    const query = new TrajectorySliceQuery({ ...options, maxCheckpoints: 1 });
    const first = await query.query(request({ limit: 100 }));
    if (first.status !== 'partial') throw new Error('Expected first cursor');
    const second = await query.query(request({ cursor: first.cursor, limit: 10 }));
    if (second.status !== 'partial') throw new Error('Expected second cursor');
    const evicted = await query.query(request({ cursor: first.cursor, limit: 10 }));
    const cold = await new TrajectorySliceQuery(options).query(request({ cursor: first.cursor, limit: 10 }));
    if (evicted.status === 'error' || cold.status === 'error') throw new Error('Expected reconstructed pages');
    expect(evicted.records).toEqual(second.records);
    expect(cold.records).toEqual(second.records);
    expect(cold.profile).toEqual(second.profile);
    expect(BigInt(cold.usage.examinedBytes)).toBeGreaterThan(BigInt(second.usage.examinedBytes));
  });
  it('never commits a half line or emits a stationary cursor', async () => {
    const { query } = await fixture(`${JSON.stringify(claude('x'.repeat(5000)))}\n${JSON.stringify(claude('two'))}`);
    expectCode(await query.query(request({ maxExaminedBytes: 1024 })), 'BUDGET_TOO_SMALL');
    expectCode(await query.query(request({ maxOutputBytes: 1024 })), 'BUDGET_TOO_SMALL');
  });
  it('holds the first excluded output row for the next page', async () => {
    const { query } = await fixture([claude('x'.repeat(600)), claude('y'.repeat(600)), claude('z'.repeat(600))].map((row) => JSON.stringify(row)).join('\n'));
    const first = await query.query(request({ maxOutputBytes: 2000 }));
    expect(first.status).toBe('partial');
    if (first.status !== 'partial') return;
    const nextOrdinal = parseTrajectoryCursor(first.cursor)?.nextOrdinal;
    expect(nextOrdinal).toBe(String(first.records.length));
    const second = await query.query(request({ cursor: first.cursor, maxOutputBytes: 8192 }));
    if (second.status !== 'error') expect(second.records[0]?.ordinal).toBe(nextOrdinal);
    expect(Buffer.byteLength(serializeTrajectoryResult(first))).toBeLessThanOrEqual(2000);
  });
  it('rejects predicate changes, expiry, foreign source and source append after a cursor', async () => {
    const { query, path } = await fixture([claude('one'), claude('two')].map((row) => JSON.stringify(row)).join('\n'));
    const first = await query.query(request({ limit: 1 }));
    if (first.status !== 'partial') throw new Error('Expected cursor');
    expectCode(await query.query(request({ cursor: first.cursor, predicate: { actor: 'assistant' } })), 'STALE_CURSOR');
    const payload = parseTrajectoryCursor(first.cursor); if (payload === undefined) throw new Error('Expected payload');
    expectCode(await query.query(request({ cursor: createTrajectoryCursor({ ...payload, expiresAtMs: 0 }) })), 'STALE_CURSOR');
    expectCode(await query.query(request({ cursor: createTrajectoryCursor({ ...payload, sourceId: 'other' }) })), 'STALE_CURSOR');
    await writeFile(path, `${await readFile(path, 'utf8')}\n${JSON.stringify(claude('append'))}`);
    expectCode(await query.query(request({ cursor: first.cursor })), 'STALE_CURSOR');
  });
});

describe('authority and publication faults', () => {
  it.each(['append', 'replace', 'revoke', 'cancel'] as const)('discards the entire page on %s before publication', async (fault) => {
    const f = await fixture([claude('one'), claude('two')].map((row) => JSON.stringify(row)).join('\n'));
    const controller = new AbortController(); let calls = 0;
    const query = new TrajectorySliceQuery({ ...f.options, authorization: async () => {
      calls++;
      if (calls === 4) {
        if (fault === 'append') await writeFile(f.path, `${await readFile(f.path, 'utf8')}\n{}`);
        if (fault === 'replace') { await rename(f.path, `${f.path}.old`); await writeFile(f.path, 'replacement'); }
        if (fault === 'cancel') controller.abort();
      }
      return fault === 'revoke' && calls >= 4 ? undefined : { path: f.path, epoch: 1 };
    } });
    const result = await query.query(request(), controller.signal);
    expectCode(result, fault === 'revoke' ? 'SOURCE_NOT_AUTHORIZED' : fault === 'cancel' ? 'CANCELLED' : 'SOURCE_CHANGED');
    expect(result).not.toHaveProperty('records');
    expect(JSON.stringify(result)).not.toContain(f.path);
  });
  it('rejects unregistered, out-of-root, directory and symlink-escape targets', async () => {
    const f = await fixture('{}'); const other = await fixture('{}');
    expectCode(await f.query.query(request({ sourceId: 'other' })), 'SOURCE_NOT_AUTHORIZED');
    expectCode(await new TrajectorySliceQuery({ ...f.options, sources: new Map([['source', other.path]]) }).query(request()), 'SOURCE_NOT_AUTHORIZED');
    expectCode(await new TrajectorySliceQuery({ ...f.options, sources: new Map([['source', f.root]]) }).query(request()), 'SOURCE_NOT_AUTHORIZED');
    const link = join(f.root, 'escape'); await symlink(other.root, link, 'junction');
    expectCode(await new TrajectorySliceQuery({ ...f.options, sources: new Map([['source', join(link, 'synthetic.jsonl')]]) }).query(request()), 'SOURCE_NOT_AUTHORIZED');
  });
  it('checks epoch again after pending publication metadata I/O and handles cancellation before opening', async () => {
    const f = await fixture('{}'); let calls = 0;
    const query = new TrajectorySliceQuery({ ...f.options, authorization: () => ({ path: f.path, epoch: ++calls >= 5 ? 2 : 1 }) });
    expectCode(await query.query(request()), 'SOURCE_NOT_AUTHORIZED');
    const controller = new AbortController(); controller.abort();
    expectCode(await f.query.query(request(), controller.signal), 'CANCELLED');
  });
  it('rejects an epoch revoked while the publication path stat is suspended', async () => {
    const f = await fixture([claude('one'), claude('two')].map((row) => JSON.stringify(row)).join('\n'));
    let epoch = 1; let calls = 0;
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const pending = new Promise<void>((resolve) => { entered = resolve; });
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(fsPromises.stat).mockImplementation((async (...args: Parameters<typeof fsPromises.stat>) => {
      const result = await actual.stat(...args);
      if (++calls === 2) { entered(); await gate; }
      return result;
    }) as typeof fsPromises.stat);
    const query = new TrajectorySliceQuery({ ...f.options, authorization: () => ({ path: f.path, epoch }) });
    const running = query.query(request());
    await pending; epoch = 2; release();
    expectCode(await running, 'SOURCE_NOT_AUTHORIZED');
  });
  it('uses monotonic elapsed time and never sends partial with no progress', async () => {
    const f = await fixture('{}'); let now = 0;
    const query = new TrajectorySliceQuery({ ...f.options, monotonicNow: () => { now += 101; return now; } });
    expectCode(await query.query(request({ deadlineMs: 100 })), 'DEADLINE_EXCEEDED');
  });
  it('computes snapshot using canonical bigint nanoseconds and no path', async () => {
    const { path } = await fixture('{}'); const info = await stat(path, { bigint: true });
    const expected = createHash('sha256').update(canonicalJson({ v: 1, sourceId: 'source', device: info.dev > 0n ? String(info.dev) : null,
      fileId: info.ino > 0n ? String(info.ino) : null, sizeBytes: String(info.size), mtimeUnixNs: String(info.mtimeNs) })).digest('hex');
    expect(trajectorySnapshotId('source', info)).toBe(expected);
    expect(trajectorySnapshotId('source', { ...info, dev: 0n, ino: 0n, size: 9007199254740993n, mtimeNs: 1234567890123456789n }))
      .toBe('e4b45d66cfe003c7d1bcf65b8cb013e48598c381a0f701683d1e92b0f8c36272');
  });
});

describe('spine shares the portable boundary', () => {
  it('has an independent strict schema and reports omitted unknown/error/large-tool coverage', async () => {
    const tool = { type: 'user', sessionId: 'synthetic', uuid: 'tool', message: { content: [{ type: 'tool_result', is_error: false, content: 'x'.repeat(5000) }] } };
    const { query } = await fixture([claude('one'), claude('two'), tool, { custom: 1 }].map((row) => JSON.stringify(row)).join('\n'));
    const req = parseTrajectorySpineRequest({ schema: TRAJECTORY_SPINE_REQUEST_SCHEMA, requestId: 'spine', sourceId: 'source' });
    if (req === undefined) throw new Error('Invalid spine fixture');
    expect(parseTrajectorySpineRequest({ ...req, predicate: { actor: 'user' } })).toBeUndefined();
    const result = await queryTrajectorySpine(query, req);
    expect(result.status).toBe('complete');
    if (result.status === 'error') return;
    expect(result.entries.map((entry) => entry.actor)).toEqual(['user', 'user', 'tool']);
    expect(result.entries[2]).toMatchObject({ text: null, hasError: false });
    expect(result.omitted).toMatchObject({ unknownActor: 1, toolPayloads: 1 });
    expect(result).not.toHaveProperty('tokens');
    expect(Buffer.byteLength(serializeTrajectorySpineResult(result))).toBeLessThanOrEqual(req.maxOutputBytes);
  });
});
