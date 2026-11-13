import { mkdtemp, readFile, writeFile, readdir, link, lstat, copyFile, unlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DocumentSummary, RecordRef } from '../../../src/shared/types';
import { captureRawExportIntent } from '../../../src/extension/raw-export/intent';
import { createScopedRawSpool } from '../../../src/extension/raw-export/scoped-spool';
import { RawExportOperations } from '../../../src/extension/raw-export/operations';
import { exportScopedRawJsonl } from '../../../src/extension/raw-export/scoped-jsonl';
import { IntegratedJsonlSession } from '../../../src/extension/integrated-session/integrated-session';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('jsonlview-scoped-')) throw new Error('Invalid test cleanup root.');
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture(bytes: Uint8Array | string) {
  const root = await mkdtemp(join(tmpdir(), 'jsonlview-scoped-'));
  roots.push(root);
  const sourcePath = join(root, 'source.jsonl');
  await writeFile(sourcePath, bytes);
  const metadata = await lstat(sourcePath, { bigint: true });
  const summary: DocumentSummary = {
    snapshot: { documentId: 'doc', generation: 'gen', epoch: 2, uri: 'file:///source.jsonl', scheme: 'file',
      sizeBytes: metadata.size.toString(), mtimeMs: Number(metadata.mtimeMs), device: metadata.dev.toString(),
      inode: metadata.ino.toString(), prefixFingerprint: 'prefix', observedAt: '' },
    profileId: 'generic', profileVersion: '1', profileEpoch: 1, profileSuggestions: [],
    indexedBytes: '0', indexedRecords: '0', indexingComplete: false, validRecords: '0', problemRecords: '0',
  };
  return { root, sourcePath, summary, authorize: async () => true };
}

function ref(ordinal: string, start: string, end: string, content: string, delimiter: 0 | 1 | 2): RecordRef {
  return { generation: 'gen', ordinal, byteStart: start, byteEndExclusive: end,
    contentByteLength: content, delimiterByteLength: delimiter, parseState: 'unknown' };
}

