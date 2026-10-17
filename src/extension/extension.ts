import { basename, dirname } from 'node:path';
import { stat } from 'node:fs/promises';
import * as vscode from 'vscode';
import { findExtensionContributionConflict } from './extension-conflicts';
import { PROTOCOL_VERSION, type DocumentSummary, type ExtensionMessage } from '../shared/types';
import { createProtocolEnvelope } from '../shared/transport';
import { DocumentController } from './document-controller';
import { IntegratedJsonlSession, type DatasetDetectionReceipt } from './integrated-session';
import type { NativeNewlineScannerSetting, SourceRefreshResult } from '../engine';
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
import { RevealIntentRegistry, type RevealIntent } from '../experimental';
import { SessionNavigatorTreeProvider } from '../experimental/session-navigator/tree-provider';
import { RecentPreviewsTreeProvider } from '../experimental/session-navigator/recent-previews';
import type { SessionPreviews } from '../experimental/session-navigator/session-previews';
import { buildDiagnosticEnvelope, formatDiagnosticContext, formatDiagnosticPrompt, type JsonlViewDiagnosticEnvelope } from './diagnostic-context';
import { appendExecutionIdentityLog, appendOutputLog, createOutputLogObservabilitySink, type JsonlViewOutputChannel } from './output-log';
import { createCausalLifecycleTrace, type CausalLifecycleTrace } from './observability-contract';
import { parseStartupStageReceipt } from './startup-stage';
import { logLifecycleFailure } from './lifecycle-failure';
import { summaryIdentityMatches } from './summary-identity';
import { EXECUTION_IDENTITY, type RuntimeExecutionIdentity } from '../shared/execution-identity';
import { captureRuntimeExecutionIdentity } from './execution-runtime';

const SOURCE_RECONCILE_DELAY_MS = 150;
const STARTUP_STALL_MS = 10_000;

export class JsonlViewDocument implements vscode.CustomDocument {
  private readonly panels = new Set<vscode.WebviewPanel>();
  private readonly disposables: vscode.Disposable[] = [];
  private reconcileTimer: NodeJS.Timeout | undefined;
  private reconciling = false;
  private reconcilePending = false;
  private disposed = false;
  private publishedProfileId: string;
  private publishedProfileVersion: string | undefined;
  private pendingReveal: RevealIntent | undefined;
  private readonly recovery: FollowRecoveryCoordinator;
  private readonly followModeRegistration: { dispose(): void };
  /** One bounded source-to-Webview trace for the active recovery attempt. */
  private recoveryTrace: CausalLifecycleTrace | undefined;

