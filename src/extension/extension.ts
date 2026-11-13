import { basename, dirname, resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { exportOpenRawJsonl } from './raw-export/open-jsonl';
import { NativeRawExports, type NativeRawExportSource } from './raw-export/native-exports';
import { RawJsonlExportError, type RawJsonlExportResult } from './raw-export/jsonl';
import * as vscode from 'vscode';
import { findExtensionContributionConflict } from './extension-conflicts';
import type { DocumentSummary, ExtensionMessage, HostBroadcastMessageType } from '@shared/types';
import { createProtocolEnvelope } from '@shared/transport';
import { DocumentController } from './document-controller';
import { DocumentGraphController } from './document-graph';
import { IntegratedJsonlSession, type DatasetDetectionReceipt } from './integrated-session/integrated-session';
import type { NativeNewlineScannerSetting, SourceRefreshResult } from '../engine';
import { shouldAutoFollow } from './follow/policy';
import {
  FollowRecoveryCoordinator,
  isTransientFileLockError,
  postMessageBestEffort,
  shouldNotifyFollowRecovery,
  type FollowRecoveryIdentity,
  type FollowRecoveryProbe,
} from './follow/recovery';
import { getWebviewHtml } from './webview-html';
import { MCP_NAVIGATION_CAPABILITY, RevealIntentRegistry, type PendingRevealIntent } from '../experimental';
import type { RevealResult, RevealRowTarget } from '@shared/protocol/reveal';
import { SessionNavigatorTreeProvider, type NavigatorBridgeTarget } from '@experimental/session-navigator/tree-provider';
import type { SessionPreviews } from '@experimental/session-navigator/session-previews';
import { buildDiagnosticEnvelope, formatDiagnosticContext, formatDiagnosticPrompt, type JsonlViewDiagnosticEnvelope } from './diagnostics/diagnostic-context';
import { isWebviewDiagnostic } from './diagnostics/webview-message';
import { appendExecutionIdentityLog, appendOutputLog, createOutputLogObservabilitySink, type JsonlViewOutputChannel } from './observability/output-log';
import { createCausalLifecycleTrace, type CausalLifecycleTrace } from './observability/observability-contract';
import {
  createCompositeObservabilitySink,
  readOtlpSettings,
  startCompositeObservabilitySink,
  type CompositeObservabilitySink,
} from './observability/composite-observability-sink';
import { createCdpQueryTap, isCdpQueryTapEnabled } from './observability/cdp-query-tap';
import { parseStartupStageReceipt } from './startup-stage';
import { logLifecycleFailure } from './observability/lifecycle-failure';
import { summaryIdentityMatches } from './summary-identity';
import { EXECUTION_IDENTITY, type RuntimeExecutionIdentity } from '@shared/execution-identity';
import { captureRuntimeExecutionIdentity } from './execution-runtime';
import { buildActivationConflictDiagnostic, buildSideAgentDiagnostic, createSideAgentDiagnosticPort, type SideAgentDiagnosticEvent, type SideAgentDiagnosticPort } from './diagnostics/side-agent-diagnostics';
import {
  buildActivationConflictPresentation,
  createDiagnosticActionController,
  DIAGNOSTIC_ACTION,
  isJsonlResource,
} from './extension-controller';
import { createMcpDiagnosticPlan } from './native-mcp-manager';
import { loadRustQueryBridge, type RustQueryBridge } from './rust-query-bridge';
import { AcpSessionCancelledError, AcpSessionManager } from './acp/session-manager';
import type { AcpAgentProfile } from './acp/agent-profiles';
import { readConfiguredAcpProfiles, chooseAcpAgentProfile, selectConfiguredAcpAgentProfile } from './acp/agent-profile-picker';
import { AcpOperationLifetime } from './acp/operation-lifetime';
import { describeAcpFailure, withAcpDiagnosticProgress, type AcpDiagnosticProgress } from './acp/diagnostic-progress';
import { RevealTextDocuments } from './reveal-text/documents';
import { createRevealTextReadPort } from './reveal-text/source';
import type { AcpMcpServerStdio, AcpSessionStage } from './acp/session-manager';

const SOURCE_RECONCILE_DELAY_MS = 150;
const STARTUP_STALL_MS = 10_000;

export class JsonlViewDocument implements vscode.CustomDocument {
  public readonly uri: vscode.Uri;
  public readonly session: IntegratedJsonlSession;
  private readonly panels = new Set<vscode.WebviewPanel>();
  private readonly disposables: vscode.Disposable[] = [];
  private reconcileTimer: NodeJS.Timeout | undefined;
  private reconciling = false;
  private reconcilePending = false;
  private disposed = false;
  private publishedProfileId: string;
  private publishedProfileVersion: string | undefined;
  private pendingReveal: PendingRevealIntent | undefined;
  private revealHandler: ((target: RevealRowTarget) => Promise<RevealResult>) | undefined;
  private readonly recovery: FollowRecoveryCoordinator;
  private readonly followModeRegistration: { dispose(): void };
  /** One bounded source-to-Webview trace for the active recovery attempt. */
  private recoveryTrace: CausalLifecycleTrace | undefined;

  private constructor(
    uri: vscode.Uri,
    session: IntegratedJsonlSession,
  ) {
    this.uri = uri;
    this.session = session;
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

  public publishNavigatorVisibility(visible: boolean): Promise<boolean> {
    return this.broadcast(this.session.getSummary().snapshot, 'NAVIGATOR_VISIBILITY', { visible });
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

  public setPendingReveal(intent: PendingRevealIntent): void {
    this.pendingReveal = intent;
    void this.flushPendingReveal();
  }

  public async flushPendingReveal(handler?: (target: RevealRowTarget) => Promise<RevealResult>): Promise<void> {
    if (handler !== undefined) this.revealHandler = handler;
    const intent = this.pendingReveal;
    if (intent === undefined || this.revealHandler === undefined) return;
    this.pendingReveal = undefined;
    const current = { ...this.session.getSummary().snapshot };
    const target = {
      sourceId: intent.sourceId,
      nativeId: intent.nativeId,
      anchorOrdinal: intent.anchorOrdinal,
    };
    if (!intent.isAuthorized()) {
      intent.complete({ outcome: 'unauthorized', documentId: current.documentId, generation: current.generation,
        ...(current.epoch === undefined ? {} : { epoch: current.epoch }), requestId: '', anchorOrdinal: intent.anchorOrdinal });
      return;
    }
    const result = await this.revealHandler(target);
    intent.complete(result.outcome === 'shown' && !intent.isAuthorized() ? { ...result, outcome: 'unauthorized' } : result);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.revealHandler = undefined;
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

  private async broadcast<TType extends HostBroadcastMessageType>(
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
      delivery: 'broadcast',
      requestId: '',
      payload,
    }) as unknown as Extract<ExtensionMessage, { type: TType }> & { delivery: 'broadcast' };
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
  private readonly context: vscode.ExtensionContext;
  private readonly revealRegistry: RevealIntentRegistry;
  private readonly openSessionNavigator: (target?: NavigatorBridgeTarget) => Promise<unknown> | unknown;
  private readonly output: JsonlViewOutputChannel | undefined;
  private readonly runtimeIdentity: RuntimeExecutionIdentity;
  private readonly previews: SessionPreviews | undefined;
  private readonly resolvedDocuments = new Set<JsonlViewDocument>();
  private readonly traceIds = new WeakMap<JsonlViewDocument, string>();
  private nextTraceId = 0;
  private nextStartupId = 0;
  private lastResolvedDocument: JsonlViewDocument | undefined;
  private navigatorVisible = false;
  private rowOrderWrite: Promise<void> = Promise.resolve();
  private recordTextDocuments: RevealTextDocuments | undefined;
  private readonly exports = new Map<JsonlViewDocument, Promise<RawJsonlExportResult | undefined>>();
  private scopedRawExports: NativeRawExports | undefined;

  public constructor(
    context: vscode.ExtensionContext,
    revealRegistry: RevealIntentRegistry,
    openSessionNavigator: (target?: NavigatorBridgeTarget) => Promise<unknown> | unknown,
    output: JsonlViewOutputChannel | undefined,
    runtimeIdentity: RuntimeExecutionIdentity = captureRuntimeExecutionIdentity(context),
    previews?: SessionPreviews,
  ) {
    this.context = context;
    this.revealRegistry = revealRegistry;
    this.openSessionNavigator = openSessionNavigator;
    this.output = output;
    this.runtimeIdentity = runtimeIdentity;
    this.previews = previews;
    // Existing editors also consume the one-shot handoff; opening an already
    // visible custom editor does not necessarily re-run resolveCustomEditor.
    if (revealRegistry.onQueued !== undefined) context.subscriptions.push(revealRegistry.onQueued((uri) => {
      const document = [...this.resolvedDocuments].find((candidate) => candidate.hasPanels && candidate.uri.toString() === uri);
      const intent = document === undefined ? undefined : revealRegistry.take(uri);
      if (intent !== undefined) document!.setPendingReveal(intent);
    }));
  }

  public setNavigatorVisibility(visible: boolean): void {
    if (this.navigatorVisible === visible) return;
    this.navigatorVisible = visible;
    for (const document of this.resolvedDocuments) {
      void document.publishNavigatorVisibility(visible).catch((error: unknown) => {
        logLifecycleFailure(this.output, 'webview_delivery', error);
      });
    }
  }

  public registerRecordTextDocuments(): void {
    if (this.recordTextDocuments !== undefined) return;
    this.recordTextDocuments = new RevealTextDocuments(createRevealTextReadPort((sourceId) => {
      const document = [...this.resolvedDocuments].find((candidate) => candidate.session.getSummary().snapshot.documentId === sourceId);
      return document === undefined ? undefined : { session: document.session,
        isAuthorized: () => this.resolvedDocuments.has(document) && document.hasPanels };
    }));
    this.context.subscriptions.push(this.recordTextDocuments);
  }

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
    const localQuerySink = createOutputLogObservabilitySink(this.output === undefined ? undefined : {
      appendLine: (line) => this.output?.appendLine(line + ' trace=' + traceId + ' startup=' + startupId),
    });
    const querySink = activeObservabilitySink?.withLocalSink(localQuerySink) ?? localQuerySink;
    const queryTap = createCdpQueryTap(panel.webview, { traceId, startupId }, isCdpQueryTapEnabled(
      this.runtimeIdentity.extensionMode, process.env.JSONLVIEW_CDP_QUERY_TAP,
    ));
    const controller = new DocumentController(document.session, panel.webview, {
      graph: new DocumentGraphController(document.session, () => this.resolvedDocuments.has(document) && document.hasPanels),
      onAcceptedRawQuery: (summary, predicate) => this.rawExports().acceptQuery(document.session, summary, predicate),
      onAcceptedRawSelection: (summary, ref) => this.rawExports().acceptSelection(document.session, summary, ref),
      onQueryOperation: (event) => {
        querySink.record(event);
        queryTap.record(event);
      },
      beforeRebuild: () => document.resetRecovery(),
      onRowOrderChanged: (direction) => {
        this.rowOrderWrite = this.rowOrderWrite.catch(() => {}).then(
          () => this.context.globalState.update('jsonlView.rowOrder', direction),
        );
        return this.rowOrderWrite;
      },
      onReady: () => document.flushPendingReveal((target) => controller.revealRow(target)),
      getNavigatorVisibility: () => this.navigatorVisible,
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
      onOpenSessionNavigator: () => {
        const snapshot = document.session.getSummary().snapshot;
        return this.openSessionNavigator({ documentId: snapshot.documentId, sourceUri: snapshot.uri });
      },
      getPreviewStatus: () => this.previews?.status(document.uri),
      onSavePreviewAs: async (isCurrent) => this.previews?.saveAs(document.uri, isCurrent),
      onTransientSourceChange: () => document.notifyTransientSourceChange(),
      validateRevealSource: () => document.session.validateObservedSource(),
      onOpenRecordText: (ref, isCurrent) => {
        const snapshot = document.session.getSummary().snapshot;
        return this.recordTextDocuments?.open({ sourceId: snapshot.documentId, generation: snapshot.generation,
          ordinal: ref.ordinal, ref }, () => isCurrent() && this.resolvedDocuments.has(document) && document.hasPanels);
      },
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
      queryTap.dispose();
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

  public async exportRawRecords(uri?: vscode.Uri): Promise<void> {
    const document = uri === undefined ? this.lastResolvedDocument
      : [...this.resolvedDocuments].find((item) => item.uri.toString() === uri.toString());
    if (document === undefined || !document.hasPanels || document.uri.scheme !== 'file') {
      void vscode.window.showInformationMessage('Open a local file in JsonlView before exporting its raw records.');
      return;
    }
    await this.rawExports().export(this.rawExportSource(document));
  }

  public async recoverRawExport(): Promise<void> {
    await this.rawExports().recover((intent) => {
      const document = [...this.resolvedDocuments].find((item) => item.session.getSummary().snapshot.uri === intent.binding.uri);
      return document === undefined ? undefined : this.rawExportSource(document);
    });
  }

  private rawExports(): NativeRawExports {
    this.scopedRawExports ??= new NativeRawExports(this.context.globalStorageUri.fsPath);
    return this.scopedRawExports;
  }

  private rawExportSource(document: JsonlViewDocument): NativeRawExportSource {
    return { uri: document.uri, session: document.session,
      isAuthorized: () => this.resolvedDocuments.has(document) && document.hasPanels };
  }

  public exportRawSource(uri?: vscode.Uri): Promise<RawJsonlExportResult | undefined> {
    const document = uri === undefined ? this.lastResolvedDocument
      : [...this.resolvedDocuments].find((item) => item.uri.toString() === uri.toString());
    if (document === undefined || !document.hasPanels || document.uri.scheme !== 'file') {
      void vscode.window.showInformationMessage('Open a file in JsonlView before exporting its raw JSONL source.');
      return Promise.resolve(undefined);
    }
    const existing = this.exports.get(document);
    if (existing !== undefined) return existing;
    const operation = this.exportDocument(document).finally(() => { this.exports.delete(document); });
    this.exports.set(document, operation);
    return operation;
  }

  private async exportDocument(document: JsonlViewDocument): Promise<RawJsonlExportResult | undefined> {
    const destination = await vscode.window.showSaveDialog({
      title: 'Export entire raw source (all physical rows; filters and sort excluded)',
      defaultUri: vscode.Uri.file(document.uri.fsPath.replace(/\.(jsonl|ndjson)$/iu, '.export.$1')),
      filters: { 'JSONL / NDJSON': ['jsonl', 'ndjson'] },
      saveLabel: 'Export New Copy',
    });
    if (destination === undefined) return undefined;
    if (destination.scheme !== 'file') {
      void vscode.window.showErrorMessage('Raw JSONL export requires a local filesystem destination.');
      return undefined;
    }
    try {
      const result = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'JsonlView: Exporting entire raw JSONL source (up to 1 GiB)', cancellable: true,
      }, async (_progress, token) => {
        const cancellation = new AbortController();
        const subscription = token.onCancellationRequested(() => cancellation.abort());
        if (token.isCancellationRequested) cancellation.abort();
        try {
          return await exportOpenRawJsonl({
            sourcePath: document.uri.fsPath,
            currentIdentity: () => this.resolvedDocuments.has(document) && document.hasPanels
              ? document.session.getSummary().snapshot : undefined,
            isUnchanged: (signal) => document.session.validateObservedSource(signal),
          }, destination.fsPath, cancellation.signal);
        } finally { subscription.dispose(); }
      });
      if (result.status === 'committed') {
        void vscode.window.showInformationMessage('Raw JSONL export completed: all physical bytes copied and SHA-256 verified.');
      } else {
        void vscode.window.showWarningMessage('The export publication could not be verified. Inspect the selected destination before retrying; it was preserved.');
      }
      return result;
    } catch (error) {
      if (error instanceof RawJsonlExportError && error.code === 'cancelled') return undefined;
      void vscode.window.showErrorMessage(error instanceof RawJsonlExportError ? error.message : 'Raw JSONL export could not complete.');
      return undefined;
    }
  }

}

let lastDiagnostic: JsonlViewDiagnosticEnvelope | undefined;
let extensionContext: vscode.ExtensionContext | undefined;
let outputChannel: vscode.LogOutputChannel | undefined;
let activeNavigator: SessionNavigatorTreeProvider | undefined;
let activeObservabilitySink: CompositeObservabilitySink | undefined;
let sideAgentDiagnostics: SideAgentDiagnosticPort | undefined;
let rustQueryBridge: RustQueryBridge | undefined;
let acpSession: AcpSessionManager | undefined;
const acpOperationLifetime = new AcpOperationLifetime();
const SEND_TO_SIDE_AGENT = DIAGNOSTIC_ACTION.sendToSideAgent;
const OPEN_JSONLVIEW_LOG = DIAGNOSTIC_ACTION.openLog;
const COPY_DIAGNOSTIC_CONTEXT = DIAGNOSTIC_ACTION.copyContext;
const QUERY_RUST_PAGE = 'jsonlView.queryRustPage';
const SEND_DIAGNOSTIC_VIA_ACP = 'jsonlView.sendLastDiagnosticViaAcp';
const ACP_TRANSCRIPT_MAX_BYTES = 512 * 1024;
const ACP_TRANSCRIPT_MAX_UPDATES = 256;

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
    SEND_TO_SIDE_AGENT,
    'Explain with VS Code Chat',
    'Copy diagnostic context',
    'Open JsonlView Log',
  );
  await handleDiagnosticAction(action, envelope);
}

const dispatchDiagnosticAction = createDiagnosticActionController({
  copyText: (text) => vscode.env.clipboard.writeText(text),
  openLog: () => outputChannel?.show(true),
  sendToSideAgent: (diagnostic, envelope, context) =>
    sendDiagnosticToSideAgent(diagnostic, envelope, context ?? extensionContext),
  explainWithChat: async (prompt) => {
    await vscode.env.clipboard.writeText(prompt);
    try {
      await vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt });
    } catch {
      void vscode.window.showInformationMessage('VS Code Chat is unavailable. The bounded diagnostic prompt was copied instead.');
    }
  },
});

