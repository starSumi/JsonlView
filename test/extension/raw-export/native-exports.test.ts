import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentSummary, Predicate } from '../../../src/shared/types';
import { mkdtemp, writeFile, readFile, lstat, rm } from 'node:fs/promises';
import { join, dirname, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { IntegratedJsonlSession } from '../../../src/extension/integrated-session/integrated-session';
import { captureRawExportIntent } from '../../../src/extension/raw-export/intent';
import { observeRawExportSource } from '../../../src/extension/raw-export/source-observation';
import { RawExportOperations } from '../../../src/extension/raw-export/operations';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('jsonlview-native-restart-')) throw new Error('Invalid test cleanup root.');
    await rm(root, { recursive: true, force: true });
  }
});
const host = vi.hoisted(() => ({ pick: vi.fn(), save: vi.fn(), input: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn(), run: vi.fn() }));
vi.mock('vscode', () => ({ Uri: { file: (fsPath: string) => ({ scheme: 'file', fsPath }) }, ProgressLocation: { Notification: 15 },
  window: { showQuickPick: host.pick, showSaveDialog: host.save, showInputBox: host.input, showInformationMessage: host.info,
    showWarningMessage: host.warning, showErrorMessage: host.error,
    withProgress: async (_options: unknown, action: (progress: unknown, token: unknown) => unknown) => action({}, {
      isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }),
    }) } }));
vi.mock('../../../src/extension/raw-export/scoped-jsonl', async (original) => ({ ...await original<typeof import('../../../src/extension/raw-export/scoped-jsonl')>(), exportScopedRawJsonl: host.run }));
import { NativeRawExports, type NativeRawExportSource } from '../../../src/extension/raw-export/native-exports';

function fixture() {
  const summary: DocumentSummary = { snapshot: { documentId: 'doc', generation: 'gen', epoch: 1, uri: 'file:///source.jsonl', scheme: 'file',
    sizeBytes: '4', mtimeMs: 1, prefixFingerprint: '', observedAt: '' }, profileId: 'generic', profileVersion: '1', profileEpoch: 2,
    profileSuggestions: [], indexedBytes: '4', indexedRecords: '2', indexingComplete: true, validRecords: '2', problemRecords: '0' };
  const matcher = vi.fn(() => true);
  const session = { getSummary: () => structuredClone(summary), validateObservedSource: async () => true,
    captureRawExportMatcher: vi.fn(() => matcher) } as unknown as NativeRawExportSource['session'];
  const source = { uri: { scheme: 'file', fsPath: 'source.jsonl' }, session, isAuthorized: () => true } as NativeRawExportSource;
  const exports = new NativeRawExports('owned-storage');
  return { summary, source, exports, matcher };
}

beforeEach(() => {
  vi.clearAllMocks();
  host.pick.mockImplementation(async (items: { scope: string }[]) => items.find((item) => item.scope === 'matching'));
  host.save.mockResolvedValue({ scheme: 'file', fsPath: 'destination.jsonl' });
  host.run.mockImplementation(async (request) => ({ intent: request.intent, status: 'committed' }));
});

