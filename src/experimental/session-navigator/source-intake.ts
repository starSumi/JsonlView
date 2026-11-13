import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { TextDecoder } from 'node:util';
import * as vscode from 'vscode';
import { getSourceIntakeHtml } from './source-intake-html';
import { hasJsonlExtension } from './source-intake-contract';
import { INTAKE_PROTOCOL_VERSION, createIntakeFocusMessage, createIntakeStatusReply, validateIntakeMessage, type IntakeMessage, type IntakeStatusState } from '../../shared/contracts/intake';
import { SOURCE_INTAKE_MAX_BYTES, SOURCE_INTAKE_MAX_RECORDS } from './source-intake-limits';
import { SessionPreviews } from './session-previews';
import type { SessionPreview } from './session-previews';

export { SOURCE_INTAKE_MAX_BYTES, SOURCE_INTAKE_MAX_RECORDS } from './source-intake-limits';

/** Host-facing error adapter over the shared, stateless intake contract. */
export function parseSourceIntakeMessage(value: unknown): IntakeMessage {
  const result = validateIntakeMessage(value);
  if (result.ok) return result.message;
  if (result.error === 'unsupported-version') {
    throw new Error('This Import panel uses an unsupported protocol version. Close and reopen the panel.');
  }
  if (result.error === 'oversized') {
    throw new Error('JSONL preview is limited to 1 MiB. Choose Files to open a larger local source.');
  }
  throw new Error('Invalid or oversized source request.');
}

