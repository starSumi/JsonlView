import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, open, realpath, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import * as vscode from 'vscode';
import { getSourceDropHtml, getSourceIntakeHtml } from './source-intake-html';

export const SOURCE_INTAKE_MAX_BYTES = 1_048_576;
export const SOURCE_INTAKE_MAX_RECORDS = 10_000;
const MAX_SOURCES = 32;
const MAX_PREVIEWS = 20;

type IntakeMessage =
  | { readonly type: 'pick-files' | 'pick-folder' }
  | { readonly type: 'drop-uris'; readonly uris: readonly string[] }
  | { readonly type: 'import-jsonl'; readonly text: string };

export function parseSourceIntakeMessage(value: unknown): IntakeMessage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid source request.');
  const message = value as Record<string, unknown>;
  const keys = Object.keys(message);
  if ((message.type === 'pick-files' || message.type === 'pick-folder') && keys.length === 1) return { type: message.type };
  if (message.type === 'import-jsonl' && keys.length === 2 && typeof message.text === 'string') {
    if (message.text.length > SOURCE_INTAKE_MAX_BYTES || Buffer.byteLength(message.text, 'utf8') > SOURCE_INTAKE_MAX_BYTES) {
      throw new Error('JSONL preview is limited to 1 MiB. Choose Files to open a larger local source.');
    }
    return { type: 'import-jsonl', text: message.text };
  }
  if (message.type === 'drop-uris' && keys.length === 2 && Array.isArray(message.uris)
    && message.uris.length > 0 && message.uris.length <= MAX_SOURCES
    && message.uris.every((uri: unknown) => typeof uri === 'string' && uri.length > 0 && uri.length <= 8_192)
    && message.uris.join('').length <= 65_536) {
    return { type: 'drop-uris', uris: message.uris as string[] };
  }
  throw new Error('Invalid or oversized source request.');
}

/** Validation preserves the exact content; blank or malformed records are never discarded. */
export function validatePastedJsonl(text: string): number {
  parseSourceIntakeMessage({ type: 'import-jsonl', text });
  if (text.length === 0) throw new Error('Paste at least one JSON record.');
  if (Buffer.from(text, 'utf8').toString('utf8') !== text) throw new Error('JSONL must contain valid Unicode text.');
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length > SOURCE_INTAKE_MAX_RECORDS) throw new Error('JSONL preview is limited to 10,000 records.');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim().length === 0) throw new Error(`Line ${String(index + 1)} is blank. Every JSONL line must contain a JSON value.`);
    try { JSON.parse(line); }
    catch { throw new Error(`Line ${String(index + 1)} is not valid JSON.`); }
  }
  return lines.length;
}

/** Only explicit local filesystem paths enter source authorization; no remote/command URI resolution. */
export async function validateLocalSourceUri(value: string): Promise<vscode.Uri> {
  if (value.length === 0 || value.length > 8_192 || /[\u0000-\u001f]/u.test(value)) throw new Error('Choose a local file or folder.');
  const uri = vscode.Uri.parse(value, true);
  if (uri.scheme !== 'file' || uri.authority !== '' || uri.query !== '' || uri.fragment !== ''
    || !isAbsolute(uri.fsPath) || /^[\\/]{2}/u.test(uri.fsPath)
    || /[\u0000-\u001f]/u.test(uri.fsPath)) throw new Error('Only local file and folder URIs are supported.');
  const stat = await lstat(uri.fsPath);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error('Choose a regular file or folder, not a symbolic link or device.');
  // Resolve parent junctions/symlinks before the root's explicit authorization dialog.
  const canonical = await realpath(uri.fsPath);
  if (/^[\\/]{2}/u.test(canonical)) throw new Error('Only local file and folder URIs are supported.');
  return vscode.Uri.file(canonical);
}

export type SourceIntakeHandler = (uri: vscode.Uri, signal: AbortSignal) => Promise<void>;

