import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, open, realpath, rmdir, unlink, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import * as vscode from 'vscode';
import type { TemporaryPreviewStatus } from '@shared/types';

export const MAX_SESSION_PREVIEWS = 20;
const MAX_BYTES = 1_048_576;
const MAX_DEFAULT_FILENAME_LENGTH = 120;
const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/gu;
const RESERVED_FILENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
interface FileIdentity { readonly dev: number; readonly ino: number; readonly size: number; readonly mtimeMs: number }
export interface SessionPreview {
  readonly id: string;
  readonly createdAt: number;
  readonly recordCount: number;
  readonly sizeBytes: number;
  readonly sourceUri: vscode.Uri;
  /** Saved means a permanent copy exists; sourceUri is still temporary. */
  readonly status: 'temporary' | 'saving' | 'saved';
  readonly savedUri?: vscode.Uri;
}
export type PreviewSaveOutcome = 'cancelled' | 'failed' | 'saved' | 'saved-open-failed';
interface OwnedPreview { metadata: SessionPreview; identity: FileIdentity; saving?: Promise<PreviewSaveOutcome> }
const sameFile = (a: FileIdentity, b: FileIdentity): boolean => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
const pathKey = (path: string): string => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);

/** Derive a bounded, portable filename for a temporary preview Save As dialog. */
export function derivePreviewFilename(sourceUri: vscode.Uri, previewId = ''): string {
  const identity = previewId.replace(/[^a-z0-9_-]/giu, '').slice(0, 16);
  const fallback = `jsonlview-preview${identity === '' ? '' : '-' + identity}.jsonl`;
  const raw = basename(sourceUri.fsPath).trim();
  if (raw === '') return fallback;
  const sanitized = raw.replace(INVALID_FILENAME_CHARS, '-').replace(/[ .]+$/u, '').trim();
  if (sanitized === '' || sanitized === '.' || sanitized === '..' || RESERVED_FILENAME.test(sanitized)) return fallback;
  const extensionMatch = sanitized.match(/(\.jsonl|\.ndjson)$/iu);
  const extension = extensionMatch?.[1] ?? '.jsonl';
  const stem = (extensionMatch === null ? sanitized.replace(/\.[^.]*$/u, '') : sanitized.slice(0, -extension.length)).replace(/[ .]+$/u, '');
  const boundedStem = stem.slice(0, Math.max(1, MAX_DEFAULT_FILENAME_LENGTH - extension.length)).replace(/[ .]+$/u, '');
  return boundedStem === '' ? fallback : boundedStem + extension;
}

/** In-memory metadata and exact ownership for this extension-host session only. */
export class SessionPreviews implements vscode.Disposable {
  readonly #items = new Map<string, OwnedPreview>();
  readonly #listeners = new Set<() => void>();
  readonly #lifetime = new AbortController();
  #directory: string | undefined;
  #directoryIdentity: FileIdentity | undefined;
  #creating: Promise<unknown> = Promise.resolve();
  #disposal: Promise<void> | undefined;

