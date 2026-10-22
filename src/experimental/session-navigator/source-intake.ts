import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import * as vscode from 'vscode';
import { getSourceDropHtml, getSourceIntakeHtml } from './source-intake-html';
import { sessionNavigatorProviderLabel, type DetectedAgentProviderId } from './types';
import { SessionPreviews } from './session-previews';

export const SOURCE_INTAKE_MAX_BYTES = 1_048_576;
export const SOURCE_INTAKE_MAX_RECORDS = 10_000;
const MAX_SOURCES = 32;

type IntakeMessage =
  | { readonly type: 'pick-files' | 'pick-folder' }
  | { readonly type: 'paste-jsonl' | 'connect-agent' }
  | { readonly type: 'drop-uris'; readonly uris: readonly string[] }
  | { readonly type: 'import-jsonl'; readonly text: string }
  | { readonly type: 'authorize-agent'; readonly provider: DetectedAgentProviderId }
  | { readonly type: 'webview-diagnostic'; readonly name: string; readonly message: string };

export function parseSourceIntakeMessage(value: unknown): IntakeMessage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid source request.');
  const message = value as Record<string, unknown>;
  const keys = Object.keys(message);
  if ((message.type === 'pick-files' || message.type === 'pick-folder' || message.type === 'paste-jsonl' || message.type === 'connect-agent') && keys.length === 1) return { type: message.type };
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
  if (message.type === 'webview-diagnostic' && keys.length === 3
    && typeof message.name === 'string' && message.name.length > 0 && message.name.length <= 128
    && typeof message.message === 'string' && message.message.length > 0 && message.message.length <= 512) {
    return { type: 'webview-diagnostic', name: message.name, message: message.message };
  }
  if (message.type === 'authorize-agent' && keys.length === 2
    && (message.provider === 'codex' || message.provider === 'claude' || message.provider === 'pi' || message.provider === 'kimi'
      || message.provider === 'gemini' || message.provider === 'opencode' || message.provider === 'agentsview')) {
    return { type: 'authorize-agent', provider: message.provider };
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
export type DetectedAgentHandler = (provider: DetectedAgentProviderId, signal: AbortSignal) => Promise<void>;
export type ConnectSourceHandler = (signal: AbortSignal) => Promise<void>;

/** Session-owned controller. Closing its panel leaves an already-open temporary preview readable. */
export class SourceIntakePanel implements vscode.Disposable, vscode.WebviewViewProvider {
  readonly #onSource: SourceIntakeHandler;
  readonly #onDetectedAgent: DetectedAgentHandler | undefined;
  readonly #onConnect: ConnectSourceHandler | undefined;
  readonly #lifetime = new AbortController();
  readonly #visibilityChanged = new vscode.EventEmitter<boolean>();
  #panel: vscode.WebviewPanel | undefined;
  #view: vscode.WebviewView | undefined;
  #viewVisibilityListener: vscode.Disposable | undefined;
  #reportedViewVisibility = false;
  #panelLifetime: AbortController | undefined;
  #viewLifetime: AbortController | undefined;
  #pending: Promise<void> | undefined;
  #disposal: Promise<void> | undefined;
  public readonly previews: SessionPreviews;

  public readonly onDidChangeVisibility = this.#visibilityChanged.event;

  public constructor(onSource: SourceIntakeHandler, onDetectedAgent?: DetectedAgentHandler, previews = new SessionPreviews(), onConnect?: ConnectSourceHandler) {
    this.#onSource = onSource;
    this.#onDetectedAgent = onDetectedAgent;
    this.previews = previews;
    this.#onConnect = onConnect;
  }

  public resolveWebviewView(view: vscode.WebviewView): void {
    if (this.#lifetime.signal.aborted) return;
    const previousView = this.#view;
    if (previousView !== undefined && previousView !== view) {
      this.reportViewVisibility(previousView, false);
      this.#viewVisibilityListener?.dispose();
    }
    this.#view = view;
    this.reportViewVisibility(view, view.visible);
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = getSourceDropHtml();
    const controller = new AbortController();
    this.#viewLifetime = controller;
    const visibilityListener = view.onDidChangeVisibility(() => this.reportViewVisibility(view, view.visible));
    this.#viewVisibilityListener = visibilityListener;
    this.reportViewVisibility(view, view.visible);
    const listener = view.webview.onDidReceiveMessage((message: unknown) => {
      if (controller.signal.aborted) return;
      if (this.#pending !== undefined) {
        void this.post(view.webview, controller.signal, 'busy', 'Finish or cancel the current source selection first.');
        return;
      }
      const operation = this.receive(message, view.webview, controller.signal);
      this.#pending = operation;
      void operation.finally(() => { if (this.#pending === operation) this.#pending = undefined; });
    });
    view.onDidDispose(() => {
      controller.abort(); listener.dispose(); visibilityListener.dispose();
      if (this.#view === view) {
        this.reportViewVisibility(view, false);
        this.#view = undefined; this.#viewLifetime = undefined;
        if (this.#viewVisibilityListener === visibilityListener) this.#viewVisibilityListener = undefined;
      }
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
        void this.post(panel.webview, controller.signal, 'busy', 'Finish or cancel the current source selection first.');
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
    if (this.#view !== undefined) this.reportViewVisibility(this.#view, false);
    this.#viewVisibilityListener?.dispose();
    this.#viewVisibilityListener = undefined;
    this.#lifetime.abort(); this.#panelLifetime?.abort(); this.#viewLifetime?.abort(); this.#panel?.dispose();
    this.#visibilityChanged.dispose();
    this.#disposal = this.cleanup();
    return this.#disposal;
  }

  private reportViewVisibility(view: vscode.WebviewView, visible: boolean): void {
    if (this.#view !== view || this.#reportedViewVisibility === visible) return;
    this.#reportedViewVisibility = visible;
    this.#visibilityChanged.fire(visible);
  }

  private async receive(raw: unknown, webview: vscode.Webview, signal: AbortSignal): Promise<void> {
    try {
      const message = parseSourceIntakeMessage(raw);
      if (message.type === 'webview-diagnostic') {
        await this.handleWebviewDiagnostic(webview, signal, message);
        return;
      }
      if (message.type === 'paste-jsonl') {
        this.show();
        return;
      }
      await this.post(webview, signal, 'busy', 'Adding source…');
      if (signal.aborted) return;
      if (message.type === 'authorize-agent') {
        if (this.#onDetectedAgent === undefined) throw new Error('Detected agent authorization is unavailable. Use Add Source to choose a local folder.');
        await this.#onDetectedAgent(message.provider, signal);
        await this.post(webview, signal, 'success', sessionNavigatorProviderLabel(message.provider) + ' source connected.');
        return;
      }
      if (message.type === 'connect-agent') {
        if (this.#onConnect === undefined) throw new Error('Source connection is unavailable. Use Add Source to choose a local folder.');
        await this.#onConnect(signal);
        await this.post(webview, signal, 'success', 'Source connection complete.');
        return;
      }
      if (message.type === 'import-jsonl') {
        const records = validatePastedJsonl(message.text);
        await this.openPreview(message.text, records, signal);
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

  private async handleWebviewDiagnostic(webview: vscode.Webview, signal: AbortSignal, message: Extract<IntakeMessage, { readonly type: 'webview-diagnostic' }>): Promise<void> {
    const safeMessage = sanitizeDiagnostic(message.message);
    const diagnostics = 'JsonlView source intake webview\nError: ' + message.name + '\nMessage: ' + safeMessage;
    const action = await vscode.window.showInformationMessage('JsonlView detected a Webview error. Source contents were not included.', 'Copy diagnostics', 'Send to VS Code AI');
    if (action === 'Copy diagnostics') {
      await vscode.env.clipboard.writeText(diagnostics);
      await this.post(webview, signal, 'success', 'Diagnostics copied.');
    } else if (action === 'Send to VS Code AI') {
      await vscode.env.clipboard.writeText(diagnostics);
      try {
        await vscode.commands.executeCommand('workbench.action.chat.open', { query: diagnostics });
        await this.post(webview, signal, 'success', 'Diagnostics sent to VS Code AI.');
      } catch {
        await this.post(webview, signal, 'error', 'VS Code AI is unavailable. Diagnostics were copied instead.');
      }
    } else {
      await this.post(webview, signal, 'idle', 'No diagnostic action selected.');
    }
  }

  private async post(webview: vscode.Webview, signal: AbortSignal, state: string, text: string, clearText = false): Promise<void> {
    if (signal.aborted || this.#lifetime.signal.aborted) return;
    try { await webview.postMessage({ type: 'status', state, text, clearText }); }
    catch { /* The panel may close between the signal check and delivery. */ }
  }

  private async openPreview(text: string, records: number, signal: AbortSignal): Promise<void> {
    const preview = await this.previews.create(text, records, signal);
    if (preview === undefined) return;
    try { await vscode.commands.executeCommand('vscode.openWith', preview.sourceUri, 'jsonlView.editor'); }
    catch { await this.previews.remove(preview.id); throw new Error('Could not open the temporary preview.'); }
  }

  private async cleanup(): Promise<void> {
    await this.#pending;
    await this.previews.dispose();
  }
}

function sanitizeDiagnostic(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 512);
}