  private constructor(
    public readonly uri: vscode.Uri,
    public readonly session: IntegratedJsonlSession,
  ) {
    this.publishedProfileId = session.getSummary().profileId;
    this.publishedProfileVersion = session.getSummary().profileVersion;
    this.recovery = new FollowRecoveryCoordinator({
      getExpectedIdentity: () => followIdentity(this.session.getSummary()),
      isExpectedIdentityCurrent: (expected) => this.isExpectedIdentityCurrent(expected),
      probe: (signal) => this.probeSource(signal),
      rebuildStable: (expected, signal) => this.session.rebuildStable(expected, signal),
      publish: async (summary) => {
        appendOutputLog(outputChannel, 'snapshot-published', `mode=${this.session.followMode ? 'follow' : 'normal'} reason=stable`);
        const published = await this.publishRecovered(summary);
        const trace = this.recoveryTrace;
        if (trace !== undefined) {
          trace.record('snapshot_publish', published.published ? 'published' : 'stale');
          if (published.published) trace.record('webview_delivery', published.delivered ? 'delivered' : 'failed');
          this.recoveryTrace = undefined;
        }
      },
      invalidate: async (reason, expected) => {
        if (expected === undefined || !this.isExpectedIdentityCurrent(expected)) return;
        appendOutputLog(outputChannel, 'recovery-decision', `mode=${this.session.followMode ? 'follow' : 'normal'} action=invalidate reason=${reason}`);
        // A terminal recovery does not publish a new snapshot. Retire its
        // partial trace so a later attempt starts with a fresh causal root.
        this.recoveryTrace = undefined;
        // In the regular (non-follow) view, an unknown classification usually
        // means the writer is still changing metadata. Retain the old
        // generation and let the watcher schedule another bounded attempt;
        // only destructive source transitions become a user-visible barrier.
        if (!this.session.followMode && reason === 'unknown') {
          this.recovery.reset();
          this.scheduleReconcile();
          return Promise.resolve();
        }
        await this.broadcast(expected, 'SOURCE_INVALIDATED', { reason });
      },
      report: async (message, expected) => {
        if (expected === undefined || !this.isExpectedIdentityCurrent(expected)) return;
        if (!this.session.followMode) {
          this.recovery.reset();
          this.scheduleReconcile();
          return Promise.resolve();
        }
        await this.broadcast(expected, 'ERROR', {
          code: 'FOLLOW_RECOVERY_STOPPED',
          message,
          recoverable: true,
        });
      },
      scheduleReconcile: () => this.scheduleReconcile(),
    });
    this.followModeRegistration = {
      dispose: session.onFollowMode((enabled) => {
        this.recoveryTrace = undefined;
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
    onBackgroundIndexError?: (error: unknown) => void,
    onDatasetDetection?: (receipt: DatasetDetectionReceipt) => void,
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
      ...(onBackgroundIndexError === undefined ? {} : { onBackgroundIndexError }),
      ...(onDatasetDetection === undefined ? {} : { onDatasetDetection }),
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
    await this.broadcast(summary.snapshot, 'OPENED', summary);
  }

  public resetRecovery(): void {
    this.recoveryTrace = undefined;
    this.recovery.reset();
  }

  /** Schedule the same bounded recovery used by watcher hints. */
  public async notifyTransientSourceChange(): Promise<boolean> {
    if (this.disposed) return false;
    const identity = capturePublicationIdentity(this.session.getSummary().snapshot);
    let refresh: SourceRefreshResult;
    try {
      refresh = await this.session.classifyRefresh();
    } catch {
      return false;
    }
    if (!this.isPublicationIdentityCurrent(identity)) return false;
    if (refresh.kind !== 'unknown' && refresh.kind !== 'append') return false;
    if (!this.session.followMode) {
      // A normal view never adopts a candidate generation in the background.
      // Keep its old snapshot mounted and expose a verified append as the
      // explicit Rebuild boundary. Unknown metadata remains transient so the
      // controller can retry without turning an in-flight write into a hard
      // failure; the watcher will classify it on the next pass.
      if (refresh.kind === 'append') {
        // A verified append is an explicit Rebuild boundary in the normal
        // view. Retire any unknown recovery that was waiting on the same
        // write so it cannot later auto-publish over this decision.
        this.recovery.cancel();
        this.recoveryTrace = undefined;
        const trace = this.beginLifecycleTrace(refresh.kind);
        trace.record('recovery_decision', 'invalidate');
        trace.record('snapshot_publish', 'invalidate');
        appendOutputLog(outputChannel, 'recovery-decision', 'mode=normal action=source-invalidated reason=append');
        appendOutputLog(outputChannel, 'source-invalidated', 'reason=append');
        const delivered = await this.broadcast(identity, 'SOURCE_INVALIDATED', { reason: 'append' });
        trace.record('webview_delivery', delivered ? 'delivered' : 'failed');
      } else {
        // Unknown metadata is a transient read barrier in a normal view. Do
        // not start FollowRecoveryCoordinator here: its stable candidate
        // path adopts a new generation, which would silently replace the
        // snapshot while the user is inspecting a detail drawer. The caller
        // receives SOURCE_UPDATING and owns the bounded retry; Rebuild remains
        // the explicit adoption boundary.
        appendOutputLog(outputChannel, 'recovery-decision', 'mode=normal action=defer reason=unknown');
        this.scheduleReconcile();
      }
      return true;
    }
    this.beginRecoveryTrace(refresh.kind);
    appendOutputLog(outputChannel, 'recovery-decision', `mode=follow action=recover reason=${refresh.kind}`);
    this.recovery.notifyUnknown();
    return true;
  }

  public setPendingReveal(intent: RevealIntent): void {
    this.pendingReveal = intent;
  }

  public async flushPendingReveal(): Promise<void> {
    const intent = this.pendingReveal;
    this.pendingReveal = undefined;
    if (intent === undefined) return;
    const current = { ...this.session.getSummary().snapshot };
    await this.broadcast(current, 'REVEAL', {
      sourceId: intent.sourceId,
      generation: current.generation,
      nativeId: intent.nativeId,
      anchorOrdinal: intent.anchorOrdinal,
    });
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
    const identity = capturePublicationIdentity(this.session.getSummary().snapshot);
    try {
      const refresh = await this.session.classifyRefresh();
      if (!this.isPublicationIdentityCurrent(identity)) return;
      appendOutputLog(outputChannel, 'source-classified', `mode=${this.session.followMode ? 'follow' : 'normal'} kind=${refresh.kind}`);
      if (refresh.kind === 'unchanged') return;
      if (!this.session.followMode && refresh.kind === 'unknown') {
        // A normal view never auto-adopts an unclassified source transition.
        // Keep the current snapshot mounted and wait for a later watcher hint
        // or an explicit Rebuild instead of polling or publishing OPENED.
        if (this.recovery.isRunning) {
          this.recovery.cancel();
          this.recoveryTrace = undefined;
        }
        appendOutputLog(outputChannel, 'recovery-decision', 'mode=normal action=defer reason=unknown');
        return;
      }
      if (shouldNotifyFollowRecovery(this.session.followMode, this.recovery.isRunning, refresh.kind)) {
        this.beginRecoveryTrace(refresh.kind);
        this.recovery.notifyUnknown();
        return;
      }
      if (this.session.followMode && shouldAutoFollow(refresh.kind)) {
        const trace = this.beginLifecycleTrace(refresh.kind);
        trace.record('recovery_decision', 'rebuild');
        const summary = await this.session.rebuild(new AbortController().signal);
        trace.record('snapshot_publish', 'published');
        const delivered = await this.broadcast(summary.snapshot, 'OPENED', summary);
        trace.record('webview_delivery', delivered ? 'delivered' : 'failed');
        return;
      }
      if (this.recovery.isRunning) {
        this.recovery.cancel();
        this.recoveryTrace = undefined;
      }
      const trace = this.beginLifecycleTrace(refresh.kind);
      trace.record('recovery_decision', 'invalidate');
      appendOutputLog(outputChannel, 'source-invalidated', `reason=${refresh.kind}`);
      trace.record('snapshot_publish', 'invalidate');
      const delivered = await this.broadcast(identity, 'SOURCE_INVALIDATED', { reason: refresh.kind });
      trace.record('webview_delivery', delivered ? 'delivered' : 'failed');
    } catch (error) {
      logLifecycleFailure(outputChannel, 'source_reconcile', error);
      await this.broadcast(identity, 'ERROR', {
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
    const identity = capturePublicationIdentity(summary.snapshot);
    // Profile publication is itself a valid transition. Gate the incoming
    // snapshot tuple first, then recheck the full summary after delivery so a
    // concurrent epoch/profile change cannot publish the follow-up progress.
    if (this.disposed || !this.isPublicationIdentityCurrent(identity)) return;
    if (summary.profileId !== this.publishedProfileId || summary.profileVersion !== this.publishedProfileVersion) {
      this.publishedProfileId = summary.profileId;
      this.publishedProfileVersion = summary.profileVersion;
      await this.broadcast(identity, 'PROFILE_CHANGED', {
        profileId: summary.profileId,
        ...(summary.profileVersion === undefined ? {} : { profileVersion: summary.profileVersion }),
        columns: [...this.session.getProfileColumns()],
      });
    }
    if (this.disposed || !summaryIdentityMatches(summary, this.session.getSummary())) return;
    await this.broadcast(identity, 'INDEX_PROGRESS', summary, summary);
  }

  private isExpectedIdentityCurrent(expected: FollowRecoveryIdentity): boolean {
    if (this.disposed) return false;
    const snapshot = this.session.getSummary().snapshot;
    return snapshot.documentId === expected.documentId
      && snapshot.uri === expected.uri
      && snapshot.generation === expected.generation
      && snapshot.epoch === expected.epoch
      && snapshot.sizeBytes === expected.sizeBytes
      && snapshot.device === expected.device
      && snapshot.inode === expected.inode;
  }

  private async probeSource(signal: AbortSignal): Promise<FollowRecoveryProbe> {
    if (signal.aborted) throw new Error('Follow recovery was cancelled.');
    const current = { ...this.session.getSummary().snapshot };
    try {
      const metadata = await stat(this.uri.fsPath, { bigint: true });
      if (signal.aborted) throw new Error('Follow recovery was cancelled.');
      if (!metadata.isFile()) return { kind: 'not_file' };
      return {
        kind: 'present',
        identity: {
          documentId: current.documentId,
          uri: current.uri,
          generation: current.generation,
          ...(current.epoch === undefined ? {} : { epoch: current.epoch }),
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

  private async publishRecovered(summary: DocumentSummary): Promise<{ published: boolean; delivered: boolean }> {
    if (this.disposed) return { published: false, delivered: false };
    const identity = capturePublicationIdentity(summary.snapshot);
    if (!this.isPublicationIdentityCurrent(identity)) return { published: false, delivered: false };
    return { published: true, delivered: await this.broadcast(identity, 'OPENED', summary) };
  }

  private beginLifecycleTrace(kind: SourceRefreshResult['kind']): CausalLifecycleTrace {
    const trace = createCausalLifecycleTrace(createOutputLogObservabilitySink(outputChannel));
    trace.record('source_classification', kind);
    return trace;
  }

  private beginRecoveryTrace(kind: SourceRefreshResult['kind']): void {
    if (this.recoveryTrace !== undefined && !this.recoveryTrace.complete) return;
    const trace = this.beginLifecycleTrace(kind);
    trace.record('recovery_decision', 'retry');
    this.recoveryTrace = trace;
  }

  private async broadcast<TType extends ExtensionMessage['type']>(
    identity: PublicationIdentity,
    type: TType,
    payload: Extract<ExtensionMessage, { type: TType }>['payload'],
    expectedSummary?: DocumentSummary,
  ): Promise<boolean> {
    const captured = capturePublicationIdentity(identity);
    if (this.disposed || !this.isPublicationIdentityCurrent(captured)) return false;
    if (expectedSummary !== undefined && !summaryIdentityMatches(expectedSummary, this.session.getSummary())) return false;
    if (type === 'OPENED' || type === 'SOURCE_INVALIDATED') {
      appendOutputLog(outputChannel, 'webview-lifecycle', `type=${type} panels=${String(this.panels.size)}`);
    }
    const message = createProtocolEnvelope({
      type,
      documentId: captured.documentId,
      generation: captured.generation,
      ...(captured.epoch === undefined ? {} : { epoch: captured.epoch }),
      requestId: '',
      payload,
    }) as unknown as Extract<ExtensionMessage, { type: TType }>;
    return postMessageBestEffort(
      [...this.panels].map((panel) => ({ postMessage: (value: typeof message) => {
        if (this.disposed || !this.isPublicationIdentityCurrent(captured)
          || (expectedSummary !== undefined && !summaryIdentityMatches(expectedSummary, this.session.getSummary()))) return Promise.resolve(false);
        return panel.webview.postMessage(value);
      } })),
      message,
      (error) => {
        // A panel can disappear between snapshot adoption and delivery. Keep
        // the successful generation authoritative while retaining a bounded
        // diagnostic for the disposed/failed recipient.
        logLifecycleFailure(outputChannel, 'webview_delivery', error, (line) => console.warn(line));
      },
    );
  }

  private isPublicationIdentityCurrent(identity: PublicationIdentity): boolean {
    if (this.disposed) return false;
    const current = this.session.getSummary().snapshot;
    return current.documentId === identity.documentId && current.generation === identity.generation && current.epoch === identity.epoch;
  }
}

type PublicationIdentity = Pick<DocumentSummary['snapshot'], 'documentId' | 'generation' | 'epoch'>;

function capturePublicationIdentity(snapshot: PublicationIdentity): Readonly<PublicationIdentity> {
  return Object.freeze({ documentId: snapshot.documentId, generation: snapshot.generation,
    ...(snapshot.epoch === undefined ? {} : { epoch: snapshot.epoch }) });
}

function followIdentity(summary: DocumentSummary): FollowRecoveryIdentity {
  const snapshot = summary.snapshot;
  return {
    documentId: snapshot.documentId,
    uri: snapshot.uri,
    generation: snapshot.generation,
    ...(snapshot.epoch === undefined ? {} : { epoch: snapshot.epoch }),
    sizeBytes: snapshot.sizeBytes,
    ...(snapshot.device === undefined ? {} : { device: snapshot.device }),
    ...(snapshot.inode === undefined ? {} : { inode: snapshot.inode }),
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

export class JsonlViewProvider implements vscode.CustomReadonlyEditorProvider<JsonlViewDocument> {
  private readonly resolvedDocuments = new Set<JsonlViewDocument>();
  private readonly traceIds = new WeakMap<JsonlViewDocument, string>();
  private nextTraceId = 0;
  private nextStartupId = 0;
  private lastResolvedDocument: JsonlViewDocument | undefined;
  private rowOrderWrite: Promise<void> = Promise.resolve();

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly revealRegistry: RevealIntentRegistry,
    private readonly openSessionNavigator: () => Promise<unknown> | unknown,
    private readonly output: JsonlViewOutputChannel | undefined,
    private readonly runtimeIdentity: RuntimeExecutionIdentity = captureRuntimeExecutionIdentity(context),
    private readonly previews?: SessionPreviews,
  ) {}

  public async openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    token: vscode.CancellationToken,
  ): Promise<JsonlViewDocument> {
    const traceId = String(++this.nextTraceId);
    appendOutputLog(this.output, 'open-document', 'trace=' + traceId + ' stage=begin');
    const startedAt = performance.now();
    let stalled = false;
    let cancelled = false;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    let cancellationRegistration: vscode.Disposable | undefined;
    const clearObservation = (): void => {
      if (stallTimer !== undefined) clearTimeout(stallTimer);
      stallTimer = undefined;
      cancellationRegistration?.dispose();
      cancellationRegistration = undefined;
    };
    const cancelObservation = (): void => {
      if (cancelled) return;
      cancelled = true;
      clearObservation();
      appendOutputLog(this.output, 'open-document', 'trace=' + traceId + ' stage=cancelled phase=create lastStage=create-begin'
        + ' elapsedMs=' + String(Math.round(performance.now() - startedAt)));
    };
    stallTimer = setTimeout(() => {
      stallTimer = undefined;
      stalled = true;
      appendOutputLog(this.output, 'open-document', 'trace=' + traceId + ' stage=stalled phase=create lastStage=create-begin'
        + ' elapsedMs=' + String(Math.round(performance.now() - startedAt)));
    }, STARTUP_STALL_MS);
    cancellationRegistration = token.onCancellationRequested(cancelObservation);
    // Registration may observe cancellation synchronously; also cover tokens
    // cancelled before registration without changing the creation result.
    if (token.isCancellationRequested) cancelObservation();
    if (cancelled) clearObservation();
    try {
      const document = await JsonlViewDocument.create(uri, token, (error) => {
        const reason = error instanceof Error ? error.name.replace(/[^A-Za-z0-9_]/gu, '').slice(0, 48) : 'unknown';
        appendOutputLog(this.output, 'index-failed', 'trace=' + traceId + ' reason=' + reason);
      }, (receipt) => {
        appendOutputLog(this.output, 'dataset-detection', 'trace=' + traceId
          + ' operation=' + String(receipt.operationId) + ' status=' + receipt.status + ' stage=' + receipt.stage
          + ' sourceEpoch=' + String(receipt.sourceEpoch) + ' profileEpoch=' + String(receipt.profileEpoch)
          + ' elapsedMs=' + String(receipt.elapsedMs) + (receipt.code === undefined ? '' : ' code=' + receipt.code));
      });
      this.traceIds.set(document, traceId);
      const summary = document.session.getSummary();
      appendOutputLog(this.output, 'open-document', 'trace=' + traceId + ' stage=complete'
        + ' indexedBytes=' + summary.indexedBytes + ' indexedRecords=' + summary.indexedRecords
        + ' indexingComplete=' + String(summary.indexingComplete)
        + ' elapsedMs=' + String(Math.round(performance.now() - startedAt))
        + (stalled ? ' afterStall=true' : '')
        + (cancelled ? ' cancelled=true' : ''));
      return document;
    } catch (error) {
      const reason = error instanceof Error ? error.name.replace(/[^A-Za-z0-9_]/gu, '').slice(0, 48) : 'unknown';
      appendOutputLog(this.output, 'open-document', 'trace=' + traceId + ' stage=failed reason=' + reason + ' cancelled=' + String(cancelled || token.isCancellationRequested)
        + ' elapsedMs=' + String(Math.round(performance.now() - startedAt))
        + (stalled ? ' afterStall=true' : ''));
      throw error;
    } finally {
      clearObservation();
    }
  }

  public resolveCustomEditor(document: JsonlViewDocument, panel: vscode.WebviewPanel): void {
    const traceId = this.traceIds.get(document) ?? String(++this.nextTraceId);
    const startupId = String(++this.nextStartupId);
    this.traceIds.set(document, traceId);
    appendOutputLog(this.output, 'resolve-editor', 'trace=' + traceId + ' startup=' + startupId + ' stage=begin');
    const startedAt = performance.now();
    let lastStage = 'resolve-begin';
    let startupFinished = false;
    let startupOutcome: 'page-committed' | 'startup-error' | 'stalled' | 'disposed' | undefined;
    let startupStalled = false;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    const finishStartup = (status: 'page-committed' | 'startup-error' | 'stalled' | 'disposed', rows?: number): void => {
      if (startupFinished) return;
      startupFinished = true;
      startupOutcome = status;
      if (stallTimer !== undefined) clearTimeout(stallTimer);
      appendOutputLog(this.output, 'startup-outcome', 'trace=' + traceId
        + ' status=' + status + ' lastStage=' + lastStage + ' startup=' + startupId
        + ' elapsedMs=' + String(Math.round(performance.now() - startedAt))
        + (rows === undefined ? '' : ' rows=' + String(rows))
        + (startupStalled ? ' afterStall=true' : ''));
    };
    this.resolvedDocuments.add(document);
    this.lastResolvedDocument = document;
    const pendingReveal = this.revealRegistry.take(document.uri.toString());
    if (pendingReveal !== undefined) document.setPendingReveal(pendingReveal);
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
    };
    const pageSize = vscode.workspace.getConfiguration('jsonlView', document.uri).get<number>('pageSize', 100);
    const savedRowOrder = this.context.globalState.get('jsonlView.rowOrder');
    // These existing host counters are local correlators, not OTel trace context.
    const querySink = createOutputLogObservabilitySink(this.output === undefined ? undefined : {
      appendLine: (line) => this.output?.appendLine(line + ' trace=' + traceId + ' startup=' + startupId),
    });
    const controller = new DocumentController(document.session, panel.webview, {
      onQueryOperation: (event) => querySink.record(event),
      beforeRebuild: () => document.resetRecovery(),
      onRowOrderChanged: (direction) => {
        this.rowOrderWrite = this.rowOrderWrite.catch(() => {}).then(
          () => this.context.globalState.update('jsonlView.rowOrder', direction),
        );
        return this.rowOrderWrite;
      },
      onReady: () => document.flushPendingReveal(),
      onReadyReceived: () => {
        lastStage = 'ready-received';
        appendOutputLog(this.output, 'webview-ready', 'trace=' + traceId + ' received=true startup=' + startupId);
      },
      onOpenedDelivery: (delivered) => {
        lastStage = delivered ? 'opened-posted' : 'opened-post-rejected';
        appendOutputLog(this.output, 'webview-delivery', 'trace=' + traceId + ' type=OPENED delivered=' + String(delivered)
          + ' startup=' + startupId);
      },
      onFirstRowsRequest: () => {
        lastStage = 'rows-requested';
        appendOutputLog(this.output, 'first-rows', 'trace=' + traceId + ' stage=requested startup=' + startupId);
      },
      onFirstRowsResult: ({ status, rows, indexedRecords }) => {
        lastStage = 'rows-' + status;
        appendOutputLog(this.output, 'first-rows', 'trace=' + traceId + ' stage=result status=' + status
          + ' startup=' + startupId
          + (rows === undefined ? '' : ' rows=' + String(rows))
          + (indexedRecords === undefined ? '' : ' indexedRecords=' + indexedRecords));
      },
      onOpenSessionNavigator: () => this.openSessionNavigator(),
      getPreviewStatus: () => this.previews?.status(document.uri),
      onSavePreviewAs: async (isCurrent) => this.previews?.saveAs(document.uri, isCurrent),
      onTransientSourceChange: () => document.notifyTransientSourceChange(),
      onDiagnosticError: ({ code, message, action }) => offerDiagnostic({
        stage: 'editor-error-banner',
        name: code,
        message,
      }, action),
    });
    const previewRegistration = this.previews?.onDidChange(() => {
      void controller.publishPreviewStatus().catch(() => { /* A closed Webview cannot receive status. */ });
    });
    const panelRegistration = document.addPanel(panel);
    const messageRegistration = panel.webview.onDidReceiveMessage((message) => {
      const startupStage = parseStartupStageReceipt(message, EXECUTION_IDENTITY, this.runtimeIdentity);
      if (startupStage !== undefined) {
        const snapshot = document.session.getSummary().snapshot;
        if (startupStage.startupId !== startupId
          || startupStage.documentId !== snapshot.documentId || startupStage.generation !== snapshot.generation
          || startupStage.epoch !== snapshot.epoch) return;
        lastStage = startupStage.stage;
        appendOutputLog(this.output, 'webview-receipt', 'trace=' + traceId + ' stage=' + startupStage.stage
          + ' startup=' + startupId
          + ' identity=' + startupStage.executionIdentity.manifestSha256
          + ' extensionMode=' + startupStage.runtimeIdentity.extensionMode
          + (startupStage.rows === undefined ? '' : ' rows=' + String(startupStage.rows)));
        if (startupStage.stage === 'page-committed') {
          if (startupOutcome === 'startup-error' || startupOutcome === 'stalled') {
            appendOutputLog(this.output, 'startup-recovered', 'trace=' + traceId
              + ' after=' + startupOutcome + ' rows=' + String(startupStage.rows)
              + ' startup=' + startupId);
            startupOutcome = 'page-committed';
          } else {
            finishStartup('page-committed', startupStage.rows);
          }
        }
        if (startupStage.stage === 'startup-error') finishStartup('startup-error');
        return;
      }
      if (message !== null && typeof message === 'object' && message.type === 'JSONLVIEW_STARTUP_STAGE') {
        appendOutputLog(this.output, 'webview-receipt', 'trace=' + traceId + ' stage=rejected reason=invalid-startup-receipt startup=' + startupId);
        return;
      }
      if (isWebviewDiagnostic(message)) {
        void offerDiagnostic({ stage: 'editor-webview', name: message.name, message: message.message });
        return;
      }
      void controller.handleMessage(message).catch((error: unknown) => {
        void offerDiagnostic({
          stage: 'editor-message',
          name: error instanceof Error ? error.name : 'Error',
          message: error instanceof Error ? error.message : String(error),
        });
      });
    });
    const viewStateRegistration = panel.onDidChangeViewState((event) => {
      if (!event.webviewPanel.visible) {
        controller.cancelActive();
      } else if (event.webviewPanel.active) {
        this.lastResolvedDocument = document;
      }
    });
    const disposePanel = () => {
      finishStartup('disposed');
      controller.dispose();
      previewRegistration?.dispose();
      messageRegistration.dispose();
      viewStateRegistration.dispose();
      panelRegistration.dispose();
      if (!document.hasPanels) this.resolvedDocuments.delete(document);
      if (this.lastResolvedDocument === document && !document.hasPanels) {
        this.lastResolvedDocument = [...this.resolvedDocuments].at(-1);
      }
    };
    const disposeRegistration = panel.onDidDispose(disposePanel);
    try {
      lastStage = 'html-assigned';
      panel.webview.html = getWebviewHtml(
        panel.webview,
        this.context.extensionUri,
        document.session.getSummary().snapshot,
        pageSize,
        savedRowOrder === 'desc' ? 'desc' : 'asc',
        startupId,
        this.runtimeIdentity,
      );
      appendOutputLog(this.output, 'resolve-editor', 'trace=' + traceId + ' stage=html-assigned startup=' + startupId);
      if (!startupFinished) {
        stallTimer = setTimeout(() => {
          startupStalled = true;
          appendOutputLog(this.output, 'startup-stalled', 'trace=' + traceId
            + ' startup=' + startupId + ' lastStage=' + lastStage
            + ' elapsedMs=' + String(Math.round(performance.now() - startedAt)));
          finishStartup('stalled');
        }, STARTUP_STALL_MS);
      }
    } catch (error) {
      disposeRegistration.dispose();
      disposePanel();
      appendOutputLog(this.output, 'resolve-editor', 'trace=' + traceId + ' stage=failed startup=' + startupId);
      throw error;
    }
  }

  public async rebuildActiveDocument(): Promise<void> {
    if (this.lastResolvedDocument === undefined) {
      appendOutputLog(this.output, 'rebuild-skipped', 'reason=no-active-document');
      void vscode.window.showInformationMessage('Open a JSONL file in JsonlView before rebuilding its index.');
      return;
    }
    appendOutputLog(this.output, 'rebuild-requested');
    await this.lastResolvedDocument.rebuild();
    appendOutputLog(this.output, 'rebuild-complete');
  }

}

let lastDiagnostic: JsonlViewDiagnosticEnvelope | undefined;
let outputChannel: vscode.LogOutputChannel | undefined;
let activeNavigator: SessionNavigatorTreeProvider | undefined;

function currentDiagnostic(): JsonlViewDiagnosticEnvelope {
  return lastDiagnostic ?? buildDiagnosticEnvelope({
    stage: 'webview-host-registration',
    name: 'InvalidStateError',
    message: 'The VS Code Webview host reported that the document is in an invalid state while registering its service worker. JsonlView does not register a service worker.',
    extensionId: 'Sumi-Sophia.jsonl-view',
  });
}

async function offerDiagnostic(input: { stage: string; name: string; message: string }, preferredAction?: 'explain' | 'copy'): Promise<void> {
  const envelope = buildDiagnosticEnvelope({
    ...input,
    extensionId: 'Sumi-Sophia.jsonl-view',
  });
  lastDiagnostic = envelope;
  logLifecycleFailure(outputChannel, 'webview_diagnostic', envelope.error);
  if (preferredAction === 'copy') {
    await handleDiagnosticAction('Copy diagnostic context', envelope);
    return;
  }
  if (preferredAction === 'explain') {
    await handleDiagnosticAction('Explain with VS Code Chat', envelope);
    return;
  }
  const action = await vscode.window.showErrorMessage(
    'JsonlView detected a bounded Webview error. Source contents were not included.',
    'Explain with VS Code Chat',
    'Copy diagnostic context',
    'Open JsonlView Log',
  );
  await handleDiagnosticAction(action, envelope);
}

async function handleDiagnosticAction(action: string | undefined, envelope: JsonlViewDiagnosticEnvelope): Promise<void> {
  if (action === 'Copy diagnostic context') {
    await vscode.env.clipboard.writeText(formatDiagnosticContext(envelope));
    return;
  }
  if (action === 'Open JsonlView Log') {
    outputChannel?.show(true);
    return;
  }
  if (action !== 'Explain with VS Code Chat') return;
  const prompt = formatDiagnosticPrompt(envelope);
  await vscode.env.clipboard.writeText(prompt);
  try {
    await vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt });
  } catch {
    void vscode.window.showInformationMessage('VS Code Chat is unavailable. The bounded diagnostic prompt was copied instead.');
  }
}

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel('JsonlView', { log: true });
  context.subscriptions.push(outputChannel);
  appendOutputLog(outputChannel, 'activated', 'output-channel=JsonlView');
  const runtimeIdentity = captureRuntimeExecutionIdentity(context);
  appendExecutionIdentityLog(outputChannel, EXECUTION_IDENTITY, runtimeIdentity);
  const conflict = findExtensionContributionConflict(context.extension.id, vscode.extensions.all);
  if (conflict !== undefined) {
    appendOutputLog(outputChannel, 'activation-blocked', `conflict=${conflict.extensionId}`);
    void vscode.window.showErrorMessage(
      `JsonlView cannot activate while ${conflict.extensionId} is enabled because both extensions declare ${conflict.contributionIds.join(', ')}. Disable or uninstall one JsonlView build, then reload the window.`,
    );
    return;
  }
  const revealRegistry = new RevealIntentRegistry();
  const navigator = new SessionNavigatorTreeProvider(context, revealRegistry);
  activeNavigator = navigator;
  const recentPreviews = new RecentPreviewsTreeProvider(navigator.previews);
  const provider = new JsonlViewProvider(context, revealRegistry, () => navigator.open(), outputChannel, runtimeIdentity, navigator.previews);
  context.subscriptions.push(
    ...navigator.register(),
    navigator,
    ...recentPreviews.register(),
    recentPreviews,
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
    vscode.commands.registerCommand('jsonlView.diagnoseWebview', async () => {
      const envelope = currentDiagnostic();
      lastDiagnostic = envelope;
      const action = await vscode.window.showInformationMessage('JsonlView prepared a bounded Webview diagnosis without source contents.', 'Explain with VS Code Chat', 'Copy diagnostic context');
      await handleDiagnosticAction(action, envelope);
    }),
    vscode.commands.registerCommand('jsonlView.showOutput', () => outputChannel?.show(true)),
    vscode.commands.registerCommand('jsonlView.explainLastDiagnostic', () => handleDiagnosticAction('Explain with VS Code Chat', currentDiagnostic())),
    vscode.commands.registerCommand('jsonlView.copyLastDiagnostic', () => vscode.env.clipboard.writeText(formatDiagnosticContext(currentDiagnostic()))),
  );
  appendOutputLog(outputChannel, 'activated', 'commands-and-views=registered');
}

export async function deactivate(): Promise<void> {
  const navigator = activeNavigator;
  activeNavigator = undefined;
  navigator?.dispose();
  await navigator?.previews.dispose();
  appendOutputLog(outputChannel, 'deactivated');
  outputChannel = undefined;
}

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

function isWebviewDiagnostic(value: unknown): value is { readonly type: 'JSONLVIEW_DIAGNOSTIC'; readonly name: string; readonly message: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  return message.type === 'JSONLVIEW_DIAGNOSTIC' && typeof message.name === 'string' && message.name.length > 0 && message.name.length <= 128
    && typeof message.message === 'string' && message.message.length > 0 && message.message.length <= 512;
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
