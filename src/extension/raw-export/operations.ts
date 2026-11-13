import { randomUUID } from 'node:crypto';
import { mkdir, open, lstat, realpath, readdir, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { isExportOrdinal, isExportRequestId, isRawExportIntent, type RawExportIntent } from './intent';
import { inspectRawJsonlCommit, releaseRawJsonlTemporary, retryRawJsonlCommit, type RawJsonlPreparedCommit, type RawJsonlExportFileIdentity } from './jsonl';
import { isRawExportSourceObservation, sameRawExportObservation, type RawExportSourceObservation } from './source-observation';

const MAX_OPERATIONS = 256;
const MAX_ATTEMPTS = 8;
const MAX_JOURNAL_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
type Operation = { readonly intent: RawExportIntent; readonly destinationPath: string; readonly sourceObservation?: RawExportSourceObservation };
export interface RawExportOperation extends Operation { readonly spoolPath: string }
export interface RawExportRecovery extends Operation {
  readonly status: 'unprepared' | 'absent' | 'unknown' | 'committed';
  readonly prepared?: RawJsonlPreparedCommit;
}

/** Private Host storage. Immutable wx+sync stages; no source or destination cleanup. */
export class RawExportOperations {
  private readonly root: string;
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(root: string) { this.root = resolve(root); }

  public admit(intent: RawExportIntent, destinationPath: string, sourceObservation?: RawExportSourceObservation): Promise<RawExportOperation> {
    return this.exclusive(async () => {
      if (!isRawExportIntent(intent)) throw new Error('Invalid export intent.');
      if (sourceObservation !== undefined && (!isRawExportSourceObservation(sourceObservation) || sourceObservation.sourceUri !== intent.binding.uri)) throw new Error('Invalid source observation.');
      await this.initialize();
      const canonicalDestination = join(await realpath(dirname(resolve(destinationPath))), basename(resolve(destinationPath)));
      const directory = this.directory(intent.requestId);
      const existing = await optionalJson(join(directory, 'intent.json'));
      if (existing === undefined) {
        if ((await readdir(this.root)).filter((name) => !/^slot-\d+\.json$/u.test(name)).length >= MAX_OPERATIONS) throw new Error('Export operation storage is full; retain pending evidence and review completed operations.');
        await this.reserveSlot(intent.requestId);
        await mkdir(directory, { mode: 0o700 });
        await durableJson(join(directory, 'intent.json'), { intent, destinationPath: canonicalDestination,
          ...(sourceObservation === undefined ? {} : { sourceObservation }) });
      } else {
        const operation = readOperation(existing);
        if (operation.intent.selectionDigest !== intent.selectionDigest || operation.destinationPath !== canonicalDestination
          || JSON.stringify(operation.intent) !== JSON.stringify(intent)) throw new Error('Export operation identity conflict.');
        if (operation.sourceObservation !== undefined && (sourceObservation === undefined
          || !sameRawExportObservation(operation.sourceObservation, sourceObservation))) throw new Error('Export source observation changed.');
        if (await optionalJson(join(directory, 'prepared.json')) !== undefined) throw new Error('Inspect the prepared export before retrying publication.');
      }
      await assertDirectory(directory);
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const spoolPath = join(directory, 'spool-' + randomUUID() + '.jsonl');
        try {
          await durableJson(join(directory, `attempt-${attempt}.json`), { spool: basename(spoolPath) });
          return { intent, destinationPath: canonicalDestination, spoolPath,
            ...(sourceObservation === undefined ? {} : { sourceObservation }) };
        } catch (error) { if (!hasCode(error, 'EEXIST')) throw error; }
      }
      throw new Error('Export retry budget exhausted. Pending evidence was retained.');
    });
  }

  public prepare(requestId: string, prepared: RawJsonlPreparedCommit): Promise<void> {
    return this.exclusive(async () => {
      const operation = await this.load(requestId);
      const validated = readPrepared(prepared, operation.destinationPath);
      await durableJson(join(this.directory(requestId), 'prepared.json'), validated);
    });
  }

  public recordSpool(requestId: string, spoolPath: string, evidence: { byteLength: string; sha256: string }): Promise<void> {
    return this.exclusive(async () => {
      await this.load(requestId);
      const directory = this.directory(requestId);
      if (dirname(spoolPath) !== directory || !/^spool-[a-f0-9-]{36}\.jsonl$/u.test(basename(spoolPath))) throw new Error('Invalid owned export spool.');
      const stat = await lstat(spoolPath, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size.toString() !== evidence.byteLength) throw new Error('Export spool changed.');
      const identity: RawJsonlExportFileIdentity = { device: stat.dev.toString(), inode: stat.ino.toString(),
        size: stat.size.toString(), mtimeNs: stat.mtimeNs.toString(), ctimeNs: stat.ctimeNs.toString(), isFile: true, isSymbolicLink: false };
      await durableJson(join(directory, 'spool-evidence-' + basename(spoolPath) + '.json'), { name: basename(spoolPath), identity, ...evidence });
    });
  }

  public inspect(requestId: string): Promise<RawExportRecovery> {
    return this.exclusive(() => this.inspectInternal(requestId));
  }

  public retry(requestId: string, authorize: (intent: RawExportIntent) => Promise<boolean>, signal?: AbortSignal): Promise<RawExportRecovery> {
    return this.exclusive(async () => {
      const before = await this.inspectInternal(requestId);
      if (before.status !== 'absent' || before.prepared === undefined) return before;
      await retryRawJsonlCommit(before.prepared, () => authorize(before.intent), signal);
      return this.inspectInternal(requestId);
    });
  }

  public async list(): Promise<readonly string[]> {
    await this.initialize();
    const entries = await readdir(this.root);
    if (entries.filter((name) => !/^slot-\d+\.json$/u.test(name)).length > MAX_OPERATIONS) throw new Error('Export journal exceeds its operation cap.');
    return entries.filter(isExportRequestId).sort();
  }

  private async inspectInternal(requestId: string): Promise<RawExportRecovery> {
    const operation = await this.load(requestId);
    const directory = this.directory(requestId);
    const rawPrepared = await optionalJson(join(directory, 'prepared.json'));
    const committed = await optionalJson(join(directory, 'committed.json'));
    if (rawPrepared === undefined) {
      if (committed !== undefined) throw new Error('Invalid export journal.');
      return { ...operation, status: 'unprepared' };
    }
    const prepared = readPrepared(rawPrepared, operation.destinationPath);
    if (committed !== undefined && (!isObject(committed) || committed.requestId !== requestId
      || committed.selectionDigest !== operation.intent.selectionDigest)) throw new Error('Invalid export receipt.');
    const proof = await inspectRawJsonlCommit(prepared);
    if (proof === 'owned-and-verified') {
      if (committed === undefined) await durableJson(join(directory, 'committed.json'), {
        requestId, selectionDigest: operation.intent.selectionDigest, byteLength: prepared.byteLength, sha256: prepared.sha256,
      });
      await releaseRawJsonlTemporary(prepared);
      const entries = await readdir(directory);
      for (const name of entries.filter((entry) => /^spool-evidence-spool-[a-f0-9-]{36}\.jsonl\.json$/u.test(entry))) {
        const evidence = await optionalJson(join(directory, name));
        if (!isObject(evidence) || typeof evidence.name !== 'string' || name !== 'spool-evidence-' + evidence.name + '.json'
          || !isObject(evidence.identity) || !isIdentityPart(evidence.identity.device) || !isIdentityPart(evidence.identity.inode)) {
          throw new Error('Invalid export spool evidence.');
        }
        await releaseRawJsonlTemporary({ temporaryPath: join(directory, evidence.name), destinationPath: operation.destinationPath,
          identity: evidence.identity as unknown as RawJsonlExportFileIdentity, byteLength: prepared.byteLength, sha256: prepared.sha256 });
      }
      return { ...operation, prepared, status: 'committed' };
    }
    // A previously committed destination may have been moved/deleted by its owner.
    // Such an operation must never recreate it on retry.
    return { ...operation, prepared, status: proof === 'absent' && committed === undefined ? 'absent' : 'unknown' };
  }

  private async load(requestId: string): Promise<Operation> {
    await this.initialize();
    const directory = this.directory(requestId);
    await assertDirectory(directory);
    const operation = readOperation(await optionalJson(join(directory, 'intent.json')));
    if (operation.intent.requestId !== requestId) throw new Error('Export operation identity conflict.');
    return operation;
  }

  private directory(requestId: string): string {
    if (!isExportRequestId(requestId)) throw new Error('Invalid export operation ID.');
    return join(this.root, requestId);
  }

  private async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await assertDirectory(this.root);
  }

  private async reserveSlot(requestId: string): Promise<void> {
    // Immutable exclusive slots bound admission across multiple VS Code hosts.
    // A crash can consume a slot; it cannot silently evict pending evidence.
    for (let slot = 0; slot < MAX_OPERATIONS; slot++) {
      const path = join(this.root, `slot-${slot}.json`);
      const existing = await optionalJson(path);
      if (existing !== undefined) {
        if (!isObject(existing) || !isExportRequestId(existing.requestId)) throw new Error('Invalid export admission slot.');
        if (existing.requestId === requestId) return;
        continue;
      }
      try { await durableJson(path, { requestId }); return; }
      catch (error) { if (!hasCode(error, 'EEXIST')) throw error; }
    }
    throw new Error('Export operation storage is full; retained slots require explicit review.');
  }

  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.catch(() => undefined).then(action);
    this.queue = result;
    return result;
  }
}

