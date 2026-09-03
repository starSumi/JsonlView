import { basename, dirname } from 'node:path';
import * as vscode from 'vscode';
import { PROTOCOL_VERSION, type DocumentSummary, type ExtensionMessage } from '../shared/types';
import { DocumentController } from './document-controller';
import { IntegratedJsonlSession } from './integrated-session';
import type { NativeNewlineScannerSetting } from '../engine';
import { shouldAutoFollow } from './follow-policy';
import { getWebviewHtml } from './webview-html';

const SOURCE_RECONCILE_DELAY_MS = 150;

class JsonlViewDocument implements vscode.CustomDocument {
  private readonly panels = new Set<vscode.WebviewPanel>();
  private readonly disposables: vscode.Disposable[] = [];
  private reconcileTimer: NodeJS.Timeout | undefined;
  private reconciling = false;
  private reconcilePending = false;
  private disposed = false;
  private publishedProfileId: string;

  private constructor(
    public readonly uri: vscode.Uri,
    public readonly session: IntegratedJsonlSession,
  ) {
    this.publishedProfileId = session.getSummary().profileId;
    const directory = vscode.Uri.file(dirname(uri.fsPath));
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(directory, basename(uri.fsPath)),
      false,
      false,
      false,
    );
    this.disposables.push(
      watcher,
      watcher.onDidChange(() => this.scheduleReconcile()),
      watcher.onDidCreate(() => this.scheduleReconcile()),
      watcher.onDidDelete(() => this.scheduleReconcile()),
      { dispose: session.onProgress((summary) => this.handleProgress(summary)) },
    );
  }

  public static async create(
    uri: vscode.Uri,
    token: vscode.CancellationToken,
  ): Promise<JsonlViewDocument> {
    if (uri.scheme !== 'file') {
      throw new Error('JsonlView currently requires a file-backed JSONL or NDJSON resource.');
    }
    const configuration = vscode.workspace.getConfiguration('jsonlView', uri);
    const session = await IntegratedJsonlSession.open(uri.fsPath, {
      uri: uri.toString(),
      autoDetectProfiles: configuration.get<boolean>('profile.autoDetect', true),
      deferProfileDetection: true,
      maxRecordBytes: configuration.get<number>('hydration.maxBytes', 1024 * 1024),
      newlineScanner: configuration.get<NativeNewlineScannerSetting>('native.newlineScanner', 'off'),
    }, cancellationSignal(token));
    if (token.isCancellationRequested) {
      await session.dispose();
      throw new vscode.CancellationError();
    }
    return new JsonlViewDocument(uri, session);
  }

  public addPanel(panel: vscode.WebviewPanel): vscode.Disposable {
    this.panels.add(panel);
    return { dispose: () => this.panels.delete(panel) };
  }

  public get hasPanels(): boolean {
    return this.panels.size > 0;
  }

  public async rebuild(): Promise<void> {
    const summary = await this.session.rebuild(new AbortController().signal);
    await this.broadcast('OPENED', summary);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.reconcileTimer !== undefined) clearTimeout(this.reconcileTimer);
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;
    this.panels.clear();
    void this.session.dispose();
  }

  private scheduleReconcile(): void {
    if (this.disposed) return;
    if (this.reconciling) {
      this.reconcilePending = true;
      return;
    }
    if (this.reconcileTimer !== undefined) clearTimeout(this.reconcileTimer);
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = undefined;
      void this.reconcileSource();
    }, SOURCE_RECONCILE_DELAY_MS);
  }

  private async reconcileSource(): Promise<void> {
    if (this.disposed || this.reconciling) return;
    this.reconciling = true;
    try {
      const refresh = await this.session.classifyRefresh();
      if (refresh.kind === 'unchanged') return;
      if (this.session.followMode && shouldAutoFollow(refresh.kind)) {
        const summary = await this.session.rebuild(new AbortController().signal);
        await this.broadcast('OPENED', summary);
        return;
      }
      await this.broadcast('SOURCE_INVALIDATED', { reason: refresh.kind });
    } catch (error) {
      await this.broadcast('ERROR', {
        code: 'SOURCE_RECONCILE_FAILED',
        message: error instanceof Error ? error.message : String(error),
        recoverable: true,
      });
    } finally {
      this.reconciling = false;
      if (this.reconcilePending) {
        this.reconcilePending = false;
        this.scheduleReconcile();
      }
    }
  }

  private async handleProgress(summary: DocumentSummary): Promise<void> {
    if (this.disposed) return;
    if (summary.profileId !== this.publishedProfileId) {
      this.publishedProfileId = summary.profileId;
      await this.broadcast('PROFILE_CHANGED', {
        profileId: summary.profileId,
        columns: [...this.session.getProfileColumns()],
      });
    }
    await this.broadcast('INDEX_PROGRESS', summary);
  }

  private async broadcast<TType extends ExtensionMessage['type']>(
    type: TType,
    payload: Extract<ExtensionMessage, { type: TType }>['payload'],
  ): Promise<void> {
    const snapshot = this.session.getSummary().snapshot;
    const message = {
      protocolVersion: PROTOCOL_VERSION,
      type,
      documentId: snapshot.documentId,
      generation: snapshot.generation,
      requestId: '',
      payload,
    } as Extract<ExtensionMessage, { type: TType }>;
    await Promise.all([...this.panels].map(async (panel) => panel.webview.postMessage(message)));
  }
}

