import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RAW_JSONL_EXPORT_RECEIPT_SCHEMA,
  RawJsonlExportError,
  exportRawJsonl,
  nodeRawJsonlExportFileSystem,
  type RawJsonlAuthorizedSource,
  type RawJsonlExportDependencies,
  type RawJsonlExportFileHandle,
  type RawJsonlExportFileIdentity,
  type RawJsonlExportFileSystem,
  type RawJsonlSourceSnapshot,
} from '../../../src/extension/raw-export/jsonl';

const roots: string[] = [];
const workspaceRoot = resolve('/workspace');
const sourcePath = join(workspaceRoot, 'source.jsonl');
const outputPath = join(workspaceRoot, 'output.jsonl');

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'jsonlview-raw-export-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function snapshot(bytes: Uint8Array, overrides: Partial<RawJsonlSourceSnapshot> = {}): RawJsonlSourceSnapshot {
  return {
    sourceId: 'source-1',
    documentId: 'document-1',
    generation: 'generation-1',
    authorizationEpoch: '7',
    byteLength: String(bytes.byteLength),
    sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    ...overrides,
  };
}

function dependencies(
  source: RawJsonlAuthorizedSource,
  overrides: Partial<RawJsonlExportDependencies> = {},
): RawJsonlExportDependencies {
  return {
    authorizeAndResolveSource: vi.fn(async () => source),
    ...overrides,
  };
}

class FakeFileSystem implements RawJsonlExportFileSystem {
  public readonly files = new Map<string, { id: string; bytes: Uint8Array; mtime: number }>();
  public readonly directories = new Set([workspaceRoot]);
  public readonly unlinked: string[] = [];
  public linkHook: ((temporaryPath: string, destinationPath: string) => Promise<void>) | undefined;
  public syncHook: (() => void) | undefined;
  public readHook: ((path: string, position: number) => void) | undefined;
  public destinationStatError: Error | undefined;
  private nextId = 1;

  public addFile(path: string, bytes: Uint8Array): void {
    this.files.set(path, { id: String(this.nextId++), bytes: new Uint8Array(bytes), mtime: 1 });
  }

