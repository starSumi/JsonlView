import { basename, dirname } from 'node:path';
import { stat } from 'node:fs/promises';
import * as vscode from 'vscode';
import { PROTOCOL_VERSION, type DocumentSummary, type ExtensionMessage } from '../shared/types';
import { DocumentController } from './document-controller';
import { IntegratedJsonlSession } from './integrated-session';
import type { NativeNewlineScannerSetting } from '../engine';
import { shouldAutoFollow } from './follow-policy';
import {
  FollowRecoveryCoordinator,
  isTransientFileLockError,
  postMessageBestEffort,
  shouldNotifyFollowRecovery,
  type FollowRecoveryIdentity,
  type FollowRecoveryProbe,
} from './follow-recovery';
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
  private readonly recovery: FollowRecoveryCoordinator;
  private readonly followModeRegistration: { dispose(): void };

  private constructor(
    public readonly uri: vscode.Uri,
    public readonly session: IntegratedJsonlSession,
  ) {
    this.publishedProfileId = session.getSummary().profileId;
    this.recovery = new FollowRecoveryCoordinator({
      getExpectedIdentity: () => followIdentity(this.session.getSummary()),
      isExpectedIdentityCurrent: (expected) => this.isExpectedIdentityCurrent(expected),
      probe: (signal) => this.probeSource(signal),
      rebuildStable: (expected, signal) => this.session.rebuildStable(expected, signal),
      publish: (summary) => this.publishRecovered(summary),
      invalidate: (reason) => this.broadcast('SOURCE_INVALIDATED', { reason }),
      report: (message) => this.broadcast('ERROR', {
        code: 'FOLLOW_RECOVERY_STOPPED',
        message,
        recoverable: true,
      }),
      scheduleReconcile: () => this.scheduleReconcile(),
    });
    this.followModeRegistration = {
      dispose: session.onFollowMode((enabled) => {
        if (enabled) this.recovery.reset();
        else this.recovery.cancel();
      }),
    };
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
      this.followModeRegistration,
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
      fullRecordMaxBytes: configuration.get<number>('hydration.fullMaxBytes', 16 * 1024 * 1024),
      pageHydrationMaxBytes: configuration.get<number>('hydration.pageMaxBytes', 8 * 1024 * 1024),
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
    this.resetRecovery();
    const summary = await this.session.rebuild(new AbortController().signal);
    await this.broadcast('OPENED', summary);
  }

  public resetRecovery(): void {
    this.recovery.reset();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.reconcileTimer !== undefined) clearTimeout(this.reconcileTimer);
    this.recovery.dispose();
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
      if (shouldNotifyFollowRecovery(this.session.followMode, this.recovery.isRunning, refresh.kind)) {
        this.recovery.notifyUnknown();
        return;
      }
      if (this.session.followMode && shouldAutoFollow(refresh.kind)) {
        const summary = await this.session.rebuild(new AbortController().signal);
        await this.broadcast('OPENED', summary);
        return;
      }
      if (this.recovery.isRunning) this.recovery.cancel();
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

  private isExpectedIdentityCurrent(expected: FollowRecoveryIdentity): boolean {
    if (this.disposed) return false;
    const snapshot = this.session.getSummary().snapshot;
    return snapshot.documentId === expected.documentId
      && snapshot.uri === expected.uri
      && snapshot.generation === expected.generation
      && snapshot.sizeBytes === expected.sizeBytes
      && snapshot.device === expected.device
      && snapshot.inode === expected.inode;
  }

  private async probeSource(signal: AbortSignal): Promise<FollowRecoveryProbe> {
    if (signal.aborted) throw new Error('Follow recovery was cancelled.');
    try {
      const metadata = await stat(this.uri.fsPath, { bigint: true });
      if (signal.aborted) throw new Error('Follow recovery was cancelled.');
      if (!metadata.isFile()) return { kind: 'not_file' };
      const current = this.session.getSummary().snapshot;
      return {
        kind: 'present',
        identity: {
          documentId: current.documentId,
          uri: current.uri,
          generation: current.generation,
          sizeBytes: metadata.size.toString(),
          ...(metadata.dev === 0n ? {} : { device: metadata.dev.toString() }),
          ...(metadata.ino === 0n ? {} : { inode: metadata.ino.toString() }),
        },
        sizeBytes: metadata.size,
        mtimeNs: metadata.mtimeNs,
      };
    } catch (error) {
      if (signal.aborted) throw error;
      if (isNodeError(error) && error.code === 'ENOENT') return { kind: 'missing' };
      return {
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
        // Sharing/ACL races on Windows can report EACCES/EPERM while the
        // writer is rotating the file. The coordinator's bounded retry cap
        // handles both transient locks and persistent permission failures.
        retryable: true,
        ...(isTransientFileLockError(error) ? { message: `transient file lock: ${error instanceof Error ? error.message : String(error)}` } : {}),
      };
    }
  }

  private async publishRecovered(summary: DocumentSummary): Promise<void> {
    if (this.disposed) return;
    const current = this.session.getSummary();
    // A newer manual rebuild wins; never relabel its payload with the
    // candidate summary supplied by an older recovery attempt.
    if (current.snapshot.generation !== summary.snapshot.generation) return;
    await this.broadcast('OPENED', current);
  }

  private async broadcast<TType extends ExtensionMessage['type']>(
    type: TType,
    payload: Extract<ExtensionMessage, { type: TType }>['payload'],
  ): Promise<void> {
    if (this.disposed) return;
    const snapshot = this.session.getSummary().snapshot;
    const message = {
      protocolVersion: PROTOCOL_VERSION,
      type,
      documentId: snapshot.documentId,
      generation: snapshot.generation,
      ...(snapshot.epoch === undefined ? {} : { epoch: snapshot.epoch }),
      requestId: '',
      payload,
    } as Extract<ExtensionMessage, { type: TType }>;
    await postMessageBestEffort(
      [...this.panels].map((panel) => panel.webview),
      message,
      (error, index) => {
        const detail = error instanceof Error ? error.message : String(error);
        // A panel can disappear between snapshot adoption and delivery. Keep
        // the successful generation authoritative while retaining a bounded
        // diagnostic for the disposed/failed recipient.
        console.warn(`[JsonlView] ${type} delivery failed for panel ${String(index)}: ${detail}`);
      },
    );
  }
}

