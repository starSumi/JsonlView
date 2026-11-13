import * as vscode from 'vscode';
import { join } from 'node:path';
import type { DocumentSummary, Predicate, RecordRef } from '@shared/types';
import type { IntegratedJsonlSession } from '../integrated-session/integrated-session';
import { captureRawExportIntent, isExportOrdinal, rawExportIntentIsCurrent, type RawExportIntent, type RawExportSelection } from './intent';
import { RawExportOperations, type RawExportRecovery } from './operations';
import { exportScopedRawJsonl, ScopedRawExportError } from './scoped-jsonl';
import { observeRawExportSource, rawExportRecoverySummaryMatches, sameRawExportObservation, type RawExportSourceObservation } from './source-observation';

export interface NativeRawExportSource {
  readonly uri: vscode.Uri;
  readonly session: IntegratedJsonlSession;
  isAuthorized(): boolean;
}

/** Existing native pickers only; paths, scope and request IDs are all Host owned. */
export class NativeRawExports {
  private readonly queries = new WeakMap<IntegratedJsonlSession, RawExportIntent>();
  private readonly selections = new WeakMap<IntegratedJsonlSession, RawExportIntent>();
  private readonly active = new Map<IntegratedJsonlSession, Promise<void>>();
  private readonly operations: RawExportOperations;

  public constructor(storagePath: string) { this.operations = new RawExportOperations(join(storagePath, 'raw-export-operations')); }

  public acceptQuery(session: IntegratedJsonlSession, summary: DocumentSummary, predicate: Predicate | undefined): void {
    this.queries.set(session, captureRawExportIntent(summary, predicate === undefined ? { kind: 'matching' } : { kind: 'matching', predicate }));
  }

  public acceptSelection(session: IntegratedJsonlSession, summary: DocumentSummary, ref: RecordRef): void {
    this.selections.set(session, captureRawExportIntent(summary, { kind: 'selected-records', refs: [ref] }));
  }

  public export(source: NativeRawExportSource): Promise<void> {
    const existing = this.active.get(source.session);
    if (existing !== undefined) return existing;
    const operation = this.chooseAndExport(source).catch(() => {
      void vscode.window.showErrorMessage('Scoped raw export could not start. Source and destination files were preserved.');
    }).finally(() => this.active.delete(source.session));
    this.active.set(source.session, operation);
    return operation;
  }

  public async recover(resolveSource: (intent: RawExportIntent) => NativeRawExportSource | undefined): Promise<void> {
    try {
      const ids = await this.operations.list();
      const picked = await vscode.window.showQuickPick(ids.map((requestId) => ({ label: requestId })), {
        title: 'Inspect raw export operation', placeHolder: ids.length === 0 ? 'No retained operations' : 'Inspect one operation before any retry',
      });
      if (picked === undefined) return;
      const result = await this.operations.inspect(picked.label);
      const action = result.status === 'absent' ? 'Retry same publication' : result.status === 'unprepared' ? 'Retry same scan' : undefined;
      const choice = action === undefined ? await vscode.window.showInformationMessage(describe(result))
        : await vscode.window.showInformationMessage(describe(result), action);
      if (choice !== action || action === undefined) return;
      const source = resolveSource(result.intent);
      if (source === undefined || result.sourceObservation === undefined) {
        void vscode.window.showWarningMessage('Open the original source and profile before retrying. Missing durable source evidence permits inspection only.');
        return;
      }
      const authorize = this.recoveryAuthorization(source, result.intent, result.sourceObservation);
      if (!await authorize()) {
        void vscode.window.showWarningMessage('The reopened source, profile or physical file version does not match this operation. Publication was refused.');
        return;
      }
      if (result.status === 'unprepared') await this.run(source, result.intent, result.destinationPath, () => true, authorize, result.sourceObservation);
      else await this.progress(async (signal) => {
        const recovered = await this.operations.retry(result.intent.requestId, authorize, signal);
        void vscode.window.showInformationMessage(describe(recovered));
      });
    } catch { void vscode.window.showErrorMessage('The retained export could not be verified. Its journal and destination were preserved.'); }
  }