  public async realpath(path: string): Promise<string> {
    if (!this.directories.has(path) && !this.files.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return path;
  }

  public async open(path: string, flags: 'r' | 'wx'): Promise<RawJsonlExportFileHandle> {
    let file = this.files.get(path);
    if (flags === 'r' && file === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    if (flags === 'wx' && file !== undefined) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    if (flags === 'wx') {
      file = { id: String(this.nextId++), bytes: new Uint8Array(), mtime: 1 };
      this.files.set(path, file);
    }
    const openedFile = file!;
    const owner = this;
    let closed = false;
    return {
      async read(buffer, offset, length, position) {
        if (closed) throw new Error('closed');
        owner.readHook?.(path, position);
        const available = Math.max(0, Math.min(length, openedFile.bytes.byteLength - position));
        buffer.set(openedFile.bytes.subarray(position, position + available), offset);
        return available;
      },
      async write(buffer, offset, length, position) {
        if (closed) throw new Error('closed');
        const end = position + length;
        if (end > openedFile.bytes.byteLength) {
          const expanded = new Uint8Array(end);
          expanded.set(openedFile.bytes);
          openedFile.bytes = expanded;
        }
        openedFile.bytes.set(buffer.subarray(offset, offset + length), position);
        openedFile.mtime += 1;
        return length;
      },
      async stat() { return owner.identity(openedFile); },
      async sync() { owner.syncHook?.(); },
      async close() { closed = true; },
    };
  }

  public async lstat(path: string): Promise<RawJsonlExportFileIdentity> {
    if (this.destinationStatError !== undefined && path.endsWith('output.jsonl')) throw this.destinationStatError;
    const file = this.files.get(path);
    if (file === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return this.identity(file);
  }

  public async link(temporaryPath: string, destinationPath: string): Promise<void> {
    if (this.linkHook !== undefined) return this.linkHook(temporaryPath, destinationPath);
    if (this.files.has(destinationPath)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    const file = this.files.get(temporaryPath);
    if (file === undefined) throw Object.assign(new Error('missing temp'), { code: 'ENOENT' });
    this.files.set(destinationPath, file);
  }

  public async unlink(path: string): Promise<void> {
    this.unlinked.push(path);
    this.files.delete(path);
  }

  private identity(file: { id: string; bytes: Uint8Array; mtime: number }): RawJsonlExportFileIdentity {
    return {
      device: '1', inode: file.id, size: String(file.bytes.byteLength), mtimeNs: String(file.mtime), ctimeNs: String(file.mtime),
      isFile: true, isSymbolicLink: false,
    };
  }
}

function fakeSource(
  fs: FakeFileSystem,
  bytes: Uint8Array,
  path = sourcePath,
): RawJsonlAuthorizedSource {
  fs.addFile(path, bytes);
  return { authorization: 'authorized', sourcePath: path, snapshot: snapshot(bytes) };
}

describe('raw JSONL export', () => {
  it('copies exact physical bytes and returns a verified SHA-256 receipt', async () => {
    const fs = new FakeFileSystem();
    const bytes = new TextEncoder().encode('{"x":1}\r\n{"x":2}\n{"x":3}');
    const source = fakeSource(fs, bytes);
    const auth = dependencies(source, { fileSystem: fs, createTemporaryId: () => 'unique-1' });

    const result = await exportRawJsonl({ source: source.snapshot, destinationPath: outputPath }, auth);

    expect(result.status).toBe('committed');
    if (result.status !== 'committed') return;
    expect(fs.files.get(outputPath)?.bytes).toEqual(bytes);
    expect(result.receipt).toMatchObject({
      schema: RAW_JSONL_EXPORT_RECEIPT_SCHEMA,
      sourceId: source.snapshot.sourceId,
      generation: source.snapshot.generation,
      authorizationEpoch: source.snapshot.authorizationEpoch,
      byteLength: String(bytes.byteLength),
      sha256: source.snapshot.sha256,
      verification: 'source-and-temp-sha256',
      commit: 'same-directory-hard-link-no-replace',
    });
    expect(auth.authorizeAndResolveSource).toHaveBeenCalledTimes(2);
    expect(fs.files.has(join(workspaceRoot, '.jsonlview-export-unique-1.tmp'))).toBe(false);
    expect(fs.unlinked).toEqual([join(workspaceRoot, '.jsonlview-export-unique-1.tmp')]);
  });

  it('refuses missing authorization before creating a temporary file', async () => {
    const fs = new FakeFileSystem();
    const bytes = new TextEncoder().encode('{}\n');
    const source = fakeSource(fs, bytes);
    const auth = dependencies(source, { fileSystem: fs, authorizeAndResolveSource: vi.fn(async () => undefined) });

    await expect(exportRawJsonl({ source: source.snapshot, destinationPath: outputPath }, auth))
      .rejects.toMatchObject({ code: 'source-not-authorized' });
    expect([...fs.files.keys()]).toEqual([sourcePath]);
  });

  it('requires the durable prepare hook to settle before linking and retains evidence if it fails', async () => {
    const fs = new FakeFileSystem();
    const source = fakeSource(fs, new TextEncoder().encode('1\n'));
    let temporary = '';
    const link = vi.spyOn(fs, 'link');
    await expect(exportRawJsonl({ source: source.snapshot, destinationPath: outputPath }, dependencies(source, {
      fileSystem: fs, retainPreparedTemporary: true, onPrepared: async (prepared) => { temporary = prepared.temporaryPath; throw new Error('journal flush failed'); },
    }))).rejects.toMatchObject({ code: 'write-failed' });
    expect(link).not.toHaveBeenCalled();
    expect(fs.files.has(outputPath)).toBe(false);
    expect(fs.files.has(temporary)).toBe(true);
  });

  it('reauthorizes after the prepare await and refuses cancellation or grant loss before linking', async () => {
    for (const mode of ['cancel', 'revoke']) {
      const fs = new FakeFileSystem();
      const source = fakeSource(fs, new TextEncoder().encode('1\n'));
      const cancellation = new AbortController();
      let allowed = true;
      const link = vi.spyOn(fs, 'link');
      await expect(exportRawJsonl({ source: source.snapshot, destinationPath: outputPath, signal: cancellation.signal }, dependencies(source, {
        fileSystem: fs, retainPreparedTemporary: true,
        authorizeAndResolveSource: async () => allowed ? source : undefined,
        onPrepared: async () => { if (mode === 'cancel') cancellation.abort(); else allowed = false; },
      }))).rejects.toMatchObject({ code: mode === 'cancel' ? 'cancelled' : 'source-not-authorized' });
      expect(link).not.toHaveBeenCalled();
      expect(fs.files.has(outputPath)).toBe(false);
    }
  });

  it.each([
    ['generation', { generation: 'generation-2' }],
    ['authorization epoch', { authorizationEpoch: '8' }],
    ['fingerprint', { sha256: `sha256:${'0'.repeat(64)}` }],
    ['document', { documentId: 'document-2' }],
  ])('rejects a %s change during precommit authorization recheck', async (_label, changed) => {
    const fs = new FakeFileSystem();
    const bytes = new TextEncoder().encode('{"turn":1}\n');
    const source = fakeSource(fs, bytes);
    let calls = 0;
    const auth = dependencies(source, {
      fileSystem: fs,
      authorizeAndResolveSource: vi.fn(async () => {
        calls += 1;
        return calls === 1 ? source : { ...source, snapshot: { ...source.snapshot, ...changed } };
      }),
    });

    await expect(exportRawJsonl({ source: source.snapshot, destinationPath: outputPath }, auth))
      .rejects.toMatchObject({ code: 'source-changed' });
    expect(fs.files.has(outputPath)).toBe(false);
  });

  it('rejects bytes that do not match the selected source snapshot fingerprint', async () => {
    const fs = new FakeFileSystem();
    const bytes = new TextEncoder().encode('{"actual":true}\n');
    const source = fakeSource(fs, bytes);
    const mismatched = { ...source.snapshot, sha256: `sha256:${'a'.repeat(64)}` };

    await expect(exportRawJsonl({ source: mismatched, destinationPath: outputPath }, dependencies(
      { ...source, snapshot: mismatched }, { fileSystem: fs },
    ))).rejects.toMatchObject({ code: 'source-changed' });
    expect(fs.files.has(outputPath)).toBe(false);
  });

  it('preserves an existing destination and never unlinks it', async () => {
    const fs = new FakeFileSystem();
    const sourceBytes = new TextEncoder().encode('{"new":true}\n');
    const originalBytes = new TextEncoder().encode('{"existing":true}\n');
    const source = fakeSource(fs, sourceBytes);
    fs.addFile(outputPath, originalBytes);

    await expect(exportRawJsonl({ source: source.snapshot, destinationPath: outputPath }, dependencies(source, { fileSystem: fs })))
      .rejects.toMatchObject({ code: 'destination-exists' });
    expect(fs.files.get(outputPath)?.bytes).toEqual(originalBytes);
    expect(fs.unlinked).not.toContain(outputPath);
  });

  it('preserves a competing file created between admission and atomic link commit', async () => {
    const fs = new FakeFileSystem();
    const sourceBytes = new TextEncoder().encode('{"new":true}\n');
    const competitorBytes = new TextEncoder().encode('{"competitor":true}\n');
    const source = fakeSource(fs, sourceBytes);
    fs.linkHook = async (_temporaryPath, destinationPath) => {
      fs.addFile(destinationPath, competitorBytes);
      throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    };

    await expect(exportRawJsonl({ source: source.snapshot, destinationPath: outputPath }, dependencies(source, { fileSystem: fs })))
      .rejects.toMatchObject({ code: 'destination-exists' });
    expect(fs.files.get(outputPath)?.bytes).toEqual(competitorBytes);
    expect(fs.unlinked).not.toContain(outputPath);
  });

  it('proves an ambiguous link error as committed only when ownership and digest both match', async () => {
    const fs = new FakeFileSystem();
    const bytes = new TextEncoder().encode('{"race":"commit"}\n');
    const source = fakeSource(fs, bytes);
    fs.linkHook = async (temporaryPath, destinationPath) => {
      const temporary = fs.files.get(temporaryPath)!;
      fs.files.set(destinationPath, temporary);
      throw new Error('ambiguous completion');
    };

    const result = await exportRawJsonl({ source: source.snapshot, destinationPath: outputPath }, dependencies(source, { fileSystem: fs }));
    expect(result.status).toBe('committed');
    expect(fs.files.get(outputPath)?.bytes).toEqual(bytes);
    expect(fs.unlinked).not.toContain(outputPath);
  });

  it('returns commit-unknown when commit outcome cannot be proven and never deletes target', async () => {
    const fs = new FakeFileSystem();
    const bytes = new TextEncoder().encode('{"race":"unknown"}\n');
    const source = fakeSource(fs, bytes);
    fs.linkHook = async (temporaryPath, destinationPath) => {
      fs.files.set(destinationPath, fs.files.get(temporaryPath)!);
      throw new Error('ambiguous completion');
    };
    fs.destinationStatError = Object.assign(new Error('denied'), { code: 'EACCES' });

    const result = await exportRawJsonl({ source: source.snapshot, destinationPath: outputPath }, dependencies(source, { fileSystem: fs }));
    expect(result).toMatchObject({ status: 'commit-unknown', sha256: source.snapshot.sha256 });
    expect(fs.files.has(outputPath)).toBe(true);
    expect(fs.unlinked).not.toContain(outputPath);
  });

  it('refuses unsupported hard-link publication without falling back to rename or copy', async () => {
    const fs = new FakeFileSystem();
    const bytes = new TextEncoder().encode('{"unsupported":true}\n');
    const source = fakeSource(fs, bytes);
    fs.linkHook = async () => { throw Object.assign(new Error('not supported'), { code: 'EPERM' }); };
    const renameOrCopy = vi.fn();

    await expect(exportRawJsonl({ source: source.snapshot, destinationPath: outputPath }, dependencies(source, { fileSystem: fs })))
      .rejects.toMatchObject({ code: 'filesystem-unsupported' });
    expect(renameOrCopy).not.toHaveBeenCalled();
    expect(fs.files.has(outputPath)).toBe(false);
    expect(fs.files.size).toBe(1);
  });

  it('detects source-file mutation while the export temp is being written', async () => {
    const fs = new FakeFileSystem();
    const bytes = new TextEncoder().encode('{"stable":true}\n');
    const source = fakeSource(fs, bytes);
    fs.syncHook = () => {
      const sourceFile = fs.files.get(sourcePath)!;
      sourceFile.bytes = new TextEncoder().encode('{"changed":true}\n');
      sourceFile.mtime += 1;
    };

    await expect(exportRawJsonl({ source: source.snapshot, destinationPath: outputPath }, dependencies(source, { fileSystem: fs })))
      .rejects.toMatchObject({ code: 'source-changed' });
    expect(fs.files.has(outputPath)).toBe(false);
  });

  it('applies the per-call byte budget and the hard maximum', async () => {
    const fs = new FakeFileSystem();
    const bytes = new TextEncoder().encode('12345');
    const source = fakeSource(fs, bytes);

    await expect(exportRawJsonl({ source: source.snapshot, destinationPath: outputPath, maxBytes: 4n }, dependencies(source, { fileSystem: fs })))
      .rejects.toMatchObject({ code: 'source-too-large' });
  });

  it('cancels before publication and cleans only its owned temporary file', async () => {
    const fs = new FakeFileSystem();
    const bytes = new TextEncoder().encode('{}\n');
    const source = fakeSource(fs, bytes);
    const cancellation = new AbortController();
    fs.syncHook = () => cancellation.abort();
    await expect(exportRawJsonl({ source: source.snapshot, destinationPath: outputPath, signal: cancellation.signal },
      dependencies(source, { fileSystem: fs }))).rejects.toMatchObject({ code: 'cancelled' });
    expect([...fs.files.keys()]).toEqual([sourcePath]);
  });

  it('preserves a replacement at its temporary pathname during failed verification', async () => {
    const fs = new FakeFileSystem();
    const source = fakeSource(fs, new TextEncoder().encode('{}\n'));
    const temporaryPath = join(workspaceRoot, '.jsonlview-export-replaced.tmp');
    fs.syncHook = () => fs.addFile(temporaryPath, new TextEncoder().encode('other owner'));
    await expect(exportRawJsonl({ source: source.snapshot, destinationPath: outputPath },
      dependencies(source, { fileSystem: fs, createTemporaryId: () => 'replaced' })))
      .rejects.toMatchObject({ code: 'verification-failed' });
    expect(fs.files.has(temporaryPath)).toBe(true);
    expect(fs.unlinked).not.toContain(temporaryPath);
  });

  it('rejects a source pathname replaced with identical bytes while its old handle remains open', async () => {
    const fs = new FakeFileSystem();
    const bytes = new TextEncoder().encode('{}\n');
    const source = fakeSource(fs, bytes);
    fs.syncHook = () => fs.addFile(sourcePath, bytes);
    await expect(exportRawJsonl({ source: source.snapshot, destinationPath: outputPath },
      dependencies(source, { fileSystem: fs }))).rejects.toMatchObject({ code: 'source-changed' });
    expect(fs.files.has(outputPath)).toBe(false);
  });

  it('stops at the selected byte length plus one when a source grows during copying', async () => {
    const fs = new FakeFileSystem();
    const source = fakeSource(fs, new TextEncoder().encode('{}\n'));
    let sourceReads = 0;
    fs.readHook = (path) => {
      if (path !== sourcePath) return;
      sourceReads += 1;
      fs.files.get(sourcePath)!.bytes = new Uint8Array(1024 * 1024).fill(32);
    };
    await expect(exportRawJsonl({ source: source.snapshot, destinationPath: outputPath },
      dependencies(source, { fileSystem: fs }))).rejects.toMatchObject({ code: 'source-changed' });
    expect(sourceReads).toBe(1);
    expect(fs.files.has(outputPath)).toBe(false);
  });

  it('rejects authorization revocation immediately before publication', async () => {
    const fs = new FakeFileSystem();
    const source = fakeSource(fs, new TextEncoder().encode('{}\n'));
    const authorize = vi.fn().mockResolvedValueOnce(source).mockResolvedValueOnce(undefined);
    await expect(exportRawJsonl({ source: source.snapshot, destinationPath: outputPath }, {
      fileSystem: fs, authorizeAndResolveSource: authorize,
    })).rejects.toMatchObject({ code: 'source-not-authorized' });
    expect(fs.files.has(outputPath)).toBe(false);
  });

  it('finishes verification after publication even when cancellation races the link', async () => {
    const fs = new FakeFileSystem();
    const source = fakeSource(fs, new TextEncoder().encode('{}\n'));
    const cancellation = new AbortController();
    fs.linkHook = async (temporary, destination) => {
      fs.files.set(destination, fs.files.get(temporary)!);
      cancellation.abort();
    };
    const result = await exportRawJsonl({ source: source.snapshot, destinationPath: outputPath, signal: cancellation.signal },
      dependencies(source, { fileSystem: fs }));
    expect(result.status).toBe('committed');
    expect(fs.files.has(outputPath)).toBe(true);
    expect(fs.unlinked).not.toContain(outputPath);
  });

  it('uses the real Windows Node hard-link primitive and leaves an existing target untouched', async () => {
    const root = await tempRoot();
    const sourcePath = join(root, 'source.jsonl');
    const destinationPath = join(root, 'export.jsonl');
    const bytes = new TextEncoder().encode('{"line":1}\r\n{"line":2}');
    await writeFile(sourcePath, bytes);
    const source = {
      authorization: 'authorized' as const,
      sourcePath,
      snapshot: snapshot(bytes),
    };
    const result = await exportRawJsonl({ source: source.snapshot, destinationPath }, dependencies(source));
    expect(result.status).toBe('committed');
    expect(new Uint8Array(await readFile(destinationPath))).toEqual(bytes);

    const replacement = new TextEncoder().encode('do not replace');
    await writeFile(join(root, 'existing.jsonl'), replacement);
    await expect(exportRawJsonl({ source: source.snapshot, destinationPath: join(root, 'existing.jsonl') }, dependencies(source)))
      .rejects.toMatchObject({ code: 'destination-exists' });
    expect(new Uint8Array(await readFile(join(root, 'existing.jsonl')))).toEqual(replacement);
  });

  it('exposes no raw filesystem failures in its typed error messages', async () => {
    const fs = new FakeFileSystem();
    const bytes = new TextEncoder().encode('{}\n');
    const source = fakeSource(fs, bytes);
    fs.linkHook = async () => { throw new Error('C:\\private\\secret.jsonl'); };
    const failing = dependencies(source, {
      fileSystem: fs,
    });

    try {
      await exportRawJsonl({ source: source.snapshot, destinationPath: outputPath }, failing);
      expect.fail('expected export failure');
    } catch (error) {
      expect(error).toBeInstanceOf(RawJsonlExportError);
      expect((error as Error).message).not.toContain('private');
    }
  });
});