/** Validation preserves the exact content; blank or malformed records are never discarded. */
export function validatePastedJsonl(text: string): number {
  parseSourceIntakeMessage({ intakeProtocolVersion: INTAKE_PROTOCOL_VERSION, type: 'import-jsonl', text });
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

async function readPreviewSource(uri: vscode.Uri, signal: AbortSignal): Promise<{ readonly text: string; readonly records: number }> {
  if (signal.aborted) throw new Error('Source preview was cancelled.');
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(uri.fsPath, 'r');
    const buffer = Buffer.alloc(SOURCE_INTAKE_MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > SOURCE_INTAKE_MAX_BYTES) throw new Error('Dropped previews are limited to 1 MiB. Choose Files to open a larger source.');
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length));
    return { text, records: validatePastedJsonl(text) };
  } catch (error) {
    if (error instanceof Error && (error.message.includes('preview') || error.message.startsWith('Line '))) throw error;
    throw new Error('The dropped source could not be read as UTF-8 JSONL. Choose Files to open it directly.');
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Session-owned controller. Closing its panel leaves an already-open temporary preview readable. */
export class SourceIntakePanel implements vscode.Disposable {
  readonly #lifetime = new AbortController();
  #panel: vscode.WebviewPanel | undefined;
  #panelLifetime: AbortController | undefined;
  #pending: Promise<void> | undefined;
  #disposal: Promise<void> | undefined;
  public readonly previews: SessionPreviews;

  public constructor(previews = new SessionPreviews()) {
    this.previews = previews;
  }

  /** Browser file drops share the existing host validation and session preview owner. */
  public async previewText(text: string, signal: AbortSignal): Promise<SessionPreview | undefined> {
    if (signal.aborted || this.#lifetime.signal.aborted) return undefined;
    return this.openPreview(text, validatePastedJsonl(text), signal);
  }

  /** Open one native TreeView drop as a bounded temporary preview. */
  public async previewUri(uri: vscode.Uri, signal: AbortSignal): Promise<SessionPreview | undefined> {
    const canonical = await validateLocalSourceUri(uri.toString());
    const details = await lstat(canonical.fsPath);
    if (!details.isFile() || !hasJsonlExtension(canonical.fsPath)) {
      throw new Error('Drop a JSONL or NDJSON file for a temporary preview.');
    }
    const { text, records } = await readPreviewSource(canonical, signal);
    return this.openPreview(text, records, signal);
  }

  /** Offer a permanent copy after the Import canvas has already received success. */
  public offerPreviewSaveAs(preview: SessionPreview, signal: AbortSignal): void {
    if (signal.aborted || this.#lifetime.signal.aborted) return;
    void this.promptPreviewSaveAs(preview, signal).catch(() => {
      // Notification delivery cannot change a successfully opened temporary preview.
    });
  }

  private async promptPreviewSaveAs(preview: SessionPreview, signal: AbortSignal): Promise<void> {
    const count = preview.recordCount === 1 ? '1 record' : `${String(preview.recordCount)} records`;
    const action = await vscode.window.showInformationMessage(
      `Temporary preview opened with ${count}. Recover it this session under Agent Sessions > Recent Previews. Save As keeps a permanent copy; Collection filing is a separate choice.`,
      'Save As…', 'Keep Temporary Only',
    );
    if (action !== 'Save As…' || signal.aborted || this.#lifetime.signal.aborted) return;
    await this.previews.saveAs(preview.sourceUri, () => !signal.aborted && !this.#lifetime.signal.aborted);
  }

  public show(): void {
    if (this.#lifetime.signal.aborted) return;
    if (this.#panel !== undefined) {
      this.#panel.reveal();
      try {
        void Promise.resolve(this.#panel.webview.postMessage(createIntakeFocusMessage())).catch(() => {});
      } catch { /* The active Webview may be closing. */ }
      return;
    }
    const panel = vscode.window.createWebviewPanel('jsonlView.sourceIntake', 'Paste JSONL', vscode.ViewColumn.Active, {
      enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true,
    });
    this.#panel = panel;
    const controller = new AbortController();
    this.#panelLifetime = controller;
    panel.webview.html = getSourceIntakeHtml();
    const listener = panel.webview.onDidReceiveMessage((message: unknown) => {
      if (controller.signal.aborted) return;
      let parsed: IntakeMessage;
      try { parsed = parseSourceIntakeMessage(message); }
      catch (error) {
        void this.post(panel.webview, controller.signal, 'error', error instanceof Error ? error.message : 'Invalid source request.');
        return;
      }
      if (this.#pending !== undefined) {
        void this.post(panel.webview, controller.signal, 'busy', 'Finish or cancel the current source selection first.');
        return;
      }
      const operation = this.receive(parsed, panel.webview, controller.signal);
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
    this.#lifetime.abort(); this.#panelLifetime?.abort(); this.#panel?.dispose();
    this.#disposal = this.cleanup();
    return this.#disposal;
  }

  private async receive(message: IntakeMessage, webview: vscode.Webview, signal: AbortSignal): Promise<void> {
    try {
      if (message.type === 'webview-diagnostic') {
        await this.handleWebviewDiagnostic(webview, signal, message);
        return;
      }
      await this.post(webview, signal, 'busy', 'Adding source…');
      if (signal.aborted) return;
      if (message.type === 'preview-uris') {
        const preview = await this.previewUri(vscode.Uri.parse(message.uris[0], true), signal);
        if (preview === undefined) return;
        await this.post(webview, signal, 'success', 'Temporary preview opened. Save As keeps a copy; recover it this session from Agent Sessions > Recent Previews.');
        this.offerPreviewSaveAs(preview, signal);
        return;
      }
      if (message.type === 'import-jsonl') {
        const records = validatePastedJsonl(message.text);
        const preview = await this.openPreview(message.text, records, signal);
        if (preview === undefined) return;
        await this.post(webview, signal, 'success', `Opened a temporary preview with ${String(records)} records. Save As keeps a copy; recover it this session from Agent Sessions > Recent Previews.`, true);
        this.offerPreviewSaveAs(preview, signal);
        return;
      }
      throw new Error('Unsupported paste request.');
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

  private async post(webview: vscode.Webview, signal: AbortSignal, state: IntakeStatusState, text: string, clearText = false): Promise<void> {
    if (signal.aborted || this.#lifetime.signal.aborted) return;
    try { await webview.postMessage(createIntakeStatusReply(state, text, clearText)); }
    catch { /* The panel may close between the signal check and delivery. */ }
  }

  private async openPreview(text: string, records: number, signal: AbortSignal): Promise<SessionPreview | undefined> {
    const preview = await this.previews.create(text, records, signal);
    if (preview === undefined) return;
    if (signal.aborted || this.#lifetime.signal.aborted) {
      await this.previews.remove(preview.id);
      return;
    }
    try {
      await vscode.commands.executeCommand('vscode.openWith', preview.sourceUri, 'jsonlView.editor');
      return preview;
    }
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