  public onDidChange(listener: () => void): vscode.Disposable {
    this.#listeners.add(listener);
    return { dispose: () => { this.#listeners.delete(listener); } };
  }
  public list(): readonly SessionPreview[] { return [...this.#items.values()].map((item) => item.metadata); }
  public get(uri: vscode.Uri): SessionPreview | undefined { return this.find(uri)?.metadata; }
  public status(uri: vscode.Uri): TemporaryPreviewStatus | undefined {
    const item = this.get(uri);
    return item === undefined ? undefined : { status: item.status, recordCount: item.recordCount, sizeBytes: item.sizeBytes, savedCopy: item.savedUri !== undefined };
  }
  private find(uri: vscode.Uri): OwnedPreview | undefined {
    return [...this.#items.values()].find((item) => item.metadata.sourceUri.toString() === uri.toString());
  }
  private emit(): void { for (const listener of this.#listeners) { try { listener(); } catch { /* An observer cannot change ownership. */ } } }
  private update(item: OwnedPreview, patch: Partial<SessionPreview>): void {
    item.metadata = Object.freeze({ ...item.metadata, ...patch }); this.emit();
  }

  public create(text: string, recordCount: number, signal: AbortSignal): Promise<SessionPreview | undefined> {
    const operation = this.#creating.then(async () => {
      if (signal.aborted || this.#lifetime.signal.aborted) return undefined;
      if (this.#items.size >= MAX_SESSION_PREVIEWS) throw new Error('This session already has 20 previews. Save As keeps a permanent copy; existing previews remain available until this VS Code session ends.');
      if (!Number.isSafeInteger(recordCount) || recordCount < 1 || recordCount > 10_000 || Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('The preview exceeds the paste limits.');
      if (this.#directory === undefined) {
        this.#directory = await mkdtemp(join(tmpdir(), 'jsonlview-intake-'));
        this.#directoryIdentity = await lstat(this.#directory);
      }
      if (!await this.ownsDirectory()) throw new Error('The temporary preview directory is no longer available.');
      const id = randomUUID();
      const sourceUri = vscode.Uri.file(join(this.#directory, 'preview-' + id + '.jsonl'));
      let handle: FileHandle | undefined;
      let item: OwnedPreview | undefined;
      try {
        handle = await open(sourceUri.fsPath, 'wx', 0o600);
        item = { identity: await handle.stat(), metadata: Object.freeze({ id, createdAt: Date.now(), recordCount, sizeBytes: Buffer.byteLength(text, 'utf8'), sourceUri, status: 'temporary' }) };
        this.#items.set(id, item);
        await handle.writeFile(text, { encoding: 'utf8' });
        item.identity = await handle.stat();
        await handle.close(); handle = undefined;
        if (signal.aborted || this.#lifetime.signal.aborted) { await this.remove(id); return undefined; }
        this.emit(); return item.metadata;
      } catch {
        if (handle !== undefined) {
          if (item !== undefined) item.identity = await handle.stat().catch(() => item!.identity);
          await handle.close().catch(() => {});
        }
        if (item !== undefined) await this.remove(id);
        throw new Error('Could not create the temporary preview.');
      }
    });
    this.#creating = operation.catch(() => {});
    return operation;
  }

  public async reopen(id: string): Promise<void> {
    const item = this.#items.get(id);
    if (item === undefined || this.#lifetime.signal.aborted) return;
    try {
      await this.readOwned(item);
      if (!this.#lifetime.signal.aborted) await vscode.commands.executeCommand('vscode.openWith', item.metadata.sourceUri, 'jsonlView.editor');
    } catch { if (!this.#lifetime.signal.aborted) void vscode.window.showErrorMessage('This temporary preview is missing, changed, or unavailable.'); }
  }

  public saveAs(uri: vscode.Uri, isCurrent: () => boolean = () => true): Promise<PreviewSaveOutcome> {
    const item = this.find(uri);
    if (item === undefined || this.#lifetime.signal.aborted || !isCurrent()) return Promise.resolve('cancelled');
    if (item.saving !== undefined) return item.saving;
    const previous = item.metadata.status;
    let complete!: (outcome: PreviewSaveOutcome) => void;
    const operation = new Promise<PreviewSaveOutcome>((resolve) => { complete = resolve; }).finally(() => {
      delete item.saving;
      if (item.metadata.status === 'saving') this.update(item, { status: previous });
    });
    item.saving = operation;
    this.update(item, { status: 'saving' });
    void this.save(item, isCurrent).then(complete, () => complete('failed'));
    return operation;
  }

  private async chooseDestination(item: OwnedPreview): Promise<vscode.Uri | undefined> {
    const signal = this.#lifetime.signal;
    if (signal.aborted) return undefined;
    const filename = derivePreviewFilename(item.metadata.sourceUri, item.metadata.id);
    const directory = this.#directory === undefined ? tmpdir() : dirname(this.#directory);
    const dialog = Promise.resolve(vscode.window.showSaveDialog({
      title: 'Save temporary preview as',
      saveLabel: 'Save As',
      defaultUri: vscode.Uri.file(join(directory, filename)),
      filters: { 'JSONL / NDJSON': ['jsonl', 'ndjson'] },
    }));
    return new Promise((complete, reject) => {
      const aborted = (): void => complete(undefined);
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) aborted();
      void dialog.then((value) => { signal.removeEventListener('abort', aborted); complete(value); }, (error: unknown) => { signal.removeEventListener('abort', aborted); reject(error); });
    });
  }

  private async save(item: OwnedPreview, isCurrent: () => boolean): Promise<PreviewSaveOutcome> {
    let destination: vscode.Uri | undefined;
    try {
      destination = await this.chooseDestination(item);
      if (destination === undefined || this.#lifetime.signal.aborted || !isCurrent()) return 'cancelled';
      if (destination.scheme !== 'file' || destination.authority !== '' || destination.query !== '' || destination.fragment !== '' || !isAbsolute(destination.fsPath) || /^[\\/]{2}/u.test(destination.fsPath)) throw new Error('invalid target');
      const parent = await realpath(dirname(destination.fsPath));
      const targetPath = join(parent, basename(destination.fsPath));
      if (/^[\\/]{2}/u.test(parent) || pathKey(targetPath) === pathKey(item.metadata.sourceUri.fsPath)) throw new Error('invalid target');
      if (this.#directory !== undefined) {
        const within = relative(pathKey(this.#directory), pathKey(targetPath));
        if (within === '' || (within !== '..' && !within.startsWith('..' + sep) && !isAbsolute(within))) throw new Error('temporary target');
      }
      const bytes = await this.readOwned(item);
      if (this.#lifetime.signal.aborted || !isCurrent()) return 'cancelled';
      // From this point, finish the write even if a tab closes. Cleanup drains it.
      await this.writeExclusive(targetPath, bytes);
      destination = vscode.Uri.file(targetPath);
      this.update(item, { status: 'saved', savedUri: destination });
    } catch {
      if (!this.#lifetime.signal.aborted) void vscode.window.showErrorMessage('Could not save the preview. Choose a new local filename; existing files are never overwritten. The temporary preview is still available. An incomplete destination may remain.');
      return 'failed';
    }
    if (!this.#lifetime.signal.aborted && isCurrent()) {
      try {
        const opening = Promise.resolve(vscode.commands.executeCommand('vscode.openWith', destination, 'jsonlView.editor')).then(() => true, () => false);
        const signal = this.#lifetime.signal;
        const opened = await new Promise<boolean | undefined>((complete) => {
          const aborted = (): void => complete(undefined);
          signal.addEventListener('abort', aborted, { once: true });
          if (signal.aborted) aborted();
          void opening.then((value) => { signal.removeEventListener('abort', aborted); complete(value); });
        });
        if (opened === false) throw new Error('open failed');
      }
      catch {
        if (!this.#lifetime.signal.aborted && isCurrent()) void vscode.window.showInformationMessage('The preview copy was saved, but VS Code could not open it.');
        return 'saved-open-failed';
      }
    }
    return 'saved';
  }

  private async readOwned(item: OwnedPreview): Promise<Buffer> {
    if (!await this.ownsDirectory()) throw new Error('unavailable');
    const path = item.metadata.sourceUri.fsPath;
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || !sameFile(before, item.identity)) throw new Error('changed');
    const handle = await open(path, 'r');
    try {
      if (!sameFile(await handle.stat(), item.identity)) throw new Error('changed');
      const buffer = Buffer.alloc(item.metadata.sizeBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      const bytes = buffer.subarray(0, length);
      if (bytes.length !== item.metadata.sizeBytes || !sameFile(await handle.stat(), item.identity) || !sameFile(await lstat(path), item.identity)) throw new Error('changed');
      return bytes;
    } finally { await handle.close(); }
  }

  private async writeExclusive(path: string, bytes: Buffer): Promise<void> {
    const handle = await open(path, 'wx+', 0o600);
    let created: FileIdentity | undefined;
    try {
      created = await handle.stat();
      await handle.writeFile(bytes);
      await handle.sync();
      const owned = await handle.stat();
      const check = Buffer.alloc(bytes.length);
      let length = 0;
      while (length < check.length) {
        const { bytesRead } = await handle.read(check, length, check.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length !== bytes.length || owned.size !== bytes.length || !check.equals(bytes) || !sameFile(await handle.stat(), owned) || !sameFile(await lstat(path), owned)) throw new Error('write verification failed');
    } catch (error) {
      await handle.close().catch(() => {});
      try {
        const current = await lstat(path);
        // Never adopt failure-time attributes: another writer may own those bytes.
        if (created !== undefined && current.isFile() && !current.isSymbolicLink() && sameFile(current, created)) await unlink(path);
      } catch { /* Keep partial or replaced files when ownership cannot be proven. */ }
      throw error;
    }
    await handle.close().catch(() => { /* Verified and flushed copy remains saved. */ });
  }

  public async remove(id: string): Promise<void> {
    const item = this.#items.get(id);
    if (item === undefined || !await this.ownsDirectory()) return;
    try {
      const current = await lstat(item.metadata.sourceUri.fsPath);
      if (!current.isFile() || current.isSymbolicLink() || !sameFile(current, item.identity)) return;
      await unlink(item.metadata.sourceUri.fsPath); this.#items.delete(id); this.emit();
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.#items.delete(id); this.emit(); } }
  }
  private async ownsDirectory(): Promise<boolean> {
    if (this.#directory === undefined || this.#directoryIdentity === undefined) return false;
    try {
      const current = await lstat(this.#directory);
      return current.isDirectory() && !current.isSymbolicLink() && current.dev === this.#directoryIdentity.dev && current.ino === this.#directoryIdentity.ino && pathKey(await realpath(this.#directory)) === pathKey(this.#directory);
    } catch { return false; }
  }
  public dispose(): Promise<void> {
    if (this.#disposal !== undefined) return this.#disposal;
    this.#lifetime.abort();
    this.#disposal = (async () => {
      await this.#creating;
      await Promise.allSettled([...this.#items.values()].flatMap((item) => item.saving === undefined ? [] : [item.saving]));
      for (const id of this.#items.keys()) await this.remove(id);
      if (await this.ownsDirectory()) { try { await rmdir(this.#directory!); } catch { /* Non-recursive, best effort only. */ } }
      this.#listeners.clear();
    })();
    return this.#disposal;
  }
}
