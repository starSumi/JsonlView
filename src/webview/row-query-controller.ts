import type { ColumnSpec, ExtensionMessage, RowFilter, RowPage, RowProjection, RowSort, SortDirection } from '../shared/types';
import { buildRecordQueryRequest, canRequestSortedPage, selectedRecordColumns } from './features/record-query/model';
import {
  advanceSortPage, anchorForPage, normalizeSortOffset, normalizeSortOffsetHistory, normalizeSortPage,
  pageFromOrdinal, pageFromSortOffset, previousSortPage, rowsOptionsAfterRebuild, rowsOptionsForViewport,
} from './paging';
import type { PendingRequest, ProtocolSession, VsCodeMessageClient } from './protocol-client';
import {
  captureRebuild, planEmptyRestore, planOpened,
  type PendingViewportIntent, type QueryViewport, type RebuildViewportIntent,
  type RecoveryRowsOptions, type RestoreViewportIntent, type RestoreViewportPhase,
} from './row-query-recovery-policy';
import { snapshotIdentityChanged } from './snapshot-identity';
import { canReadSnapshot, reconcileProfileQueryState, type WorkspaceAction, type WorkspaceState } from './state';

export interface RowsRequestOptions extends RecoveryRowsOptions {
  readonly query?: string;
  readonly filterColumns?: readonly ColumnSpec[];
  readonly columns?: readonly ColumnSpec[];
}

export interface RowsRequestMetadata {
  readonly preserveOnRebuild?: boolean;
  readonly restoreAfterRebuild?: boolean;
  readonly restorePhase?: RestoreViewportPhase;
  readonly supersedesRestore?: boolean;
  readonly allowWhileInvalidated?: boolean;
  readonly pageInputSubmission?: boolean;
}

export interface RowQueryContext {
  readonly workspace: Readonly<WorkspaceState>;
  readonly session: Readonly<ProtocolSession>;
  readonly invalidationReason: WorkspaceState['invalidationReason'];
  readonly indexingComplete: boolean;
  readonly followMode: boolean;
}

export interface RowQueryControllerPorts {
  readonly client: Pick<VsCodeMessageClient, 'send' | 'cancel' | 'hasPending'>;
  readonly getContext: () => RowQueryContext;
  readonly dispatch: (action: WorkspaceAction) => void;
  readonly cancelReadRequests: () => void;
  readonly onPageInputChange: (value: string) => void;
  readonly fallbackColumns: (rows: RowProjection[]) => readonly ColumnSpec[];
}

export interface AcceptedSnapshotFlags {
  readonly firstOpenedSession: boolean;
  readonly openedGenerationChanged: boolean;
}

interface PageNavigation {
  readonly firstOrdinal?: string | undefined;
  readonly lastOrdinal?: string | undefined;
  readonly anchorOrdinal?: string | undefined;
  readonly sortNextOffset?: string | undefined;
  readonly scan?: RowPage['scan'] | undefined;
}

const NO_FOLLOW_UP = (): void => undefined;

/** Synchronous UI intent only. The client remains the sole wire/session authority. */
export class RowQueryController {
  readonly #ports: RowQueryControllerPorts;
  readonly #pageSize: number;
  #query: string;
  #filter: RowFilter | undefined;
  #sort: RowSort | undefined;
  #sortDirection: SortDirection;
  #sortOffset: string;
  #sortOffsetHistory: string[];
  #sortPage: string;
  #columns: readonly ColumnSpec[];
  #pageInput = '1';
  #pageInputDirty = false;
  #pageInputFocused = false;
  #pageInputRequestId: string | undefined;
  #viewport: QueryViewport | undefined;
  #pendingViewport: PendingViewportIntent | undefined;
  #rebuildViewport: RebuildViewportIntent | undefined;
  #restoreViewport: RestoreViewportIntent | undefined;
  #navigation: PageNavigation | undefined;