function readOperation(value: unknown): Operation {
  if (!isObject(value) || !isObject(value.intent) || typeof value.destinationPath !== 'string'
    || !isAbsolute(value.destinationPath) || value.destinationPath.length > 32768
    || !isRawExportIntent(value.intent)
    || (value.sourceObservation !== undefined && (!isRawExportSourceObservation(value.sourceObservation)
      || value.sourceObservation.sourceUri !== value.intent.binding.uri))) throw new Error('Invalid export operation journal.');
  return value as unknown as Operation;
}

function readPrepared(value: unknown, destination: string): RawJsonlPreparedCommit {
  if (!isObject(value) || value.destinationPath !== destination || typeof value.temporaryPath !== 'string'
    || dirname(value.temporaryPath) !== dirname(destination)
    || !/^\.jsonlview-export-[a-f0-9-]{36}\.tmp$/u.test(basename(value.temporaryPath))
    || !isExportOrdinal(value.byteLength) || BigInt(value.byteLength) > BigInt(MAX_OUTPUT_BYTES)
    || typeof value.sha256 !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value.sha256)
    || !isObject(value.identity) || value.identity.isFile !== true || value.identity.isSymbolicLink !== false
    || !isIdentityPart(value.identity.device) || !isIdentityPart(value.identity.inode) || value.identity.inode === '0'
    || value.identity.size !== value.byteLength || !isIdentityPart(value.identity.mtimeNs) || !isIdentityPart(value.identity.ctimeNs)) {
    throw new Error('Invalid prepared export evidence.');
  }
  return value as unknown as RawJsonlPreparedCommit;
}

