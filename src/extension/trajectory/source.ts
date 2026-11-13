import { createHash } from 'node:crypto';
import { open, realpath, stat, type FileHandle } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { TrajectoryErrorCode } from '@shared/contracts/trajectory-slice';
import { canonicalJson } from './cursor';

export interface TrajectoryAuthorization { readonly path: string; readonly epoch: string | number }
export interface TrajectorySourceOptions {
  readonly sources: ReadonlyMap<string, string>;
  readonly allowedRoots: readonly string[];
  /** Host-owned live authorization. A static stdio binding has no host revocation channel. */
  readonly authorization?: (sourceId: string) => TrajectoryAuthorization | undefined | Promise<TrajectoryAuthorization | undefined>;
}
export class TrajectoryFailure extends Error {
  public readonly code: TrajectoryErrorCode;
  public constructor(code: TrajectoryErrorCode) { super(code); this.code = code; }
}

/** Snapshot v1 deliberately contains no path and does not claim content-hash integrity. */
export function trajectorySnapshotId(sourceId: string, info: BigIntStats): string {
  if (info.size < 0n || info.mtimeNs < 0n) throw new TrajectoryFailure('IO_FAILED');
  return createHash('sha256').update(canonicalJson({ v: 1, sourceId,
    device: info.dev > 0n ? info.dev.toString() : null,
    fileId: info.ino > 0n ? info.ino.toString() : null,
    sizeBytes: info.size.toString(), mtimeUnixNs: info.mtimeNs.toString() }), 'utf8').digest('hex');
}

export class AuthorizedTrajectorySource {
  private readonly options: TrajectorySourceOptions;
  public readonly sourceId: string;
  private readonly binding: TrajectoryAuthorization;
  private readonly canonicalPath: string;
  private readonly roots: readonly string[];
  private readonly handle: FileHandle;
  public readonly size: bigint;
  public readonly snapshotId: string;
  private constructor(options: TrajectorySourceOptions, sourceId: string,
    binding: TrajectoryAuthorization, canonicalPath: string,
    roots: readonly string[], handle: FileHandle, size: bigint, snapshotId: string) {
    this.options = options; this.sourceId = sourceId; this.binding = binding; this.canonicalPath = canonicalPath;
    this.roots = roots; this.handle = handle; this.size = size; this.snapshotId = snapshotId;
  }

  public static async open(options: TrajectorySourceOptions, sourceId: string, signal?: AbortSignal): Promise<AuthorizedTrajectorySource> {
    cancelled(signal);
    const binding = await authorization(options, sourceId);
    let handle: FileHandle | undefined;
    try {
      const roots = await Promise.all(options.allowedRoots.map((root) => realpath(resolve(root))));
      const canonicalPath = await realpath(binding.path);
      if (!insideRoots(canonicalPath, roots)) throw new TrajectoryFailure('SOURCE_NOT_AUTHORIZED');
      handle = await open(canonicalPath, 'r');
      const info = await handle.stat({ bigint: true });
      if (!info.isFile()) throw new TrajectoryFailure('SOURCE_NOT_AUTHORIZED');
      const source = new AuthorizedTrajectorySource(options, sourceId, binding, canonicalPath, roots, handle,
        info.size, trajectorySnapshotId(sourceId, info));
      await source.verifyUnchanged(signal);
      return source;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      throw error instanceof TrajectoryFailure ? error : new TrajectoryFailure('IO_FAILED');
    }
  }

  public async readAt(position: bigint, length: number, signal?: AbortSignal): Promise<Buffer> {
    cancelled(signal);
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await this.handle.read(buffer, 0, length, position);
    cancelled(signal);
    return buffer.subarray(0, bytesRead);
  }

  public async verifyUnchanged(signal?: AbortSignal): Promise<void> {
    cancelled(signal);
    const binding = await authorization(this.options, this.sourceId);
    if (binding.epoch !== this.binding.epoch || resolve(binding.path) !== resolve(this.binding.path)) {
      throw new TrajectoryFailure('SOURCE_NOT_AUTHORIZED');
    }
    try {
      const path = await realpath(binding.path);
      if (!insideRoots(path, this.roots)) throw new TrajectoryFailure('SOURCE_NOT_AUTHORIZED');
      if (path !== this.canonicalPath) throw new TrajectoryFailure('SOURCE_CHANGED');
      const [held, current] = await Promise.all([this.handle.stat({ bigint: true }), stat(path, { bigint: true })]);
      if (!held.isFile() || !current.isFile() || trajectorySnapshotId(this.sourceId, held) !== this.snapshotId
        || trajectorySnapshotId(this.sourceId, current) !== this.snapshotId) throw new TrajectoryFailure('SOURCE_CHANGED');
      // Revoke may occur while path/stat I/O is outstanding.
      const after = await authorization(this.options, this.sourceId);
      if (after.epoch !== this.binding.epoch || resolve(after.path) !== resolve(this.binding.path)) {
        throw new TrajectoryFailure('SOURCE_NOT_AUTHORIZED');
      }
      cancelled(signal);
    } catch (error) { throw error instanceof TrajectoryFailure ? error : new TrajectoryFailure('SOURCE_CHANGED'); }
  }

  public async close(): Promise<void> { await this.handle.close(); }
}

async function authorization(options: TrajectorySourceOptions, sourceId: string): Promise<TrajectoryAuthorization> {
  const path = options.sources.get(sourceId);
  if (path === undefined) throw new TrajectoryFailure('SOURCE_NOT_AUTHORIZED');
  const live = options.authorization === undefined ? { path, epoch: 0 } : await options.authorization(sourceId);
  if (live === undefined || resolve(live.path) !== resolve(path)) throw new TrajectoryFailure('SOURCE_NOT_AUTHORIZED');
  return live;
}
function insideRoots(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => { const tail = relative(root, path); return tail === '' || (!isAbsolute(tail) && tail !== '..' && !tail.startsWith(`..${sep}`)); });
}
function cancelled(signal?: AbortSignal): void { if (signal?.aborted) throw new TrajectoryFailure('CANCELLED'); }