  public constructor(ports: RowQueryControllerPorts, initial: Readonly<WorkspaceState>, pageSize: number) {
    this.#ports = ports;
    this.#pageSize = pageSize;
    this.#query = initial.query;
    this.#filter = initial.filter;
    this.#sort = initial.sort;
    this.#sortDirection = initial.sortDirection;
    this.#sortOffset = initial.sort === undefined ? '0' : normalizeSortOffset(initial.sortOffset);
    this.#sortOffsetHistory = initial.sort === undefined ? []
      : normalizeSortOffsetHistory(initial.sortOffsetHistory, this.#sortOffset);
    this.#sortPage = initial.sort === undefined ? '1'
      : normalizeSortPage(initial.sortPage, this.#sortOffset, pageSize);
    this.#columns = initial.columns;
  }

  public get query(): string { return this.#query; }
  public get sort(): RowSort | undefined { return this.#sort; }
  public get sortDirection(): SortDirection { return this.#sortDirection; }
  public get sortOffset(): string { return this.#sortOffset; }
  public get sortPage(): string { return this.#sortPage; }
  public get sortOffsetHistory(): readonly string[] { return [...this.#sortOffsetHistory]; }
  public get pageInput(): string { return this.#pageInput; }
  public get pageInputDirty(): boolean { return this.#pageInputDirty; }

  #setPageInput(value: string): void {
    this.#pageInput = value;
    this.#ports.onPageInputChange(value);
  }

  #releaseSubmission(): void {
    if (this.#pageInputRequestId === undefined) return;
    this.#pageInputRequestId = undefined;
    this.#pageInputDirty = false;
  }

  #resetPaging(): void {
    this.#sortOffset = '0';
    this.#sortOffsetHistory = [];
    this.#sortPage = '1';
  }

  #setSortPosition(position: { offset: string; history: string[]; page: string }): void {
    this.#sortOffset = position.offset;
    this.#sortOffsetHistory = position.history;
    this.#sortPage = position.page;
    this.#ports.dispatch({ type: 'SET_SORT_OFFSET', ...position });
  }

  public abandonRestore(): void { this.#restoreViewport = undefined; }

  public currentViewportOptions(): RecoveryRowsOptions {
    if (this.#sort !== undefined) return { sortOffset: this.#sortOffset };
    return rowsOptionsAfterRebuild(
      this.#viewport?.query === this.#query ? this.#viewport.firstVisibleOrdinal : undefined,
      this.#ports.getContext().followMode,
    );
  }

  public requestRows(options?: RowsRequestOptions, metadata: RowsRequestMetadata = {}): PendingRequest | undefined {
    const context = this.#ports.getContext();
    if (!canReadSnapshot(context.invalidationReason) && metadata.allowWhileInvalidated !== true) return undefined;
    if (metadata.restoreAfterRebuild !== true && metadata.supersedesRestore !== false) this.abandonRestore();
    this.#releaseSubmission();
    for (const requestId of this.#ports.client.cancel('rows')) {
      this.#ports.dispatch({ type: 'REQUEST_FINISHED', kind: 'rows', requestId });
    }
    const query = options?.query ?? this.#query;
    const sort = context.indexingComplete ? options?.sort ?? this.#sort : undefined;
    const sortOffset = sort === undefined ? undefined : options?.sortOffset ?? this.#sortOffset;
    const state = context.workspace;
    const filterColumns = options?.filterColumns
      ?? (this.#columns.length > 0 ? this.#columns : this.#ports.fallbackColumns(state.rows));
    const columns = options?.columns ?? (state.summary?.snapshot.generation === context.session.generation
      ? selectedRecordColumns(this.#columns, state.schema, state.columnVisibility) : undefined);
    const request = this.#ports.client.send('GET_ROWS', buildRecordQueryRequest({
      limit: this.#pageSize, query, filterColumns,
      ...(columns === undefined ? {} : { columns }),
      ...(this.#filter === undefined ? {} : { filter: this.#filter }),
      ...(options?.anchorOrdinal === undefined ? {} : { anchorOrdinal: options.anchorOrdinal }),
      ...(options?.direction === undefined ? {} : { direction: options.direction }),
      ...(sort === undefined ? {} : { sort }),
      ...(sortOffset === undefined ? {} : { sortOffset }),
    }));
    if (metadata.pageInputSubmission === true) this.#pageInputRequestId = request.id;
    if (metadata.restoreAfterRebuild === true && this.#restoreViewport !== undefined) {
      this.#restoreViewport = { ...this.#restoreViewport, requestId: request.id,
        phase: metadata.restorePhase ?? 'initial' };
    }
    this.#pendingViewport = {
      ...context.session, requestId: request.id, query,
      preserveOnRebuild: metadata.preserveOnRebuild ?? options !== undefined,
      restoreAfterRebuild: metadata.restoreAfterRebuild === true,
      options: {
        ...(options?.anchorOrdinal === undefined ? {} : { anchorOrdinal: options.anchorOrdinal }),
        ...(options?.direction === undefined ? {} : { direction: options.direction }),
        ...(sort === undefined ? {} : { sort: { ...sort },
          ...(sortOffset === undefined ? {} : { sortOffset }) }),
      },
    };
    this.#ports.dispatch({ type: 'REQUEST_SENT', request });
    return request;
  }

  public revealOrdinal(ordinal: string): void {
    if (!/^[0-9]+$/u.test(ordinal)) return;
    const context = this.#ports.getContext();
    if (!canReadSnapshot(context.invalidationReason)) return;
    this.abandonRestore();
    this.#ports.dispatch({ type: 'SELECT_ROW', ordinal });
    this.requestRows({ anchorOrdinal: ordinal, direction: 'forward' }, { supersedesRestore: true });
  }

  public rebuild(): void {
    const context = this.#ports.getContext();
    const captured = captureRebuild({
      session: context.session, query: this.#query, followMode: context.followMode,
      pageText: this.#pageInput, pageSize: this.#pageSize,
      renderedFirstOrdinal: context.workspace.rows[0]?.ref.ordinal,
      viewport: this.#viewport, pending: this.#pendingViewport,
    });
    this.abandonRestore();
    this.#releaseSubmission();
    this.#ports.cancelReadRequests();
    this.#pendingViewport = undefined;
    const request = this.#ports.client.send('REBUILD_INDEX', {});
    this.#rebuildViewport = { ...captured, requestId: request.id };
    this.#ports.dispatch({ type: 'REQUEST_SENT', request });
  }

  public editQuery(query: string): void {
    this.#query = query;
    this.#resetPaging();
    this.#releaseSubmission();
    if (this.#restoreViewport?.query !== query) this.abandonRestore();
    this.#ports.dispatch({ type: 'SET_QUERY', query });
  }

  public applyFilter(filter: RowFilter | undefined): void {
    this.#filter = filter;
    this.#resetPaging();
    this.#ports.dispatch({ type: 'SET_FILTER', filter });
    this.requestRows({ sortOffset: '0' });
  }

  public changeSort(sort: RowSort | undefined): void {
    this.#sort = sort;
    this.#resetPaging();
    this.#ports.dispatch({ type: 'SET_SORT', sort });
    this.requestRows({ sortOffset: '0' });
  }

  public requestRowOrder(direction: SortDirection): void {
    const context = this.#ports.getContext();
    if (!context.indexingComplete || context.invalidationReason !== undefined
      || this.#ports.client.hasPending('rebuild') || this.#ports.client.hasPending('order')) return;
    if (direction === this.#sortDirection && (direction === 'asc' ? this.#sort === undefined
      : this.#sort?.columnId === '__ordinal' && this.#sort.direction === 'desc')) return;
    const request = this.#ports.client.send('SET_ROW_ORDER', { direction });
    this.#ports.dispatch({ type: 'REQUEST_SENT', request });
  }

  public requestFollowRows(): void {
    this.abandonRestore();
    if (this.#sort?.columnId === '__ordinal' && this.#sort.direction === 'desc') {
      this.#setSortPosition({ offset: '0', history: [], page: '1' });
      this.requestRows({ sortOffset: '0' });
    } else this.requestRows({ direction: 'backward' });
  }

  public nextPage(): void {
    const state = this.#ports.getContext().workspace;
    if (!canReadSnapshot(this.#ports.getContext().invalidationReason)) return;
    const navigation = this.#navigation;
    if (this.#sort !== undefined) {
      const currentOffset = normalizeSortOffset(this.#sortOffset);
      const offset = BigInt(currentOffset);
      const continuation = navigation?.sortNextOffset ?? state.page?.sortNextOffset;
      let nextOffset: bigint;
      try { nextOffset = continuation === undefined ? offset + BigInt(this.#pageSize) : BigInt(continuation); }
      catch { nextOffset = offset + BigInt(this.#pageSize); }
      if (nextOffset <= offset || !canRequestSortedPage(this.#sort, nextOffset, this.#pageSize)) return;
      const position = advanceSortPage(this.#sortOffsetHistory, currentOffset, this.#sortPage,
        nextOffset.toString(), this.#pageSize);
      this.#setSortPosition(position);
      this.#setPageInput(position.page);
      this.requestRows({ sortOffset: position.offset });
      return;
    }
    const scan = navigation?.scan ?? state.page?.scan;
    const scanCursor = scan?.truncatedReason && scan.direction === 'forward' ? scan.cursorOrdinal : undefined;
    const anchorOrdinal = scanCursor ?? navigation?.lastOrdinal ?? state.rows.at(-1)?.ref.ordinal
      ?? navigation?.anchorOrdinal ?? state.page?.anchorOrdinal;
    if (anchorOrdinal) this.requestRows({ anchorOrdinal, direction: 'forward' });
  }

  public previousPage(): void {
    const context = this.#ports.getContext();
    if (!canReadSnapshot(context.invalidationReason)) return;
    if (this.#sort !== undefined) {
      const position = previousSortPage(this.#sortOffsetHistory, this.#sortOffset, this.#sortPage, this.#pageSize);
      this.#setSortPosition(position);
      this.#setPageInput(position.page);
      this.requestRows({ sortOffset: position.offset });
      return;
    }
    const state = context.workspace;
    const navigation = this.#navigation;
    const scan = navigation?.scan ?? state.page?.scan;
    const scanCursor = scan?.truncatedReason && scan.direction === 'backward' ? scan.cursorOrdinal : undefined;
    const anchorOrdinal = scanCursor ?? navigation?.firstOrdinal ?? state.rows[0]?.ref.ordinal
      ?? navigation?.anchorOrdinal ?? state.page?.anchorOrdinal;
    if (anchorOrdinal) this.requestRows({ anchorOrdinal, direction: 'backward' });
  }

  public focusPageInput(focused: boolean): void { this.#pageInputFocused = focused; }

  public releasePageInputFocus(): void { this.#pageInputFocused = false; }

  public editPageInput(value: string): void {
    const submitted = this.#pageInputRequestId;
    this.#pageInputRequestId = undefined;
    if (submitted !== undefined && this.#pendingViewport?.requestId === submitted) this.#pendingViewport = undefined;
    this.#rebuildViewport = undefined;
    this.abandonRestore();
    this.#pageInputDirty = true;
    this.#setPageInput(value);
  }

  public submitPageInput(): void {
    const context = this.#ports.getContext();
    if (!canReadSnapshot(context.invalidationReason) || !this.#pageInputDirty) return;
    const value = this.#pageInput.trim();
    if (this.#sort !== undefined) {
      let page: bigint;
      try { page = BigInt(value); } catch { page = 0n; }
      const offset = page > 0n ? (page - 1n) * BigInt(this.#pageSize) : -1n;
      if (page < 1n || offset < 0n || !canRequestSortedPage(this.#sort, offset, this.#pageSize)) {
        this.#pageInputDirty = false;
        this.#setPageInput(this.#sortPage);
        return;
      }
      this.#setSortPosition({ offset: offset.toString(), history: [], page: page.toString() });
      this.requestRows({ sortOffset: offset.toString() }, { pageInputSubmission: true });
      return;
    }
    const anchorOrdinal = anchorForPage(value, this.#pageSize);
    if (anchorOrdinal === undefined && value !== '1') {
      this.#pageInputDirty = false;
      this.#pageInputRequestId = undefined;
      this.#setPageInput(pageFromOrdinal(this.#navigation?.firstOrdinal ?? context.workspace.rows[0]?.ref.ordinal,
        this.#pageSize));
      return;
    }
    this.requestRows(anchorOrdinal === undefined ? {} : { anchorOrdinal, direction: 'forward' },
      { pageInputSubmission: true });
  }

  #finishEmptyRestore(restore: RestoreViewportIntent, totalRecords: string | undefined,
    requestedOptions: RecoveryRowsOptions | undefined, matchedRecords?: string, scanTruncated = false): void {
    if (this.#restoreViewport !== restore) return;
    const context = this.#ports.getContext();
    const decision = planEmptyRestore({
      restore, session: context.session, query: this.#query, followMode: context.followMode,
      invalidated: context.invalidationReason !== undefined, indexingComplete: context.indexingComplete,
      pageSize: this.#pageSize, totalRecords, requestedOptions, matchedRecords, scanTruncated,
    });
    this.#restoreViewport = decision.kind === 'stop' ? undefined : decision.restore;
    if (decision.kind !== 'retry') return;
    this.requestRows({ ...decision.options, ...(restore.query.trim() ? { query: restore.query } : {}) }, {
      preserveOnRebuild: true, restoreAfterRebuild: true, restorePhase: 'retrying', supersedesRestore: false,
    });
  }

  #receiveRows(message: Extract<ExtensionMessage, { type: 'ROWS' }>): () => void {
    const context = this.#ports.getContext();
    if (!canReadSnapshot(context.invalidationReason)) return NO_FOLLOW_UP;
    const pending = this.#pendingViewport?.requestId === message.requestId ? this.#pendingViewport : undefined;
    const restore = pending?.restoreAfterRebuild && this.#restoreViewport?.requestId === message.requestId
      && !snapshotIdentityChanged(this.#restoreViewport, context.session) ? this.#restoreViewport : undefined;
    const responseQuery = pending?.query ?? this.#query;
    this.#columns = message.payload.columns;
    this.#navigation = { firstOrdinal: message.payload.rows[0]?.ref.ordinal,
      lastOrdinal: message.payload.rows.at(-1)?.ref.ordinal, anchorOrdinal: message.payload.anchorOrdinal,
      sortNextOffset: message.payload.sortNextOffset, scan: message.payload.scan };
    if (message.payload.sortOffset !== undefined && responseQuery === this.#query) {
      const offset = normalizeSortOffset(message.payload.sortOffset);
      if (offset !== this.#sortOffset) {
        this.#setSortPosition({ offset, history: [], page: pageFromSortOffset(offset, this.#pageSize) });
      } else this.#sortOffset = offset;
    }
    const sameViewport = this.#viewport !== undefined
      && !snapshotIdentityChanged(this.#viewport, context.session) && this.#viewport.query === responseQuery;
    const firstVisibleOrdinal = message.payload.rows[0]?.ref.ordinal
      ?? (sameViewport ? this.#viewport?.firstVisibleOrdinal : undefined);
    this.#viewport = { ...context.session, query: responseQuery,
      ...(firstVisibleOrdinal === undefined ? {} : { firstVisibleOrdinal }) };
    if (pending !== undefined) {
      if (this.#pageInputRequestId === message.requestId) this.#releaseSubmission();
      this.#pendingViewport = undefined;
    }
    if (message.payload.rows.length > 0 && responseQuery === this.#query
      && !this.#pageInputDirty && !this.#pageInputFocused) {
      this.#setPageInput(this.#sort === undefined
        ? pageFromOrdinal(message.payload.rows[0]?.ref.ordinal, this.#pageSize) : this.#sortPage);
    }
    if (restore === undefined) return NO_FOLLOW_UP;
    if (message.payload.rows.length > 0) { this.abandonRestore(); return NO_FOLLOW_UP; }
    return () => this.#finishEmptyRestore(restore, message.payload.totalRecords, pending?.options,
      message.payload.matchedRecords, message.payload.scan?.truncatedReason !== undefined);
  }

  /** Call after App barriers; run the result after exactly one MESSAGE_RECEIVED. */
  public handleAcceptedMessage(message: ExtensionMessage, flags: AcceptedSnapshotFlags): () => void {
    const context = this.#ports.getContext();
    if (message.type === 'SOURCE_INVALIDATED') {
      if (context.invalidationReason !== 'append') {
        this.#pageInputFocused = false;
        this.#releaseSubmission();
        this.abandonRestore();
        this.#pendingViewport = undefined;
        this.#rebuildViewport = undefined;
      }
      return NO_FOLLOW_UP;
    }
    if (message.type === 'ROWS') return this.#receiveRows(message);
    if (message.type === 'OPENED') {
      const decision = planOpened({
        opened: message.payload.snapshot, firstOpenedSession: flags.firstOpenedSession,
        snapshotChanged: flags.openedGenerationChanged, query: this.#query, followMode: context.followMode,
        pageText: this.#pageInput, viewport: this.#viewport, pending: this.#pendingViewport, rebuild: this.#rebuildViewport,
      });
      if (decision.kind === 'none') return NO_FOLLOW_UP;
      if (this.#sort === undefined || this.#sort.columnId === '__ordinal') {
        const sort: RowSort | undefined = this.#sortDirection === 'desc' && context.indexingComplete
          ? { columnId: '__ordinal', direction: 'desc' } : undefined;
        if (this.#sort?.direction !== sort?.direction) {
          this.#sort = sort;
          this.#resetPaging();
          this.#ports.dispatch({ type: 'SET_SORT', sort });
        }
      }
      this.#releaseSubmission();
      this.#restoreViewport = decision.restore;
      this.#viewport = undefined;
      this.#pendingViewport = undefined;
      this.#rebuildViewport = undefined;
      this.#navigation = undefined;
      return () => this.requestRows({ ...decision.options, ...(decision.query === undefined ? {} : { query: decision.query }) },
        decision.replacesSnapshot ? { preserveOnRebuild: true, restoreAfterRebuild: !context.followMode,
          restorePhase: 'initial', supersedesRestore: false, allowWhileInvalidated: true }
          : { allowWhileInvalidated: true });
    }
    if (message.type === 'PROFILE_CHANGED' && context.invalidationReason === undefined) {
      const profile = reconcileProfileQueryState(this.#sort, this.#filter, this.#columns, message.payload.columns);
      const restore = this.#restoreViewport;
      const pendingRestore = this.#pendingViewport?.restoreAfterRebuild === true && restore !== undefined;
      this.#sort = profile.sort;
      this.#filter = profile.filter;
      this.#resetPaging();
      this.#columns = message.payload.columns;
      // An unsolicited profile projection does not supersede a recovery that
      // is waiting for indexing. Explicit App setProfile already abandons it.
      if (restore !== undefined && !pendingRestore) return NO_FOLLOW_UP;
      const refresh = pendingRestore && !context.followMode
        ? rowsOptionsForViewport(restore.firstVisibleOrdinal, restore.pageText, this.#pageSize, false)
        : rowsOptionsAfterRebuild(this.#viewport?.firstVisibleOrdinal, context.followMode);
      return () => this.requestRows({ ...refresh, ...(this.#query.trim() ? { query: this.#query } : {}),
        filterColumns: message.payload.columns, ...(profile.sort === undefined ? {} : { sortOffset: '0' }) },
      pendingRestore ? { preserveOnRebuild: true, restoreAfterRebuild: true,
        restorePhase: restore.phase === 'retrying' ? 'retrying' : 'initial', supersedesRestore: false }
        : { preserveOnRebuild: true });
    }
    if (message.type === 'INDEX_PROGRESS') {
      const restore = this.#restoreViewport;
      const waiting = restore !== undefined && restore.phase === 'waiting-index'
        && restore.documentId === message.documentId && restore.generation === message.generation
        && message.payload.indexingComplete;
      return () => {
        if (waiting) this.#finishEmptyRestore(restore, message.payload.indexedRecords, undefined);
        if (message.payload.indexingComplete && this.#sortDirection === 'desc' && this.#sort === undefined
          && this.#ports.getContext().invalidationReason === undefined) {
          this.changeSort({ columnId: '__ordinal', direction: 'desc' });
        }
      };
    }
    if (message.type === 'ROW_ORDER_CHANGED') {
      this.#sortDirection = message.payload.direction;
      this.#sort = message.payload.direction === 'desc' ? { columnId: '__ordinal', direction: 'desc' } : undefined;
      this.#resetPaging();
      return () => {
        this.#ports.dispatch({ type: 'SET_SORT_DIRECTION', direction: message.payload.direction });
        this.#ports.dispatch({ type: 'SET_SORT', sort: this.#sort });
        this.requestRows({ sortOffset: '0' });
      };
    }
    if (message.type === 'ERROR') {
      if (this.#pendingViewport?.requestId === message.requestId) {
        if (this.#pendingViewport.restoreAfterRebuild) this.abandonRestore();
        this.#pendingViewport = undefined;
      }
      if (this.#pageInputRequestId === message.requestId) this.#releaseSubmission();
      if (this.#rebuildViewport?.requestId === message.requestId) this.#rebuildViewport = undefined;
    }
    return NO_FOLLOW_UP;
  }
}