describe('native scoped raw export', () => {
  it('rescans an unprepared selected-record operation after a real session restart without replacing its original intent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jsonlview-native-restart-'));
    roots.push(root);
    const sourcePath = join(root, 'source.jsonl'); const destinationPath = join(root, 'destination');
    await writeFile(sourcePath, '1\r\n2\n3');
    let session = await IntegratedJsonlSession.open(sourcePath, { uri: pathToFileURL(sourcePath).toString(), autoDetectProfiles: false, backgroundIndexing: false });
    const page = await session.getRows({ limit: 3 }, new AbortController().signal);
    const original = session.getSummary();
    const intent = captureRawExportIntent(original, { kind: 'selected-records', refs: [page.rows[1]!.ref] });
    const observation = await observeRawExportSource(sourcePath, intent);
    const operations = new RawExportOperations(join(root, 'storage', 'raw-export-operations'));
    await operations.admit(intent, destinationPath, observation);
    await session.dispose();
    session = await IntegratedJsonlSession.open(sourcePath, { uri: pathToFileURL(sourcePath).toString(), autoDetectProfiles: false, backgroundIndexing: false });
    try {
      expect(session.getSummary().snapshot.documentId).not.toBe(original.snapshot.documentId);
      expect(session.getSummary().snapshot.generation).not.toBe(original.snapshot.generation);
      const actual = await vi.importActual<typeof import('../../../src/extension/raw-export/scoped-jsonl')>('../../../src/extension/raw-export/scoped-jsonl');
      host.run.mockImplementation(actual.exportScopedRawJsonl);
      host.pick.mockImplementation(async (items) => items[0]);
      host.info.mockImplementation(async (_message, action) => action);
      let granted = false;
      const source = { uri: { scheme: 'file', fsPath: sourcePath }, session, isAuthorized: () => granted } as NativeRawExportSource;
      const recovery = new NativeRawExports(join(root, 'storage'));
      const resolveSource = () => source;
      await recovery.recover(resolveSource);
      expect(host.run).not.toHaveBeenCalled();
      await expect(lstat(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' });
      granted = true;
      await recovery.recover(resolveSource);
      expect(await readFile(destinationPath, 'utf8')).toBe('2\n');
      expect(await readFile(sourcePath, 'utf8')).toBe('1\r\n2\n3');
      expect(host.run).toHaveBeenCalledTimes(1);
      expect(host.run.mock.calls[0]![0].intent).toEqual(intent);
      const receipt = await operations.inspect(intent.requestId);
      expect(receipt.status).toBe('committed');
      expect(receipt.intent).toEqual(intent);
      await recovery.recover(resolveSource);
      expect(host.run).toHaveBeenCalledTimes(1);
    } finally { await session.dispose(); }
  });

  it('reopens a real session with new UUIDs and retries a proved prepared operation only after explicit current authorization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jsonlview-native-restart-'));
    roots.push(root);
    const sourcePath = join(root, 'source.jsonl');
    const destinationPath = join(root, 'destination');
    const temporaryPath = join(root, '.jsonlview-export-00000000-0000-0000-0000-000000000002.tmp');
    await writeFile(sourcePath, '1\r\n2');
    let session = await IntegratedJsonlSession.open(sourcePath, { uri: pathToFileURL(sourcePath).toString(), autoDetectProfiles: false, backgroundIndexing: false });
    const original = session.getSummary();
    const intent = captureRawExportIntent(original, { kind: 'ordinal-range', first: '0', last: '0' });
    const observation = await observeRawExportSource(sourcePath, intent);
    const operations = new RawExportOperations(join(root, 'storage', 'raw-export-operations'));
    await operations.admit(intent, destinationPath, observation);
    await writeFile(temporaryPath, '1\r\n');
    const stats = await lstat(temporaryPath, { bigint: true });
    const { createHash } = await import('node:crypto');
    await operations.prepare(intent.requestId, { temporaryPath, destinationPath, byteLength: '3', sha256: 'sha256:' + createHash('sha256').update('1\r\n').digest('hex'),
      identity: { device: stats.dev.toString(), inode: stats.ino.toString(), size: '3', mtimeNs: stats.mtimeNs.toString(), ctimeNs: stats.ctimeNs.toString(), isFile: true, isSymbolicLink: false } });
    await session.dispose();
    session = await IntegratedJsonlSession.open(sourcePath, { uri: pathToFileURL(sourcePath).toString(), autoDetectProfiles: false, backgroundIndexing: false });
    try {
      expect(session.getSummary().snapshot.documentId).not.toBe(original.snapshot.documentId);
      expect(session.getSummary().snapshot.generation).not.toBe(original.snapshot.generation);
      host.pick.mockImplementation(async (items) => items[0]);
      host.info.mockImplementation(async (_message, action) => action);
      const recovery = new NativeRawExports(join(root, 'storage'));
      let granted = false;
      const source = { uri: { scheme: 'file', fsPath: sourcePath }, session, isAuthorized: () => granted } as NativeRawExportSource;
      await recovery.recover((captured) => captured.binding.uri === session.getSummary().snapshot.uri ? source : undefined);
      await expect(lstat(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' });
      granted = true;
      await recovery.recover((captured) => captured.binding.uri === session.getSummary().snapshot.uri ? source : undefined);
      expect(await readFile(destinationPath, 'utf8')).toBe('1\r\n');
      const receipt = await operations.inspect(intent.requestId);
      expect(receipt.status).toBe('committed');
      expect(receipt.intent.requestId).toBe(intent.requestId);
      expect(receipt.intent.selectionDigest).toBe(intent.selectionDigest);
      expect(host.run).not.toHaveBeenCalled();
    } finally { await session.dispose(); }
  });

  it('freezes the delivered predicate and cancels if it changes while the save picker is open', async () => {
    const f = fixture();
    f.exports.acceptQuery(f.source.session, f.summary, { op: 'text_search', value: 'old', caseSensitive: false });
    host.save.mockImplementation(async () => {
      f.exports.acceptQuery(f.source.session, f.summary, { op: 'text_search', value: 'new', caseSensitive: false });
      return { scheme: 'file', fsPath: 'destination.jsonl' };
    });
    await f.exports.export(f.source);
    expect(host.run).not.toHaveBeenCalled();
    expect(host.warning).toHaveBeenCalledTimes(1);
  });

  it('uses the frozen predicate across an equivalent new page and lets the scanner recheck the grant', async () => {
    const f = fixture();
    const predicate: Predicate = { op: 'text_search', value: 'kept', caseSensitive: false };
    f.exports.acceptQuery(f.source.session, f.summary, predicate);
    host.save.mockImplementation(async () => { f.exports.acceptQuery(f.source.session, f.summary, predicate); return { scheme: 'file', fsPath: 'destination.jsonl' }; });
    await f.exports.export(f.source);
    expect(host.run).toHaveBeenCalledTimes(1);
    const request = host.run.mock.calls[0]![0];
    expect(request.intent.selection).toEqual({ kind: 'matching', predicate });
    expect(request.matches).toBe(f.matcher);
    expect(await request.authorize()).toBe(true);
    f.summary.profileEpoch = 3;
    expect(await request.authorize()).toBe(false);
  });

  it('does no export when selection/save is dismissed and never offers an unaccepted query', async () => {
    const f = fixture();
    host.pick.mockImplementation(async (items) => { expect(items).toHaveLength(1); expect(items[0].scope).toBe('ordinal-range'); return undefined; });
    await f.exports.export(f.source);
    expect(host.save).not.toHaveBeenCalled();
    expect(host.run).not.toHaveBeenCalled();
  });
});