async function handleDiagnosticAction(
  action: string | undefined,
  envelope: JsonlViewDiagnosticEnvelope,
  options: Parameters<typeof dispatchDiagnosticAction>[2] = {},
): Promise<void> {
  await dispatchDiagnosticAction(action, envelope, options);
}

async function sendDiagnosticToSideAgent(
  diagnostic: SideAgentDiagnosticEvent,
  envelope: JsonlViewDiagnosticEnvelope,
  context: vscode.ExtensionContext | undefined,
): Promise<void> {
  let pendingDelivery: Promise<void> | undefined;
  await acpOperationLifetime.run(async () => {
    const profiles = readConfiguredAcpProfiles();
    if (profiles.invalidCount > 0) {
      appendOutputLog(outputChannel, 'acp-profile-config', JSON.stringify({ invalidCount: profiles.invalidCount }));
      if (profiles.profiles.length === 0) {
        void vscode.window.showInformationMessage('ACP agent configuration is invalid. Review jsonlView.acp.profiles or the legacy jsonlView.acp.command setting.');
        return;
      }
    }
    if (profiles.profiles.length > 0 || profiles.configured) {
      if (profiles.profiles.length === 0) {
        void vscode.window.showInformationMessage('No valid ACP agent profile is configured. Review jsonlView.acp.profiles in Settings.');
        return;
      }
      if (!vscode.workspace.isTrusted) {
        await vscode.env.clipboard.writeText(formatDiagnosticPrompt(envelope));
        if (!acpOperationLifetime.isOpen) return;
        void vscode.window.showInformationMessage('The workspace is untrusted, so the configured ACP agent was not launched. The bounded diagnostic prompt was copied instead.');
        return;
      }
      if (context !== undefined) {
        const profile = profiles.profiles.length === 1
          ? profiles.profiles[0]
          : await chooseAcpAgentProfile(profiles.profiles, acpOperationLifetime.signal);
        if (profile === undefined || !acpOperationLifetime.isOpen) return;
        await runDiagnosticViaAcp(envelope, context, profile);
        return;
      }
    }
    // Only ACP-owned selection and session work participates in shutdown.
    // An optional host command may never settle, so start it outside the
    // tracked lifetime and guard all of its follow-up effects after awaiting.
    const diagnostics = sideAgentDiagnostics;
    pendingDelivery = (async () => {
      const delivery = await diagnostics?.publish(diagnostic);
      if (!acpOperationLifetime.isOpen) return;
      appendOutputLog(outputChannel, 'side-agent-diagnostic', `kind=${diagnostic.kind} outcome=${delivery ?? 'unavailable'}`);
      if (delivery === 'delivered' || delivery === 'duplicate') return;

      // The external side-agent command is optional. Keep the fallback provider-neutral.
      const prompt = formatDiagnosticPrompt(envelope);
      await vscode.env.clipboard.writeText(prompt);
      if (!acpOperationLifetime.isOpen) return;
      void vscode.window.showInformationMessage('No side-agent MCP bridge is available. The bounded diagnostic prompt was copied instead.');
    })();
  });
  if (pendingDelivery !== undefined) void pendingDelivery.catch(() => {});
}