/** Session-owned controller. Closing its panel leaves an already-open temporary preview readable. */
export class SourceIntakePanel implements vscode.Disposable, vscode.WebviewViewProvider {
  readonly #onSource: SourceIntakeHandler;
  readonly #lifetime = new AbortController();
  readonly #previews = new Map<string, { readonly dev: number; readonly ino: number; readonly size?: number; readonly mtimeMs?: number }>();
  #panel: vscode.WebviewPanel | undefined;
  #view: vscode.WebviewView | undefined;
  #panelLifetime: AbortController | undefined;
  #viewLifetime: AbortController | undefined;
  #pending: Promise<void> | undefined;
  #directory: string | undefined;
  #directoryIdentity: { readonly dev: number; readonly ino: number } | undefined;
  #disposal: Promise<void> | undefined;

  public constructor(onSource: SourceIntakeHandler) { this.#onSource = onSource; }

  public resolveWebviewView(view: vscode.WebviewView): void {
    if (this.#lifetime.signal.aborted) return;
    this.#view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = getSourceDropHtml();
    const controller = new AbortController();
    this.#viewLifetime = controller;
    const listener = view.webview.onDidReceiveMessage((message: unknown) => {
      if (controller.signal.aborted) return;
      if (this.#pending !== undefined) {
        void this.post(view.webview, controller.signal, 'idle', 'Finish or cancel the current source selection first.');
        return;
      }
      const operation = this.receive(message, view.webview, controller.signal);
      this.#pending = operation;
      void operation.finally(() => { if (this.#pending === operation) this.#pending = undefined; });
    });
    view.onDidDispose(() => {
      controller.abort(); listener.dispose();
      if (this.#view === view) { this.#view = undefined; this.#viewLifetime = undefined; }
    });
  }

  public show(): void {
    if (this.#lifetime.signal.aborted) return;
    if (this.#panel !== undefined) { this.#panel.reveal(); return; }
    const panel = vscode.window.createWebviewPanel('jsonlView.sourceIntake', 'Add Source', vscode.ViewColumn.Active, {
      enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true,
    });
    this.#panel = panel;
    const controller = new AbortController();
    this.#panelLifetime = controller;
    panel.webview.html = getSourceIntakeHtml();
    const listener = panel.webview.onDidReceiveMessage((message: unknown) => {
      if (controller.signal.aborted) return;
      if (this.#pending !== undefined) {
        void this.post(panel.webview, controller.signal, 'idle', 'Finish or cancel the current source selection first.');
        return;
      }
      const operation = this.receive(message, panel.webview, controller.signal);
      this.#pending = operation;
      void operation.finally(() => { if (this.#pending === operation) this.#pending = undefined; });
    });
    panel.onDidDispose(() => {
      controller.abort(); listener.dispose();
      if (this.#panel === panel) { this.#panel = undefined; this.#panelLifetime = undefined; }
    });
  }

  public dispose(): Promise<void> {
    if (this.#disposal !== undefined) return this.#disposal;
    this.#lifetime.abort(); this.#panelLifetime?.abort(); this.#viewLifetime?.abort(); this.#panel?.dispose();
    this.#disposal = this.cleanup();
    return this.#disposal;
  }

  private async receive(raw: unknown, webview: vscode.Webview, signal: AbortSignal): Promise<void> {
    try {
      const message = parseSourceIntakeMessage(raw);
      await this.post(webview, signal, 'busy', 'Adding source…');
      if (signal.aborted) return;
      if (message.type === 'import-jsonl') {
        const records = validatePastedJsonl(message.text);
        await this.openPreview(message.text, signal);
        await this.post(webview, signal, 'success', `Opened a temporary preview with ${String(records)} records.`, true);
        return;
      }
      const selected = message.type === 'drop-uris' ? message.uris : (await vscode.window.showOpenDialog({
        canSelectFiles: message.type === 'pick-files', canSelectFolders: message.type === 'pick-folder',
        canSelectMany: message.type === 'pick-files', openLabel: 'Add Source',
        ...(message.type === 'pick-files' ? { filters: { 'JSONL / NDJSON': ['jsonl', 'ndjson'], 'All files': ['*'] } } : {}),
      }))?.map((uri) => uri.toString());
      if (signal.aborted) return;
      if (selected === undefined || selected.length === 0) { await this.post(webview, signal, 'idle', 'No source selected.'); return; }
      if (selected.length > MAX_SOURCES) throw new Error('Choose up to 32 sources at a time.');
      // Validate the complete selection before authorizing any source.
      const uris: vscode.Uri[] = [];
      for (const value of [...new Set(selected)]) {
        const uri = await validateLocalSourceUri(value);
        if (signal.aborted) return;
        uris.push(uri);
      }
      for (const uri of uris) {
        if (signal.aborted) return;
        await this.#onSource(uri, signal);
      }
      await this.post(webview, signal, 'idle', 'Source selection complete.');
    } catch (error) {
      await this.post(webview, signal, 'error', error instanceof Error ? error.message : 'Could not add this source.');
    }
  }

  private async post(webview: vscode.Webview, signal: AbortSignal, state: string, text: string, clearText = false): Promise<void> {
    if (signal.aborted || this.#lifetime.signal.aborted) return;
    try { await webview.postMessage({ type: 'status', state, text, clearText }); }
    catch { /* The panel may close between the signal check and delivery. */ }
  }

  private async openPreview(text: string, signal: AbortSignal): Promise<void> {
    if (this.#previews.size >= MAX_PREVIEWS) throw new Error('This session has 20 temporary previews. Save your work and reload VS Code to start a new session.');
    if (this.#directory === undefined) {
      this.#directory = await mkdtemp(join(tmpdir(), 'jsonlview-intake-'));
      const stat = await lstat(this.#directory);
      this.#directoryIdentity = { dev: stat.dev, ino: stat.ino };
    }
    if (signal.aborted) return;
    const path = join(this.#directory, `preview-${randomUUID()}.jsonl`);
    try {
      const handle = await open(path, 'wx', 0o600);
      try {
        const stat = await handle.stat();
        this.#previews.set(path, { dev: stat.dev, ino: stat.ino });
        await handle.writeFile(text, { encoding: 'utf8' });
        const written = await handle.stat();
        this.#previews.set(path, { dev: written.dev, ino: written.ino, size: written.size, mtimeMs: written.mtimeMs });
      }
      finally { await handle.close(); }
      if (signal.aborted) { await this.removePreview(path); return; }
      await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(path), 'jsonlView.editor');
    } catch (error) {
      await this.removePreview(path);
      throw error;
    }
  }

  private async ownsDirectory(): Promise<boolean> {
    if (this.#directory === undefined || this.#directoryIdentity === undefined) return false;
    try {
      const stat = await lstat(this.#directory);
      return stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === this.#directoryIdentity.dev
        && stat.ino === this.#directoryIdentity.ino && resolve(await realpath(this.#directory)) === resolve(this.#directory);
    } catch { return false; }
  }

  private async removePreview(path: string): Promise<void> {
    const owned = this.#previews.get(path);
    if (owned === undefined || !await this.ownsDirectory()) return;
    try {
      const current = await lstat(path);
      if (!current.isFile() || current.isSymbolicLink() || current.dev !== owned.dev || current.ino !== owned.ino
        || (owned.size !== undefined && current.size !== owned.size)
        || (owned.mtimeMs !== undefined && current.mtimeMs !== owned.mtimeMs)) return;
      await unlink(path); this.#previews.delete(path);
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') this.#previews.delete(path); }
  }

  private async cleanup(): Promise<void> {
    await this.#pending;
    for (const path of this.#previews.keys()) await this.removePreview(path);
    if (await this.ownsDirectory()) {
      // Deliberately non-recursive: files not created by this controller are never removed.
      try { await rmdir(this.#directory!); } catch { /* Retain an occupied or locked directory. */ }
    }
  }
}