describe('scoped raw export', () => {
  it('preserves exact bytes using real engine refs for LF, CRLF, blank, invalid UTF-8 and EOF', async () => {
    const input = Buffer.from([0x31, 0x0a, 0x0d, 0x0a, 0xff, 0x0a, 0x32, 0x0d, 0x0a, 0x33]);
    const f = await fixture(input);
    const session = await IntegratedJsonlSession.open(f.sourcePath, { uri: f.summary.snapshot.uri, autoDetectProfiles: false, backgroundIndexing: false });
    try {
      const page = await session.getRows({ limit: 20 }, new AbortController().signal);
      expect(page.rows).toHaveLength(5);
      expect(page.rows[1]!.ref.byteStart).toBe(page.rows[1]!.ref.byteEndExclusive);
      const intent = captureRawExportIntent(session.getSummary(), { kind: 'selected-records', refs: page.rows.map((row) => row.ref).reverse() });
      const spoolPath = join(f.root, 'real-refs');
      await createScopedRawSpool({ ...f, spoolPath, intent });
      expect(await readFile(spoolPath)).toEqual(input);
    } finally { await session.dispose(); }
  });

  it('exports an inclusive range including invalid UTF-8, blank rows and exact CRLF bytes', async () => {
    const input = Buffer.from([0x31, 0x0a, 0xff, 0x0d, 0x0a, 0x0a, 0x33]);
    const f = await fixture(input);
    const intent = captureRawExportIntent(f.summary, { kind: 'ordinal-range', first: '1', last: '2' });
    const spoolPath = join(f.root, 'spool');
    const result = await createScopedRawSpool({ ...f, spoolPath, intent });
    expect(await readFile(spoolPath)).toEqual(input.subarray(2, 6));
    expect(result.records).toBe('2');
    expect(await readFile(f.sourcePath)).toEqual(input);
  });

  it('normalizes selected refs into physical order, deduplicates, and verifies their coordinates', async () => {
    const f = await fixture('1\n2\r\n3');
    const a = ref('0', '0', '1', '1', 1);
    const b = ref('2', '5', '6', '1', 0);
    const intent = captureRawExportIntent(f.summary, { kind: 'selected-records', refs: [b, a, a] });
    const spoolPath = join(f.root, 'spool');
    await createScopedRawSpool({ ...f, spoolPath, intent });
    expect(await readFile(spoolPath, 'utf8')).toBe('1\n3');
    const bad = captureRawExportIntent(f.summary, { kind: 'selected-records', refs: [ref('1', '1', '3', '2', 1)] });
    await expect(createScopedRawSpool({ ...f, spoolPath: join(f.root, 'bad'), intent: bad })).rejects.toThrow('selection');
  });

  it('continues past nonmatching records and exports all matches rather than one page', async () => {
    const f = await fixture(Array.from({ length: 1200 }, (_, n) => JSON.stringify({ n }) + '\n').join(''));
    const predicate = { op: 'compare' as const, path: { tokens: [{ kind: 'key' as const, value: 'n' }] }, cmp: 'gte' as const, value: 1198 };
    const intent = captureRawExportIntent(f.summary, { kind: 'matching', predicate });
    const spoolPath = join(f.root, 'spool');
    await createScopedRawSpool({ ...f, spoolPath, intent, matches: (value) => (value as { n: number }).n >= 1198 });
    expect(await readFile(spoolPath, 'utf8')).toBe('{"n":1198}\n{"n":1199}\n');
  });

  it('matches GET_ROWS predicate semantics through the captured real profile, with physical order and raw bytes', async () => {
    const raw = '{"type":"user","text":"hello"}\r\n\ninvalid\n{"type":"assistant","text":"bye"}\n{"type":"user","text":"world"}';
    const f = await fixture(raw);
    const session = await IntegratedJsonlSession.open(f.sourcePath, { uri: f.summary.snapshot.uri, autoDetectProfiles: false, backgroundIndexing: false });
    try {
      await session.setProfile('generic-agent-events', new AbortController().signal);
      const predicate = { op: 'compare' as const, path: { tokens: [{ kind: 'key' as const, value: 'type' }] }, cmp: 'eq' as const, value: 'user' };
      const page = await session.getRows({ limit: 100, predicate }, new AbortController().signal);
      const intent = captureRawExportIntent(session.getSummary(), { kind: 'matching', predicate });
      const spoolPath = join(f.root, 'matched');
      const result = await createScopedRawSpool({ ...f, spoolPath, intent, matches: session.captureRawExportMatcher(predicate) });
      expect(result.records).toBe(String(page.rows.length));
      expect(await readFile(spoolPath, 'utf8')).toBe('{"type":"user","text":"hello"}\r\n{"type":"user","text":"world"}');
    } finally { await session.dispose(); }
  });

  it('refuses scan, record, output and cooperative deadline exhaustion without publishing a destination', async () => {
    const f = await fixture('1\n2\n3\n');
    const intent = captureRawExportIntent(f.summary, { kind: 'matching' });
    for (const limits of [{ maxExaminedBytes: 2 }, { maxExaminedRecords: 2 }, { maxOutputBytes: 2 }, { deadlineMs: 0 }]) {
      await expect(createScopedRawSpool({ ...f, intent, spoolPath: join(f.root, 'spool-' + Object.keys(limits)[0]), limits })).rejects.toThrow();
    }
    expect((await readdir(f.root)).includes('destination')).toBe(false);
  });

  it('rechecks authorization after scanning and fails an out-of-range inclusive end', async () => {
    const f = await fixture('1\n');
    const intent = captureRawExportIntent(f.summary, { kind: 'ordinal-range', first: '0', last: '2' });
    await expect(createScopedRawSpool({ ...f, intent, spoolPath: join(f.root, 'spool') })).rejects.toThrow('selection');
    let calls = 0;
    await expect(createScopedRawSpool({ ...f, intent: captureRawExportIntent(f.summary, { kind: 'matching' }),
      spoolPath: join(f.root, 'denied'), authorize: async () => ++calls === 1 })).rejects.toThrow('authorization');
  });

  it('recovers a link committed before its journal receipt and never repeats publication', async () => {
    const f = await fixture('1\n2\n');
    const operations = new RawExportOperations(join(f.root, 'operations'));
    const intent = captureRawExportIntent(f.summary, { kind: 'ordinal-range', first: '0', last: '0' });
    const destinationPath = join(f.root, 'export.jsonl');
    const operation = await operations.admit(intent, destinationPath);
    const spool = await createScopedRawSpool({ ...f, intent, spoolPath: operation.spoolPath });
    const stats = await lstat(operation.spoolPath, { bigint: true });
    const temporaryPath = join(f.root, '.jsonlview-export-00000000-0000-0000-0000-000000000000.tmp');
    await link(operation.spoolPath, temporaryPath);
    await operations.prepare(intent.requestId, { temporaryPath, destinationPath,
      identity: { device: stats.dev.toString(), inode: stats.ino.toString(), size: stats.size.toString(),
        mtimeNs: stats.mtimeNs.toString(), ctimeNs: stats.ctimeNs.toString(), isFile: true, isSymbolicLink: false },
      byteLength: spool.byteLength, sha256: spool.sha256 });
    await link(operation.spoolPath, destinationPath);
    const restarted = new RawExportOperations(join(f.root, 'operations'));
    expect((await restarted.inspect(intent.requestId)).status).toBe('committed');
    expect((await restarted.inspect(intent.requestId)).status).toBe('committed');
    expect(await readFile(destinationPath, 'utf8')).toBe('1\n');
  });

  it('keeps an unrelated destination and reports unknown, including identical bytes in a different inode', async () => {
    const f = await fixture('1\n');
    const operations = new RawExportOperations(join(f.root, 'operations'));
    const intent = captureRawExportIntent(f.summary, { kind: 'matching' });
    const destinationPath = join(f.root, 'destination');
    await operations.admit(intent, destinationPath);
    await writeFile(destinationPath, 'user-owned');
    expect((await operations.inspect(intent.requestId)).status).toBe('unprepared');
    expect(await readFile(destinationPath, 'utf8')).toBe('user-owned');
  });

  it('commits through the existing raw core, durably settles, cleans owned spools and refuses recreation after deletion', async () => {
    const f = await fixture('1\n2\r\n3');
    const operations = new RawExportOperations(join(f.root, 'operations'));
    const intent = captureRawExportIntent(f.summary, { kind: 'ordinal-range', first: '1', last: '2' });
    const destinationPath = join(f.root, 'destination');
    const result = await exportScopedRawJsonl({ ...f, intent, destinationPath }, operations);
    expect(result.status).toBe('committed');
    expect(await readFile(destinationPath, 'utf8')).toBe('2\r\n3');
    expect((await readdir(join(f.root, 'operations', intent.requestId))).filter((name) => /^spool-[a-f0-9-]+\.jsonl$/u.test(name))).toEqual([]);
    await unlink(destinationPath);
    expect((await operations.retry(intent.requestId, async () => true)).status).toBe('unknown');
    await expect(lstat(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains a different-inode destination and does not retry an uncertain operation', async () => {
    const f = await fixture('1\n');
    const operations = new RawExportOperations(join(f.root, 'operations'));
    const intent = captureRawExportIntent(f.summary, { kind: 'matching' });
    const destinationPath = join(f.root, 'destination');
    const operation = await operations.admit(intent, destinationPath);
    const spool = await createScopedRawSpool({ ...f, intent, spoolPath: operation.spoolPath });
    const temporaryPath = join(f.root, '.jsonlview-export-00000000-0000-0000-0000-000000000001.tmp');
    await link(operation.spoolPath, temporaryPath);
    const stats = await lstat(temporaryPath, { bigint: true });
    await operations.prepare(intent.requestId, { temporaryPath, destinationPath, byteLength: spool.byteLength, sha256: spool.sha256,
      identity: { device: stats.dev.toString(), inode: stats.ino.toString(), size: stats.size.toString(),
        mtimeNs: stats.mtimeNs.toString(), ctimeNs: stats.ctimeNs.toString(), isFile: true, isSymbolicLink: false } });
    await copyFile(operation.spoolPath, destinationPath);
    expect((await operations.retry(intent.requestId, async () => true)).status).toBe('unknown');
    expect(await readFile(destinationPath, 'utf8')).toBe('1\n');
    expect(await readFile(temporaryPath, 'utf8')).toBe('1\n');
  });

  it('cancels before admission/read publication and rejects changed grants without a target', async () => {
    const f = await fixture('1\n');
    const operations = new RawExportOperations(join(f.root, 'operations'));
    const intent = captureRawExportIntent(f.summary, { kind: 'matching' });
    const destinationPath = join(f.root, 'destination');
    const cancelled = new AbortController(); cancelled.abort();
    await expect(exportScopedRawJsonl({ ...f, intent, destinationPath, signal: cancelled.signal }, operations)).rejects.toThrow(intent.requestId);
    await expect(lstat(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(exportScopedRawJsonl({ ...f, intent, destinationPath, authorize: async () => false }, operations)).rejects.toThrow(intent.requestId);
    await expect(lstat(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed on corrupt durable evidence, selection identity conflicts and the terminal receipt cap', async () => {
    const f = await fixture('1\n');
    const root = join(f.root, 'operations');
    const operations = new RawExportOperations(root);
    const intent = captureRawExportIntent(f.summary, { kind: 'matching' });
    await operations.admit(intent, join(f.root, 'destination'));
    const changed = captureRawExportIntent(f.summary, { kind: 'ordinal-range', first: '0', last: '0' }, intent.requestId);
    await expect(operations.admit(changed, join(f.root, 'destination'))).rejects.toThrow('identity');
    await writeFile(join(root, intent.requestId, 'prepared.json'), '{');
    await expect(operations.inspect(intent.requestId)).rejects.toThrow();
    await expect(operations.retry(intent.requestId, async () => true)).rejects.toThrow();
    const { mkdir } = await import('node:fs/promises');
    for (let n = 0; n < 255; n++) await mkdir(join(root, 'retained-' + String(n)));
    await expect(operations.admit(captureRawExportIntent(f.summary, { kind: 'matching' }), join(f.root, 'other'))).rejects.toThrow('full');
    expect((await readdir(root)).filter((name) => !name.startsWith('slot-')).length).toBe(256);
    expect(await readFile(join(root, intent.requestId, 'prepared.json'), 'utf8')).toBe('{');
  });

  it('bounds concurrent admission across independent Host instances with immutable exclusive slots', async () => {
    const f = await fixture('1\n');
    const root = join(f.root, 'operations');
    const { mkdir } = await import('node:fs/promises');
    const { randomUUID } = await import('node:crypto');
    await mkdir(root);
    for (let slot = 0; slot < 255; slot++) await writeFile(join(root, `slot-${slot}.json`), JSON.stringify({ requestId: randomUUID() }));
    const results = await Promise.allSettled([new RawExportOperations(root), new RawExportOperations(root)].map((operations, index) =>
      operations.admit(captureRawExportIntent(f.summary, { kind: 'matching' }), join(f.root, `out-${index}`))));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await readdir(root)).filter((name) => name.startsWith('slot-'))).toHaveLength(256);
  });
});