class JsonlViewProvider implements vscode.CustomReadonlyEditorProvider<JsonlViewDocument> {
  private readonly resolvedDocuments = new Set<JsonlViewDocument>();
  private lastResolvedDocument: JsonlViewDocument | undefined;

  public constructor(private readonly extensionUri: vscode.Uri) {}

  public openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    token: vscode.CancellationToken,
  ): Promise<JsonlViewDocument> {
    return JsonlViewDocument.create(uri, token);
  }

  public resolveCustomEditor(document: JsonlViewDocument, panel: vscode.WebviewPanel): void {
    this.resolvedDocuments.add(document);
    this.lastResolvedDocument = document;
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
    };
    const pageSize = vscode.workspace.getConfiguration('jsonlView', document.uri).get<number>('pageSize', 100);
    panel.webview.html = getWebviewHtml(
      panel.webview,
      this.extensionUri,
      document.session.getSummary().snapshot,
      pageSize,
    );

    const controller = new DocumentController(document.session, panel.webview);
    const panelRegistration = document.addPanel(panel);
    const messageRegistration = panel.webview.onDidReceiveMessage((message) => {
      void controller.handleMessage(message);
    });
    const viewStateRegistration = panel.onDidChangeViewState((event) => {
      if (!event.webviewPanel.visible) {
        controller.cancelActive();
      } else if (event.webviewPanel.active) {
        this.lastResolvedDocument = document;
      }
    });
    panel.onDidDispose(() => {
      controller.dispose();
      messageRegistration.dispose();
      viewStateRegistration.dispose();
      panelRegistration.dispose();
      if (!document.hasPanels) this.resolvedDocuments.delete(document);
      if (this.lastResolvedDocument === document && !document.hasPanels) {
        this.lastResolvedDocument = [...this.resolvedDocuments].at(-1);
      }
    });
  }

  public async rebuildActiveDocument(): Promise<void> {
    if (this.lastResolvedDocument === undefined) {
      void vscode.window.showInformationMessage('Open a JSONL file in JsonlView before rebuilding its index.');
      return;
    }
    await this.lastResolvedDocument.rebuild();
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new JsonlViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider('jsonlView.editor', provider, {
      supportsMultipleEditorsPerDocument: false,
      webviewOptions: { retainContextWhenHidden: false },
    }),
    vscode.commands.registerCommand('jsonlView.open', async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (target === undefined) {
        void vscode.window.showInformationMessage('Select a JSONL or NDJSON file to open in JsonlView.');
        return;
      }
      await vscode.commands.executeCommand('vscode.openWith', target, 'jsonlView.editor');
    }),
    vscode.commands.registerCommand('jsonlView.rebuildIndex', async () => provider.rebuildActiveDocument()),
  );
}

export function deactivate(): void {}

function cancellationSignal(token: vscode.CancellationToken): AbortSignal {
  const controller = new AbortController();
  if (token.isCancellationRequested) controller.abort();
  token.onCancellationRequested(() => controller.abort());
  return controller.signal;
}