  private async chooseAndExport(source: NativeRawExportSource): Promise<void> {
    const summary = source.session.getSummary();
    const selected = this.selections.get(source.session);
    const query = this.queries.get(source.session);
    const choices: { label: string; scope: RawExportSelection['kind'] }[] = [];
    if (selected !== undefined && rawExportIntentIsCurrent(selected, summary)) choices.push({ label: 'Selected record — exact raw physical bytes', scope: 'selected-records' });
    choices.push({ label: 'Physical ordinal range — 0-based, inclusive endpoints', scope: 'ordinal-range' });
    if (query !== undefined && rawExportIntentIsCurrent(query, summary)) choices.push({ label: 'All matches of the last delivered query — raw physical order', scope: 'matching' });
    const picked = await vscode.window.showQuickPick(choices, { title: 'Export raw full records', placeHolder: 'Scope is independent of table sort and visible page; output up to 64 MiB' });
    if (picked === undefined) return;
    let selection: RawExportSelection;
    let isSameIntent = (): boolean => true;
    if (picked.scope === 'ordinal-range') {
      const range = await vscode.window.showInputBox({ title: 'Physical ordinal range (0-based, inclusive)', prompt: 'Enter first:last, for example 0:99',
        validateInput: (value) => parseRange(value) === undefined ? 'Use nonnegative inclusive first:last ordinals.' : undefined });
      if (range === undefined) return;
      selection = parseRange(range)!;
    } else {
      const captured = picked.scope === 'matching' ? query! : selected!;
      selection = captured.selection;
      isSameIntent = () => (picked.scope === 'matching' ? this.queries : this.selections).get(source.session)?.selectionDigest === captured.selectionDigest;
    }
    const intent = captureRawExportIntent(summary, selection);
    const destination = await vscode.window.showSaveDialog({ title: picked.label, saveLabel: 'Export New Raw Copy',
      defaultUri: vscode.Uri.file(source.uri.fsPath.replace(/\.(jsonl|ndjson)$/iu, '.selection.$1')),
      filters: { 'JSONL / NDJSON': ['jsonl', 'ndjson'] } });
    if (destination === undefined) return;
    if (destination.scheme !== 'file' || !isSameIntent() || !await this.authorize(source, intent)) {
      void vscode.window.showWarningMessage('The captured export intent changed or its local source grant is unavailable. Start the action again.');
      return;
    }
    await this.run(source, intent, destination.fsPath, isSameIntent);
  }

  private async run(source: NativeRawExportSource, intent: RawExportIntent, destinationPath: string, isSameIntent = (): boolean => true,
    authorize = (): Promise<boolean> => this.authorize(source, intent), sourceObservation?: RawExportSourceObservation): Promise<void> {
    try {
      const matches = intent.selection.kind === 'matching' && intent.selection.predicate !== undefined
        ? source.session.captureRawExportMatcher(intent.selection.predicate) : undefined;
      await this.progress(async (signal) => {
        const result = await exportScopedRawJsonl({ sourcePath: source.uri.fsPath, intent, destinationPath, signal,
          authorize: async () => isSameIntent() && await authorize() && isSameIntent(),
          ...(sourceObservation === undefined ? {} : { sourceObservation }),
          ...(matches === undefined ? {} : { matches }) }, this.operations);
        void vscode.window.showInformationMessage(describe(result));
      });
    } catch (error) {
      void vscode.window.showWarningMessage(error instanceof ScopedRawExportError ? error.message : 'Raw export could not settle. Inspect its retained operation before retrying.');
    }
  }

  private recoveryAuthorization(source: NativeRawExportSource, original: RawExportIntent, observation: RawExportSourceObservation): () => Promise<boolean> {
    // This fresh identity is only the current grant. The operation ID, original
    // selection and digest remain unchanged across a real application restart.
    const currentGrant = captureRawExportIntent(source.session.getSummary(), { kind: 'matching' });
    return async () => {
      if (!rawExportRecoverySummaryMatches(original, source.session.getSummary()) || !await this.authorize(source, currentGrant)) return false;
      let same = false;
      try { same = sameRawExportObservation(observation, await observeRawExportSource(source.uri.fsPath, original)); } catch { return false; }
      return same && rawExportRecoverySummaryMatches(original, source.session.getSummary()) && await this.authorize(source, currentGrant);
    };
  }

  private async authorize(source: NativeRawExportSource, intent: RawExportIntent): Promise<boolean> {
    const current = (): boolean => source.isAuthorized() && source.uri.scheme === 'file'
      && rawExportIntentIsCurrent(intent, source.session.getSummary());
    return current() && await source.session.validateObservedSource() && current();
  }

  private async progress(action: (signal: AbortSignal) => Promise<void>): Promise<void> {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Exporting raw full records (bounded scan, up to 64 MiB)', cancellable: true }, async (_progress, token) => {
      const cancellation = new AbortController();
      const subscription = token.onCancellationRequested(() => cancellation.abort());
      const deadline = setTimeout(() => cancellation.abort(), 30_000);
      if (token.isCancellationRequested) cancellation.abort();
      try { await action(cancellation.signal); } finally { clearTimeout(deadline); subscription.dispose(); }
    });
  }
}

function parseRange(value: string): Extract<RawExportSelection, { kind: 'ordinal-range' }> | undefined {
  const parts = value.trim().split(':');
  return parts.length === 2 && isExportOrdinal(parts[0]) && isExportOrdinal(parts[1]) && BigInt(parts[0]) <= BigInt(parts[1])
    ? { kind: 'ordinal-range', first: parts[0], last: parts[1] } : undefined;
}

function describe(result: RawExportRecovery): string {
  const status = result.status === 'committed' ? 'committed and verified'
    : result.status === 'absent' ? 'target absent; prepared bytes retained'
      : result.status === 'unprepared' ? 'publication not prepared' : 'publication unknown; inspect the preserved destination';
  return 'Raw export ' + result.intent.requestId + ': ' + status + '.';
}
