import type { RowSort } from '../shared/types';
import {
  rowsOptionsAfterEmptyRebuild,
  rowsOptionsAfterOpened,
  rowsOptionsAfterOpenedRequest,
  rowsOptionsAfterRebuild,
  rowsOptionsForViewport,
  type RebuildRowsOptions,
} from './paging';
import { snapshotIdentityChanged, type AcceptedSnapshotIdentity } from './snapshot-identity';

export interface RecoveryRowsOptions extends Readonly<RebuildRowsOptions> {
  readonly sort?: RowSort;
}

export interface QueryViewport extends AcceptedSnapshotIdentity {
  readonly query: string;
  readonly firstVisibleOrdinal?: string;
}

export interface PendingViewportIntent extends AcceptedSnapshotIdentity {
  readonly requestId: string;
  readonly query: string;
  readonly options: RecoveryRowsOptions;
  readonly preserveOnRebuild: boolean;
  readonly restoreAfterRebuild: boolean;
}

export interface RebuildViewportCapture extends AcceptedSnapshotIdentity {
  readonly query: string;
  readonly viewportQuery: string;
  readonly firstVisibleOrdinal?: string;
  readonly pageText: string;
  readonly options: RecoveryRowsOptions;
}

export interface RebuildViewportIntent extends RebuildViewportCapture {
  readonly requestId: string;
}

export type RestoreViewportPhase = 'initial' | 'waiting-index' | 'retrying';

export interface RestoreViewportIntent extends AcceptedSnapshotIdentity {
  readonly query: string;
  readonly requestId: string;
  readonly firstVisibleOrdinal?: string;
  readonly pageText: string;
  readonly phase: RestoreViewportPhase;
  readonly requestedOptions?: RecoveryRowsOptions;
}

function copyOptions(options: RecoveryRowsOptions): RecoveryRowsOptions {
  return {
    ...options,
    ...(options.sort === undefined ? {} : { sort: { ...options.sort } }),
  };
}

/** Capture before cancellation; a pending explicit page-one intent remains {}. */
export function captureRebuild(input: {
  readonly session: AcceptedSnapshotIdentity;
  readonly query: string;
  readonly followMode: boolean;
  readonly pageText: string;
  readonly pageSize: number;
  readonly renderedFirstOrdinal?: string | undefined;
  readonly viewport?: QueryViewport | undefined;
  readonly pending?: PendingViewportIntent | undefined;
}): RebuildViewportCapture {
  const saved = input.viewport;
  const savedBelongsToSession = saved !== undefined
    && !snapshotIdentityChanged(saved, input.session);
  const viewportQuery = savedBelongsToSession ? saved.query : input.query;
  const queryMatchesViewport = viewportQuery === input.query;
  const pending = input.pending;
  const pendingMatchesSession = pending !== undefined
    && !snapshotIdentityChanged(pending, input.session)
    && pending.query === input.query
    && pending.preserveOnRebuild;
  const firstVisibleOrdinal = queryMatchesViewport
    ? savedBelongsToSession ? saved.firstVisibleOrdinal : input.renderedFirstOrdinal
    : undefined;
  const pageText = queryMatchesViewport ? input.pageText : '1';
  return {
    ...input.session,
    query: input.query,
    viewportQuery,
    ...(firstVisibleOrdinal === undefined ? {} : { firstVisibleOrdinal }),
    pageText,
    options: copyOptions(rowsOptionsForViewport(
      firstVisibleOrdinal,
      pageText,
      input.pageSize,
      input.followMode,
      pendingMatchesSession ? pending.options : undefined,
    )),
  };
}

export type OpenedRecoveryDecision =
  | { readonly kind: 'none' }
  | {
    readonly kind: 'restore';
    readonly options: RecoveryRowsOptions;
    readonly query?: string;
    readonly replacesSnapshot: boolean;
    readonly restore?: RestoreViewportIntent;
  };