function followIdentity(summary: DocumentSummary): FollowRecoveryIdentity {
  const snapshot = summary.snapshot;
  return {
    documentId: snapshot.documentId,
    uri: snapshot.uri,
    generation: snapshot.generation,
    sizeBytes: snapshot.sizeBytes,
    ...(snapshot.device === undefined ? {} : { device: snapshot.device }),
    ...(snapshot.inode === undefined ? {} : { inode: snapshot.inode }),
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
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

    const controller = new DocumentController(document.session, panel.webview, {
      beforeRebuild: () => document.resetRecovery(),
    });
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
      const target = uri ?? activeResourceUri();
      if (target === undefined) {
        void vscode.window.showInformationMessage('Select a JSONL or NDJSON file to open in JsonlView.');
        return;
      }
      if (!isJsonlResource(target)) {
        void vscode.window.showInformationMessage(
          "JsonlView currently supports .jsonl and .ndjson. Regular .json files stay with VS Code's JSON editor.",
        );
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

function isJsonlResource(uri: vscode.Uri): boolean {
  const name = basename(uri.path).toLowerCase();
  return name.endsWith('.jsonl') || name.endsWith('.ndjson');
}

function activeResourceUri(): vscode.Uri | undefined {
  const editorUri = vscode.window.activeTextEditor?.document.uri;
  if (editorUri !== undefined) return editorUri;

  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom) {
    return input.uri;
  }
  return undefined;
}