async function durableJson(path: string, value: unknown): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > MAX_JOURNAL_BYTES) throw new Error('Export journal record is too large.');
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

async function optionalJson(path: string): Promise<unknown> {
  let handle: FileHandle | undefined;
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_JOURNAL_BYTES) throw new Error('Invalid export journal file.');
    handle = await open(path, 'r');
    const held = await handle.stat();
    if (held.dev !== before.dev || held.ino !== before.ino || held.size !== before.size) throw new Error('Export journal changed.');
    const buffer = Buffer.alloc(held.size + 1);
    let position = 0;
    while (position < buffer.length) {
      const read = await handle.read(buffer, position, buffer.length - position, position);
      if (read.bytesRead === 0) break;
      position += read.bytesRead;
    }
    if (position !== held.size) throw new Error('Export journal changed.');
    return JSON.parse(buffer.subarray(0, position).toString('utf8')) as unknown;
  } catch (error) { if (hasCode(error, 'ENOENT')) return undefined; throw error; }
  finally { await handle?.close(); }
}

async function assertDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid export journal directory.');
}
function hasCode(value: unknown, code: string): boolean { return isObject(value) && value.code === code; }
function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function isIdentityPart(value: unknown): value is string { return typeof value === 'string' && /^\d{1,64}$/u.test(value); }