/** App supplies accepted snapshot flags; the policy never admits a wire message. */
export function planOpened(input: {
  readonly opened: AcceptedSnapshotIdentity;
  readonly firstOpenedSession: boolean;
  readonly snapshotChanged: boolean;
  readonly query: string;
  readonly followMode: boolean;
  readonly pageText: string;
  readonly viewport?: QueryViewport | undefined;
  readonly pending?: PendingViewportIntent | undefined;
  readonly rebuild?: RebuildViewportIntent | undefined;
}): OpenedRecoveryDecision {
  if (!input.snapshotChanged) return { kind: 'none' };
  const saved = input.viewport;
  const pending = input.pending;
  const rebuild = input.rebuild;
  const prior = saved ?? pending ?? rebuild;
  const replacesSnapshot = !input.firstOpenedSession
    && prior !== undefined
    && prior.documentId === input.opened.documentId
    && snapshotIdentityChanged(prior, input.opened);
  const pendingRebuild = replacesSnapshot && pending !== undefined
    && pending.preserveOnRebuild
    && pending.documentId === input.opened.documentId
    && snapshotIdentityChanged(pending, input.opened)
    ? pending : undefined;
  const manualRebuild = replacesSnapshot && rebuild !== undefined
    && rebuild.documentId === input.opened.documentId
    && snapshotIdentityChanged(rebuild, input.opened)
    ? rebuild : undefined;
  const viewportQuery = pendingRebuild?.query ?? manualRebuild?.viewportQuery ?? saved?.query;
  const queryMatchesViewport = viewportQuery === undefined || viewportQuery === input.query;
  const resumeRows = replacesSnapshot && !input.followMode
    ? queryMatchesViewport
      ? pendingRebuild?.options ?? manualRebuild?.options
        ?? rowsOptionsAfterRebuild(saved?.firstVisibleOrdinal, false)
      : {}
    : undefined;
  const candidateQuery = pendingRebuild?.query ?? manualRebuild?.query ?? saved?.query;
  const query = replacesSnapshot && candidateQuery === input.query ? candidateQuery : undefined;
  const openedRows = rowsOptionsAfterOpened(
    input.firstOpenedSession ? undefined : prior,
    input.opened,
    input.followMode,
  ) ?? rowsOptionsAfterRebuild(prior === undefined ? undefined : saved?.firstVisibleOrdinal, input.followMode);
  const firstVisibleOrdinal = manualRebuild?.firstVisibleOrdinal
    ?? (queryMatchesViewport ? saved?.firstVisibleOrdinal : undefined);
  const pageText = manualRebuild?.pageText ?? (queryMatchesViewport ? input.pageText : '1');
  return {
    kind: 'restore',
    options: copyOptions(rowsOptionsAfterOpenedRequest(openedRows, resumeRows, input.followMode)),
    ...(query === undefined ? {} : { query }),
    replacesSnapshot,
    ...(replacesSnapshot && !input.followMode ? {
      restore: {
        ...input.opened,
        query: query ?? input.query,
        ...(firstVisibleOrdinal === undefined ? {} : { firstVisibleOrdinal }),
        pageText,
        requestId: '',
        phase: 'initial' as const,
      },
    } : {}),
  };
}

export type EmptyRestoreDecision =
  | { readonly kind: 'wait-index'; readonly restore: RestoreViewportIntent }
  | { readonly kind: 'retry'; readonly options: RecoveryRowsOptions; readonly restore: RestoreViewportIntent }
  | { readonly kind: 'stop' };

/** A completed empty restore permits at most one distinct clamped request. */
export function planEmptyRestore(input: {
  readonly restore: RestoreViewportIntent;
  readonly session: AcceptedSnapshotIdentity;
  readonly query: string;
  readonly followMode: boolean;
  readonly invalidated: boolean;
  readonly pageSize: number;
  readonly indexingComplete: boolean;
  readonly totalRecords?: string | undefined;
  readonly requestedOptions?: RecoveryRowsOptions | undefined;
  readonly matchedRecords?: string | undefined;
  readonly scanTruncated?: boolean;
}): EmptyRestoreDecision {
  const restore = input.restore;
  const requested = input.requestedOptions ?? restore.requestedOptions;
  if (input.invalidated || input.followMode || restore.query !== input.query
    || snapshotIdentityChanged(restore, input.session) || restore.phase === 'retrying') {
    return { kind: 'stop' };
  }
  // Partial index progress is not a source-size or matched-count authority.
  if (!input.indexingComplete && input.totalRecords === undefined) {
    return { kind: 'wait-index', restore: { ...restore, phase: 'waiting-index',
      ...(requested === undefined ? {} : { requestedOptions: copyOptions(requested) }) } };
  }
  const fallback = rowsOptionsAfterEmptyRebuild(
    restore.firstVisibleOrdinal,
    restore.pageText,
    input.pageSize,
    input.totalRecords,
    restore.query,
    requested?.sortOffset,
    input.matchedRecords,
    input.scanTruncated,
  );
  if (fallback === undefined) {
    return input.totalRecords === undefined && !input.indexingComplete
      ? { kind: 'wait-index', restore: { ...restore, phase: 'waiting-index' } }
      : { kind: 'stop' };
  }
  if (input.totalRecords === '0' || (requested !== undefined
    && requested.anchorOrdinal === fallback.anchorOrdinal
    && requested.direction === fallback.direction
    && requested.sortOffset === fallback.sortOffset)) {
    return { kind: 'stop' };
  }
  return {
    kind: 'retry',
    options: copyOptions(fallback),
    restore: { ...restore, phase: 'retrying' },
  };
}
