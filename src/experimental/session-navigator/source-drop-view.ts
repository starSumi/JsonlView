import type * as vscode from 'vscode';
import type { SessionPreview } from './session-previews';
import { getSourceDropHtml } from './source-drop-html';
import { INTAKE_PROTOCOL_VERSION, createIntakeStatusReply, isSourceDropMessage, type IntakeStatusState, type SourceDropMessage } from '../../shared/contracts/intake';

export type SourceDropAction = 'files' | 'folder';
export interface SourceDropCallbacks {
  readonly action: (action: SourceDropAction, signal: AbortSignal) => Promise<void>;
  readonly previewUri: (uri: string, signal: AbortSignal) => Promise<SessionPreview | 'folder' | undefined>;
  readonly previewText: (text: string, signal: AbortSignal) => Promise<SessionPreview | undefined>;
  readonly offerPreviewSaveAs: (preview: SessionPreview, signal: AbortSignal) => void;
}

export function parseSourceDropMessage(value: unknown): SourceDropMessage {
  if (isRecord(value) && value.intakeProtocolVersion !== INTAKE_PROTOCOL_VERSION) {
    throw new Error('This Import panel uses an unsupported protocol version. Close and reopen the panel.');
  }
  if (!isSourceDropMessage(value)) throw new Error('Invalid or oversized source request. Use Select files for larger sources.');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

type PanelFactory = () => vscode.WebviewPanel;

/** The editor-area canvas owns one cancellable intake operation; opening it never scans sources. */
export class SourceImportCanvas implements vscode.Disposable {
  readonly #callbacks: SourceDropCallbacks;
  readonly #createPanel: PanelFactory;
  #panel: vscode.WebviewPanel | undefined;
  #close: (() => void) | undefined;
  #disposed = false;

  public constructor(callbacks: SourceDropCallbacks, createPanel: PanelFactory) {
    this.#callbacks = callbacks;
    this.#createPanel = createPanel;
  }

  public show(): void {
    if (this.#disposed) return;
    if (this.#panel !== undefined) {
      this.#panel.reveal();
      return;
    }
    const panel = this.#createPanel();
    const controller = new AbortController();
    const subscriptions: vscode.Disposable[] = [];
    let pending: Promise<void> | undefined;
    this.#panel = panel;
    const close = (): void => {
      controller.abort();
      for (const subscription of subscriptions.splice(0)) subscription.dispose();
      if (this.#close === close) this.#close = undefined;
      if (this.#panel === panel) this.#panel = undefined;
    };
    this.#close = close;
    panel.webview.options = { enableScripts: true, localResourceRoots: [] };
    panel.webview.html = getSourceDropHtml();
    subscriptions.push(panel.webview.onDidReceiveMessage((raw: unknown) => {
      if (controller.signal.aborted) return;
      let parsed: SourceDropMessage;
      try { parsed = parseSourceDropMessage(raw); }
      catch (error) {
        void this.post(panel.webview, controller.signal, 'error', error instanceof Error ? error.message : 'Invalid source request.');
        return;
      }
      if (pending !== undefined) {
        void this.post(panel.webview, controller.signal, 'busy', 'Finish or cancel the current selection first.');
        return;
      }
      const operation = this.receive(parsed, panel.webview, controller.signal);
      pending = operation;
      void operation.finally(() => { if (pending === operation) pending = undefined; });
    }), panel.onDidDispose(close));
  }

  public dispose(): void {
    this.#disposed = true;
    const panel = this.#panel;
    this.#close?.();
    panel?.dispose();
    this.#panel = undefined;
  }

  private async receive(message: SourceDropMessage, webview: vscode.Webview, signal: AbortSignal): Promise<void> {
    try {
      await this.post(webview, signal, 'busy', 'Processing…');
      if (signal.aborted) return;
      if (message.type === 'import-jsonl') {
        const preview = await this.#callbacks.previewText(message.text, signal);
        if (preview === undefined) return;
        await this.post(webview, signal, 'success', 'Temporary preview opened. Save As keeps a copy; recover it this session from Agent Sessions > Recent Previews.');
        this.#callbacks.offerPreviewSaveAs(preview, signal);
      } else if (message.type === 'preview-uris') {
        const result = await this.#callbacks.previewUri(message.uris[0], signal);
        if (result === 'folder') {
          await this.post(webview, signal, 'idle', 'Folder selection closed.');
        } else if (result !== undefined) {
          await this.post(webview, signal, 'success', 'Temporary preview opened. Save As keeps a copy; recover it this session from Agent Sessions > Recent Previews.');
          this.#callbacks.offerPreviewSaveAs(result, signal);
        }
      } else {
        await this.#callbacks.action(message.type === 'pick-files' ? 'files' : 'folder', signal);
        await this.post(webview, signal, 'idle', 'Ready for another source.');
      }
    } catch (error) {
      await this.post(webview, signal, 'error', error instanceof Error ? error.message : 'Could not open this source.');
    }
  }

  private async post(webview: vscode.Webview, signal: AbortSignal, state: IntakeStatusState, text: string): Promise<void> {
    if (signal.aborted || this.#disposed) return;
    try { await webview.postMessage(createIntakeStatusReply(state, text)); }
    catch { /* A closed panel cannot receive a terminal status. */ }
  }
}