function sendConfiguredDiagnosticViaAcp(envelope: JsonlViewDiagnosticEnvelope, context: vscode.ExtensionContext): Promise<void> {
  return acpOperationLifetime.run(async () => {
    const profile = await selectConfiguredAcpAgentProfile((invalidCount) => {
      appendOutputLog(outputChannel, 'acp-profile-config', JSON.stringify({ invalidCount }));
    }, acpOperationLifetime.signal);
    if (profile === undefined || !acpOperationLifetime.isOpen) return;
    await runDiagnosticViaAcp(envelope, context, profile);
  });
}

async function runDiagnosticViaAcp(envelope: JsonlViewDiagnosticEnvelope, context: vscode.ExtensionContext, profile: AcpAgentProfile): Promise<void> {
  if (!acpOperationLifetime.isOpen) return;
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showErrorMessage('ACP agents can only be launched in a trusted workspace.');
    return;
  }
  const previousSession = acpSession;
  acpSession = undefined;
  await previousSession?.close();
  if (!acpOperationLifetime.isOpen) return;
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const source = activeResourceUri();
  const mcpServers: readonly AcpMcpServerStdio[] = source !== undefined && source.scheme === 'file' && isJsonlResource(source)
    ? [{
      name: 'jsonlview',
      command: process.execPath,
      args: [resolve(context.extensionPath, 'dist', 'mcp-server.cjs')],
      env: [
        { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
        { name: 'JSONLVIEW_EXTENSION_PATH', value: context.extensionPath },
        { name: 'JSONLVIEW_MCP_SOURCE_ID', value: 'active-jsonl' },
        { name: 'JSONLVIEW_MCP_SOURCE_PATH', value: source.fsPath },
      ],
    }]
    : [];
  const acpUpdates: unknown[] = [];
  let acpUpdatesBytes = 0;
  let acpUpdatesTruncated = false;
  let acpPromptResult: unknown;
  let acpSessionId: string | undefined;
  let cancellationRequested = false;
  let stage: AcpSessionStage = 'launch';
  let progress: AcpDiagnosticProgress | undefined;
  let awaitingPermission = false;
  const started = Date.now();
  const activeAcpSession = new AcpSessionManager({
    launch: {
      command: profile.command,
      args: profile.args,
      executionTarget: { kind: profile.executionTarget },
      ...(workspacePath === undefined ? {} : { cwd: workspacePath, sessionCwd: workspacePath }),
      sessionMcpServers: mcpServers,
      timeoutMs: profile.timeoutMs,
    },
    onStderr: (line) => appendOutputLog(outputChannel, 'acp-stderr', JSON.stringify({ bytes: Buffer.byteLength(line, 'utf8') })),
    onStage: (next) => {
      stage = next;
      progress?.report(next);
      appendOutputLog(outputChannel, 'acp-stage', JSON.stringify({ stage: next, elapsedMs: Date.now() - started }));
    },
    onRequestPermission: async (request, signal) => {
      if (signal.aborted) return { outcome: 'cancelled' };
      const options = request.options.filter((option) => option.kind === 'allow_once' || option.kind === 'reject_once');
      if (options.length === 0) return { outcome: 'cancelled' };
      const cancellation = new vscode.CancellationTokenSource();
      const abort = (): void => cancellation.cancel();
      signal.addEventListener('abort', abort, { once: true });
      try {
        awaitingPermission = true;
        progress?.report('permission');
        const picked = await vscode.window.showQuickPick(options.map((option) => ({
          label: option.name, description: option.kind === 'allow_once' ? 'Allow once' : 'Reject once', optionId: option.optionId,
        })), { title: 'ACP tool permission', placeHolder: request.toolCall.title ?? 'Choose a permission for this tool call', ignoreFocusOut: true }, cancellation.token);
        return picked === undefined || signal.aborted ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: picked.optionId };
      } finally {
        awaitingPermission = false;
        if (!cancellationRequested) progress?.report('session/prompt');
        signal.removeEventListener('abort', abort);
        cancellation.dispose();
      }
    },
    onUpdate: (event) => {
      const update = event.update;
      if (!awaitingPermission && !cancellationRequested && typeof update === 'object' && update !== null &&
        'sessionUpdate' in update && update.sessionUpdate === 'agent_message_chunk') progress?.report('receiving');
      if (acpUpdates.length >= ACP_TRANSCRIPT_MAX_UPDATES) {
        acpUpdatesTruncated = true;
        return;
      }
      let encoded: string;
      try { encoded = JSON.stringify(event); } catch { acpUpdatesTruncated = true; return; }
      const bytes = Buffer.byteLength(encoded, 'utf8');
      if (acpUpdatesBytes + bytes > ACP_TRANSCRIPT_MAX_BYTES) {
        acpUpdatesTruncated = true;
        return;
      }
      acpUpdates.push(JSON.parse(encoded) as unknown);
      acpUpdatesBytes += bytes;
    },
  });
  acpSession = activeAcpSession;
  try {
    await withAcpDiagnosticProgress(async (operationProgress) => {
      progress = operationProgress;
      const token = progress.token;
      const cancellation = token.onCancellationRequested(() => {
        cancellationRequested = true;
        progress?.report('cancelling');
        activeAcpSession.cancel();
      });
      try {
        if (!acpOperationLifetime.isOpen) return;
        if (token.isCancellationRequested) throw new AcpSessionCancelledError();
        acpSessionId = await activeAcpSession.start();
        if (token.isCancellationRequested) throw new AcpSessionCancelledError();
        acpPromptResult = await activeAcpSession.prompt(formatDiagnosticPrompt(envelope));
        cancellationRequested ||= token.isCancellationRequested;
      } finally {
        progress = undefined;
        cancellation.dispose();
      }
    });
    if (acpSession !== activeAcpSession) return;
    const cancelledByAgent = typeof acpPromptResult === 'object' && acpPromptResult !== null &&
      'stopReason' in acpPromptResult && acpPromptResult.stopReason === 'cancelled';
    const transcript = {
      schema: 'jsonlview.acp-transcript.v2',
      sessionId: acpSessionId,
      adapterId: profile.adapterId,
      agentProfileId: profile.id,
      protocolVersion: profile.protocolVersion,
      transport: profile.transport,
      executionTarget: profile.executionTarget,
      updates: acpUpdates,
      result: acpPromptResult,
      cancelled: cancellationRequested || cancelledByAgent,
      truncated: acpUpdatesTruncated,
    };
    const resultDocument = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(transcript, null, 2) });
    if (acpSession !== activeAcpSession) return;
    await vscode.window.showTextDocument(resultDocument, { preview: true });
    if (cancellationRequested || cancelledByAgent) {
      void vscode.window.showInformationMessage('The ACP diagnostic request was cancelled. The bounded transcript is open.');
    } else {
      void vscode.window.showInformationMessage('The bounded diagnostic was sent through the configured ACP agent.');
    }
  } catch (error) {
    if (acpSession !== activeAcpSession) return;
    if (error instanceof AcpSessionCancelledError) {
      void vscode.window.showInformationMessage('The ACP diagnostic request was cancelled.');
    } else {
      const { message, ...metadata } = describeAcpFailure(error, stage);
      appendOutputLog(outputChannel, 'acp-error', JSON.stringify({ ...metadata, elapsedMs: Date.now() - started }));
      void vscode.window.showErrorMessage(message, 'Open Output').then((action) => {
        if (action === 'Open Output') outputChannel?.show(true);
      });
    }
  } finally {
    const settlement = await activeAcpSession.close();
    if (settlement?.outcome === 'unknown') {
      appendOutputLog(outputChannel, 'acp-process-tree', 'outcome=unknown');
    }
    if (acpSession === activeAcpSession) acpSession = undefined;
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  acpOperationLifetime.open();
  extensionContext = context;
  outputChannel = vscode.window.createOutputChannel('JsonlView', { log: true });
  context.subscriptions.push(outputChannel);
  sideAgentDiagnostics = createSideAgentDiagnosticPort(
    (command, dispatch) => vscode.commands.executeCommand(command, dispatch),
    undefined,
    (diagnostic) => createMcpDiagnosticPlan(context.extensionPath, diagnostic),
  );
  appendOutputLog(outputChannel, 'activated', 'output-channel=JsonlView');
  const runtimeIdentity = captureRuntimeExecutionIdentity(context);
  appendExecutionIdentityLog(outputChannel, EXECUTION_IDENTITY, runtimeIdentity);
  const conflict = findExtensionContributionConflict(context.extension.id, vscode.extensions.all);
  if (conflict !== undefined) {
    appendOutputLog(outputChannel, 'activation-blocked', `conflict=${conflict.extensionId}`);
    const { diagnostic, envelope, notificationMessage } = buildActivationConflictPresentation(context.extension.id, conflict);
    lastDiagnostic = envelope;
    void (async () => {
      const action = await vscode.window.showErrorMessage(
        notificationMessage,
        SEND_TO_SIDE_AGENT, COPY_DIAGNOSTIC_CONTEXT, OPEN_JSONLVIEW_LOG,
      );
      await handleDiagnosticAction(action, envelope, { sideAgentDiagnostic: diagnostic, context });
    })();
    return;
  }
  const observabilitySink = createCompositeObservabilitySink({
    settings: readOtlpSettings((key) => vscode.workspace.getConfiguration().inspect<unknown>(key)),
    writeOutputChannelWarning: (message) => appendOutputLog(outputChannel, 'otlp-initialization-warning', message),
  });
  activeObservabilitySink = observabilitySink;
  const readCurrentOtlpSettings = () => readOtlpSettings(
    (key) => vscode.workspace.getConfiguration().inspect<unknown>(key),
  );
  const observabilityLifecycle = startCompositeObservabilitySink(
    observabilitySink,
    (onSettingsChange) => vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('jsonlView.telemetry.otlp')
        || event.affectsConfiguration('jsonlview.telemetry.otlp')) onSettingsChange();
    }),
    readCurrentOtlpSettings,
  );
  context.subscriptions.push(
    observabilityLifecycle.subscription,
    { dispose: () => { void observabilitySink.dispose(); } },
  );
  await observabilityLifecycle.ready;
  const revealRegistry = new RevealIntentRegistry();
  const navigator = new SessionNavigatorTreeProvider(context, revealRegistry, undefined, undefined,
    (error) => logLifecycleFailure(outputChannel, 'preview_collection_filing', error));
  activeNavigator = navigator;
  const provider = new JsonlViewProvider(context, revealRegistry, (target) => navigator.open(target), outputChannel, runtimeIdentity, navigator.previews);
  provider.registerRecordTextDocuments();
  context.subscriptions.push(
    navigator.onDidChangeVisibility((visible) => provider.setNavigatorVisibility(visible)),
    ...navigator.register(),
    navigator,
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
    vscode.commands.registerCommand('jsonlView.exportRawSource', async (uri?: vscode.Uri) => provider.exportRawSource(uri ?? activeResourceUri())),
    vscode.commands.registerCommand('jsonlView.exportRawRecords', async (uri?: vscode.Uri) => provider.exportRawRecords(uri ?? activeResourceUri())),
    vscode.commands.registerCommand('jsonlView.recoverRawExport', async () => provider.recoverRawExport()),
    vscode.commands.registerCommand(QUERY_RUST_PAGE, async (uri?: vscode.Uri) => {
      const target = uri ?? activeResourceUri();
      if (target === undefined || target.scheme !== 'file') {
        void vscode.window.showInformationMessage('Select a file-backed JSONL or NDJSON source before querying the Rust data plane.');
        return undefined;
      }
      if (!isJsonlResource(target)) {
        void vscode.window.showInformationMessage('The Rust data plane accepts JSONL and NDJSON sources only.');
        return undefined;
      }
      rustQueryBridge = loadRustQueryBridge(context.extensionPath, [dirname(target.fsPath)]);
      try {
        const page = rustQueryBridge.query({ sourcePath: target.fsPath, limit: 100, maxBytes: 1024 * 1024 });
        appendOutputLog(outputChannel, 'rust-query', JSON.stringify({ records: page.records.length, nextOrdinal: page.nextOrdinal, truncated: page.truncated }));
        const resultDocument = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(page, null, 2) });
        await vscode.window.showTextDocument(resultDocument, { preview: true });
        return page;
      } catch (error) {
        appendOutputLog(outputChannel, 'rust-query-error', error instanceof Error ? error.name : 'Error');
        void vscode.window.showErrorMessage('The Rust query capability is unavailable or rejected the bounded page. The normal JsonlView reader remains available.');
        return undefined;
      }
    }),
    vscode.commands.registerCommand(SEND_DIAGNOSTIC_VIA_ACP, async () => {
      await sendConfiguredDiagnosticViaAcp(currentDiagnostic(), context);
    }),
    vscode.commands.registerCommand('jsonlView.diagnoseWebview', async () => {
      const envelope = currentDiagnostic();
      lastDiagnostic = envelope;
      const action = await vscode.window.showInformationMessage('JsonlView prepared a bounded Webview diagnosis without source contents.', 'Explain with VS Code Chat', 'Copy diagnostic context');
      await handleDiagnosticAction(action, envelope);
    }),
    vscode.commands.registerCommand('jsonlView.showOutput', () => outputChannel?.show(true)),
    vscode.commands.registerCommand('jsonlView.explainLastDiagnostic', () => handleDiagnosticAction('Explain with VS Code Chat', currentDiagnostic())),
    vscode.commands.registerCommand('jsonlView.copyLastDiagnostic', () => vscode.env.clipboard.writeText(formatDiagnosticContext(currentDiagnostic()))),
    vscode.commands.registerCommand('jsonlView.sendLastDiagnosticToSideAgent', async () => {
      const envelope = currentDiagnostic();
      const sideAgentDiagnostic = envelope.stage === 'activation-contribution-conflict'
        ? buildActivationConflictDiagnostic(
          envelope.extension?.id ?? context.extension.id,
          { extensionId: 'unknown', contributionIds: [envelope.stage] },
        )
        : buildSideAgentDiagnostic(envelope);
      await sendDiagnosticToSideAgent(sideAgentDiagnostic, envelope, context);
    }),
    vscode.commands.registerCommand('jsonlView.sessionNavigator.mcpCapability', async () => {
      appendOutputLog(outputChannel, 'mcp-capability', JSON.stringify(MCP_NAVIGATION_CAPABILITY));
      const action = await vscode.window.showInformationMessage(
        'MCP navigation is experimental and disabled by default. No transport, process, network, or source write is enabled.',
        'Open JsonlView Log',
      );
      if (action === 'Open JsonlView Log') outputChannel?.show(true);
    }),
  );
  appendOutputLog(outputChannel, 'activated', 'commands-and-views=registered');
}

export async function deactivate(): Promise<void> {
  const pendingAcpOperations = acpOperationLifetime.close();
  const sessionClose = acpSession?.close();
  acpSession = undefined;
  const [, sessionSettlement] = await Promise.all([pendingAcpOperations, sessionClose]);
  if (sessionSettlement?.outcome === 'unknown') {
    appendOutputLog(outputChannel, 'acp-process-tree', 'outcome=unknown');
  }
  const observabilitySink = activeObservabilitySink;
  activeObservabilitySink = undefined;
  await observabilitySink?.dispose();
  const navigator = activeNavigator;
  activeNavigator = undefined;
  navigator?.dispose();
  await navigator?.previews.dispose();
  appendOutputLog(outputChannel, 'deactivated');
  sideAgentDiagnostics = undefined;
  rustQueryBridge = undefined;
  outputChannel = undefined;
}

function cancellationSignal(token: vscode.CancellationToken): AbortSignal {
  const controller = new AbortController();
  if (token.isCancellationRequested) controller.abort();
  token.onCancellationRequested(() => controller.abort());
  return controller.signal;
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
