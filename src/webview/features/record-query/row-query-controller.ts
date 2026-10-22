import type { ColumnSpec, ExtensionMessage, RecordRef, RowFilter, RowPage, RowProjection, RowProjectionPlan, RowScanBudget, RowSort, SortDirection } from '@shared/types';
import { buildRecordQueryRequest, canRequestSortedPage, columnsAfterProfileChange, createFilterScanBudget, isPhysicalOrdinalSort, selectedRecordColumns } from './model';
import {
  advanceSortPage, anchorForPage, normalizeSortOffset, normalizeSortOffsetHistory, normalizeSortPage,
  pageFromOrdinal, pageFromSortOffset, previousSortPage, rowsOptionsAfterRebuild, rowsOptionsForViewport,
} from '@webview/paging';
import type { PendingRequest, ProtocolSession, VsCodeMessageClient } from '@webview/protocol-client';
import {
  captureRebuild, planEmptyRestore, planOpened,
  type PendingViewportIntent, type QueryViewport, type RebuildViewportIntent,
  type QueryWindowReplay, type RecoveryRowsOptions, type RestoreViewportIntent, type RestoreViewportPhase,
} from './row-query-recovery-policy';
import { snapshotIdentityChanged } from '@webview/snapshot-identity';
import { sameRecordRef } from '@webview/record-identity';
import { canReadSnapshot, type ViewportMode, type WorkspaceAction, type WorkspaceState } from '@webview/state';
import { MAX_FIELD_FILTERS, MAX_ROW_TYPES, type RowTypeSelection } from './query-selection';
import { reconcileProfileQueryState } from './profile-query-state';
import { rowProjectionPlanForView } from './row-projection-policy';

export interface RowsRequestOptions extends RecoveryRowsOptions {
  readonly query?: string;
  readonly filterColumns?: readonly ColumnSpec[];
  readonly columns?: readonly ColumnSpec[];
  readonly projection?: RowProjectionPlan;
}

export interface RowsRequestMetadata {
  readonly navigation?: 'logical' | 'physical';
  readonly preserveOnRebuild?: boolean;
  readonly restoreAfterRebuild?: boolean;
  readonly restorePhase?: RestoreViewportPhase;
  readonly supersedesRestore?: boolean;
  readonly allowWhileInvalidated?: boolean;
  readonly pageInputSubmission?: boolean;
  readonly followsTail?: boolean;
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
  readonly hasBefore?: boolean;
  readonly hasAfter?: boolean;
}

const NO_FOLLOW_UP = (): void => undefined;

function replayScanWindow(scan: RowPage['scan']): RecoveryRowsOptions['scanWindow'] {
  if (scan?.truncatedReason === undefined) return undefined;
  let examinedRecords: bigint;
  let examinedBytes: bigint;
  try {
    examinedRecords = BigInt(scan.examinedRecords);
    examinedBytes = BigInt(scan.examinedBytes);
  } catch {
    return { records: 0 };
  }
  if (examinedRecords <= 0n) return { records: 0 };
  const maxExaminedRecords = Number(examinedRecords);
  if (!Number.isSafeInteger(maxExaminedRecords) || maxExaminedRecords <= 0) return { records: 0 };
  return {
    records: maxExaminedRecords,
    ...(examinedBytes > 0n ? { bytes: examinedBytes.toString() } : {}),
  };
}

function operationScanBudget(options: RecoveryRowsOptions | undefined, replay: boolean): RowScanBudget | undefined {
  const window = options?.scanWindow;
  if (window !== undefined) {
    // Zero progress is an empty frozen range, not permission to scan anew.
    if (window.records === 0) return { deadlineEpochMs: Date.now() };
    return { maxExaminedRecords: window.records,
      ...(window.bytes === undefined ? {} : { maxExaminedBytes: window.bytes }),
      deadlineEpochMs: createFilterScanBudget().deadlineEpochMs };
  }
  const budget = options?.scanBudget;
  return budget === undefined ? undefined : { ...budget,
    ...(replay ? { deadlineEpochMs: createFilterScanBudget().deadlineEpochMs } : {}) };
}

function queryWindowForPage(
  page: RowPage,
  requested: RecoveryRowsOptions | undefined,
  limit: number,
): QueryWindowReplay | undefined {
  if (page.sort === undefined || requested?.sort === undefined
    || requested.sort.columnId !== page.sort.columnId || requested.sort.direction !== page.sort.direction) return undefined;
  // A slower replay must not replace the original range with its smaller progress.
  const scanWindow = requested.scanWindow ?? replayScanWindow(page.scan);
  const sort = { ...requested.sort };
  if (requested.navigation === 'physical' && requested.direction !== undefined && isPhysicalOrdinalSort(sort)) {
    const anchorOrdinal = requested.anchorOrdinal
      ?? (requested.direction === 'backward' ? page.indexedRecords : undefined);
    return { limit, options: { navigation: 'physical', sort, direction: requested.direction,
      ...(anchorOrdinal === undefined ? {} : { anchorOrdinal }),
      ...(scanWindow === undefined ? {} : { scanWindow }) } };
  }
  // A sorted offset is a matching rank, never an ordinal or a physical scan boundary.
  return { limit, options: { navigation: 'logical', sort, sortOffset: requested.sortOffset ?? '0',
    ...(scanWindow === undefined ? {} : { scanWindow }) } };
}

/** Synchronous UI intent only. The client remains the sole wire/session authority. */
export class RowQueryController {
  readonly #ports: RowQueryControllerPorts;
  readonly #pageSize: number;
  #query: string;
  #filters: RowFilter[];
  #rowTypes: RowTypeSelection | undefined;
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
  #retainedViewport: QueryViewport | undefined;
  #pendingViewport: (PendingViewportIntent & { readonly followsTail?: boolean; readonly preservesAnchor?: boolean }) | undefined;
  #rebuildViewport: RebuildViewportIntent | undefined;
  #restoreViewport: RestoreViewportIntent | undefined;
  #navigation: PageNavigation | undefined;
  #viewportMode: ViewportMode;
  #latestIndexedRecords = '0';

  public constructor(ports: RowQueryControllerPorts, initial: Readonly<WorkspaceState>, pageSize: number) {
    this.#ports = ports;
    this.#pageSize = pageSize;
    this.#query = initial.query;
    this.#filters = [...initial.filters];
    this.#rowTypes = initial.rowTypes;
    this.#sort = initial.sort;
    this.#sortDirection = initial.sortDirection;
    this.#sortOffset = initial.sort === undefined ? '0' : normalizeSortOffset(initial.sortOffset);
    this.#sortOffsetHistory = initial.sort === undefined ? []
      : normalizeSortOffsetHistory(initial.sortOffsetHistory, this.#sortOffset);
    this.#sortPage = initial.sort === undefined ? '1'
      : normalizeSortPage(initial.sortPage, this.#sortOffset, pageSize);
    this.#columns = initial.columns;
    this.#viewportMode = initial.viewportMode;
  }

  public get query(): string { return this.#query; }
  public get filters(): readonly RowFilter[] { return this.#filters; }
  public get rowTypes(): RowTypeSelection | undefined { return this.#rowTypes; }
  public get sort(): RowSort | undefined { return this.#sort; }
  public get sortDirection(): SortDirection { return this.#sortDirection; }
  public get sortOffset(): string { return this.#sortOffset; }
  public get sortPage(): string { return this.#sortPage; }
  public get sortOffsetHistory(): readonly string[] { return [...this.#sortOffsetHistory]; }
  public get pageInput(): string { return this.#pageInput; }
  public get pageInputDirty(): boolean { return this.#pageInputDirty; }
  public get viewportMode(): ViewportMode { return this.#viewportMode; }

  #followsSourceTail(): boolean {
    return this.#ports.getContext().followMode && this.#viewportMode === 'following';
  }

  /** Capture the actual visible semantic row, independently of the page start. */
  public reportViewport(ref: RecordRef): void {
    const context = this.#ports.getContext();
    const retainedRow = canReadSnapshot(context.invalidationReason)
      && context.workspace.rows.some((row) => sameRecordRef(row.ref, ref));
    if ((ref.generation !== context.session.generation && !retainedRow) || !/^[0-9]+$/u.test(ref.ordinal)) return;
    const prior = this.#viewport;
    const sameSession = prior !== undefined && !snapshotIdentityChanged(prior, context.session)
      && prior.query === this.#query;
    // During append adoption, a response for the new generation can reach the
    // controller before React commits its rows. A click from the still-rendered
    // prior-generation page must not inherit that newer page's start or replay
    // window when it reports the physical reading anchor.
    const sameRenderedGeneration = ref.generation === context.session.generation;
    const descending = isPhysicalOrdinalSort(this.#sort) && this.#sort?.direction === 'desc';
    const windowFirstOrdinal = descending
      ? sameSession && sameRenderedGeneration ? prior.windowFirstOrdinal : context.workspace.rows[0]?.ref.ordinal
      : undefined;
    this.#viewport = { ...context.session, query: this.#query, firstVisibleOrdinal: ref.ordinal,
      ...(windowFirstOrdinal === undefined ? {} : { windowFirstOrdinal }),
      ...(sameSession && sameRenderedGeneration && prior.queryWindow !== undefined
        ? { queryWindow: prior.queryWindow } : {}),
      ...(descending ? { sortDirection: 'desc' as const } : {}) };
  }

  public pauseFollowing(ref?: RecordRef): void {
    this.#viewportMode = 'reading';
    this.#ports.dispatch({ type: 'SET_VIEWPORT_MODE', mode: 'reading' });
    if (ref !== undefined) this.reportViewport(ref);
    // User interaction wins even before React commits the reading mode. A
    // pending automatic tail request must not replace the page being read.
    if (this.#pendingViewport?.followsTail) {
      const context = this.#ports.getContext();
      const prior = this.#viewport ?? this.#retainedViewport;
      const retainedAnchor = prior?.documentId === context.session.documentId && prior.query === this.#query
        ? prior.firstVisibleOrdinal : undefined;
      // OPENED retires the old request identity before the replacement page
      // renders. Keep the actual semantic anchor for interactions outside the
      // table; only an unobserved viewport falls back to its retained page start.
      const firstVisibleOrdinal = retainedAnchor ?? context.workspace.rows[0]?.ref.ordinal;
      if (this.#viewport === undefined && firstVisibleOrdinal !== undefined) {
        this.#viewport = { ...context.session, query: this.#query, firstVisibleOrdinal,
          ...(prior?.windowFirstOrdinal === undefined ? {} : { windowFirstOrdinal: prior.windowFirstOrdinal }),
          ...(prior?.queryWindow === undefined ? {} : { queryWindow: prior.queryWindow }),
          ...(prior?.sortDirection === undefined ? {} : { sortDirection: prior.sortDirection }) };
      }
      for (const requestId of this.#ports.client.cancel('rows')) {
        this.#ports.dispatch({ type: 'REQUEST_FINISHED', kind: 'rows', requestId });
      }
      this.#pendingViewport = undefined;
      if (context.workspace.rows[0]?.ref.generation !== context.session.generation) {
        const options = this.currentViewportOptions();
        this.requestRows(options, { preserveOnRebuild: true,
          navigation: isPhysicalOrdinalSort(options.sort ?? this.#sort)
            && options.direction !== undefined ? 'physical' : 'logical' });
      }
    }
  }

  /** Resume only when the current unfiltered physical tail is actually visible. */
  public resumeFollowingAtTail(ref: RecordRef): boolean {
    const context = this.#ports.getContext();
    const state = context.workspace;
    if (!context.followMode || !canReadSnapshot(context.invalidationReason)
      || state.summary === undefined || snapshotIdentityChanged(state.summary.snapshot, context.session)
      || ref.generation !== context.session.generation || !/^[0-9]+$/u.test(ref.ordinal)
      || this.#query.trim() !== '' || this.#filters.length > 0 || this.#rowTypes !== undefined
      || (this.#sort !== undefined && !isPhysicalOrdinalSort(this.#sort))
      || this.#viewport === undefined || snapshotIdentityChanged(this.#viewport, context.session)
      || this.#viewport.query !== this.#query
      || this.#pendingViewport !== undefined || this.#restoreViewport !== undefined
      || this.#rebuildViewport !== undefined || this.#ports.client.hasPending('rows')
      || state.pending.rows !== undefined
      // The client/controller may receive progress before React commits it.
      // An observation made with the old count cannot prove the latest visible.
      || state.latestSeq !== this.#latestIndexedRecords
      || BigInt(ref.ordinal) + 1n !== BigInt(state.latestSeq)
      || !state.rows.some((row) => sameRecordRef(row.ref, ref))) return false;
    if (this.#viewportMode !== 'following') {
      this.#viewportMode = 'following';
      this.#ports.dispatch({ type: 'SET_VIEWPORT_MODE', mode: 'following' });
    }
    return true;
  }

  /** Explicitly return to the physical tail; filtered results cannot prove it visible. */
  public returnToLatest(): void {
    this.#query = '';
    this.#filters = [];
    this.#rowTypes = undefined;
    this.#sort = this.#sortDirection === 'desc' && this.#ports.getContext().indexingComplete
      ? { columnId: '__ordinal', direction: 'desc' } : undefined;
    this.#resetPaging();
    this.#pageInputDirty = false;
    this.#pageInputFocused = false;
    this.#ports.dispatch({ type: 'SET_QUERY', query: '' });
    this.#ports.dispatch({ type: 'SET_FILTER', filter: undefined });
    this.#ports.dispatch({ type: 'SET_ROW_TYPES', rowTypes: undefined });
    this.#ports.dispatch({ type: 'SET_SORT', sort: this.#sort });
    this.#viewportMode = 'following';
    this.#ports.dispatch({ type: 'SET_VIEWPORT_MODE', mode: 'following' });
    this.#requestTailRows();
  }

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
    this.#viewport = undefined;
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
    const pending = this.#pendingViewport;
    if (pending !== undefined && pending.preserveOnRebuild && pending.query === this.#query
      && !snapshotIdentityChanged(pending, this.#ports.getContext().session)) {
      return { ...pending.options,
        ...(pending.options.sort === undefined ? {} : { sort: { ...pending.options.sort } }),
        ...(pending.options.scanWindow === undefined ? {} : { scanWindow: { ...pending.options.scanWindow } }),
        ...(pending.options.scanBudget === undefined ? {} : { scanBudget: { ...pending.options.scanBudget } }) };
    }
    const queryWindow = this.#viewport?.query === this.#query ? this.#viewport.queryWindow : undefined;
    if (queryWindow !== undefined && queryWindow.limit === this.#pageSize) {
      const options = queryWindow.options;
      return { ...options,
        ...(options.sort === undefined ? {} : { sort: { ...options.sort } }),
        ...(options.scanWindow === undefined ? {} : { scanWindow: { ...options.scanWindow } }),
        ...(options.scanBudget === undefined ? {} : { scanBudget: { ...options.scanBudget } }) };
    }
    if (this.#sort !== undefined) return { navigation: 'logical', sortOffset: this.#sortOffset };
    return rowsOptionsAfterRebuild(
      this.#viewport?.query === this.#query
        ? this.#viewport.windowFirstOrdinal ?? this.#viewport.firstVisibleOrdinal : undefined,
      this.#followsSourceTail(),
      this.#viewport?.sortDirection ?? 'asc',
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
    const requestedSort = options?.sort ?? this.#sort;
    const sort = context.indexingComplete || isPhysicalOrdinalSort(requestedSort) ? requestedSort : undefined;
    const navigation = metadata.navigation ?? options?.navigation ?? 'logical';
    const physicalCursor = sort !== undefined && isPhysicalOrdinalSort(sort) && navigation === 'physical';
    const cursorAllowed = sort === undefined || physicalCursor;
    const anchorOrdinal = cursorAllowed ? options?.anchorOrdinal : undefined;
    const direction = cursorAllowed
      ? options?.direction ?? (physicalCursor ? sort?.direction === 'desc' ? 'backward' : 'forward' : undefined)
      : undefined;
    const sortOffset = sort === undefined || physicalCursor ? undefined : options?.sortOffset ?? this.#sortOffset;
    const state = context.workspace;
    const filterColumns = options?.filterColumns
      ?? (this.#columns.length > 0 ? this.#columns : this.#ports.fallbackColumns(state.rows));
    const columns = options?.columns ?? (state.summary?.snapshot.generation === context.session.generation
      ? selectedRecordColumns(this.#columns, state.schema, state.columnVisibility) : undefined);
    const scanBudget = operationScanBudget(options, metadata.preserveOnRebuild === true);
    const payload = buildRecordQueryRequest({
      limit: this.#pageSize, query, filterColumns,
      ...(columns === undefined ? {} : { columns }),
      filters: this.#filters,
      ...(this.#rowTypes === undefined ? {} : { rowTypes: this.#rowTypes }),
      ...(anchorOrdinal === undefined ? {} : { anchorOrdinal }),
      ...(direction === undefined ? {} : { direction }),
      ...(sort === undefined ? {} : { sort }),
      ...(sortOffset === undefined ? {} : { sortOffset }),
      ...(scanBudget === undefined ? {} : { scanBudget }),
      projection: options?.projection ?? rowProjectionPlanForView(state.activeTab, state.displayMode, state.summary?.profileId),
    });
    const request = this.#ports.client.send('GET_ROWS', payload);
    if (metadata.pageInputSubmission === true) this.#pageInputRequestId = request.id;
    const pendingOptions: RecoveryRowsOptions = {
      ...(sort === undefined ? {} : { navigation }),
      ...(anchorOrdinal === undefined ? {} : { anchorOrdinal }),
      ...(direction === undefined ? {} : { direction }),
      ...(sort === undefined ? {} : { sort: { ...sort },
        ...(sortOffset === undefined ? {} : { sortOffset }) }),
      ...(payload.scanBudget === undefined ? {} : { scanBudget: { ...payload.scanBudget } }),
      ...(options?.scanWindow === undefined ? {} : { scanWindow: { ...options.scanWindow } }),
    };
    if (metadata.restoreAfterRebuild === true && this.#restoreViewport !== undefined) {
      this.#restoreViewport = { ...this.#restoreViewport, requestId: request.id,
        phase: metadata.restorePhase ?? 'initial', requestedOptions: pendingOptions };
    }
    this.#pendingViewport = {
      ...context.session, requestId: request.id, query,
      preserveOnRebuild: metadata.preserveOnRebuild ?? options !== undefined,
      restoreAfterRebuild: metadata.restoreAfterRebuild === true,
      followsTail: metadata.followsTail === true,
      preservesAnchor: metadata.restoreAfterRebuild === true || metadata.preserveOnRebuild === true,
      options: pendingOptions,
    };
    this.#ports.dispatch({ type: 'REQUEST_SENT', request });
    return request;
  }

  public revealOrdinal(ordinal: string): void {
    if (!/^[0-9]+$/u.test(ordinal)) return;
    const context = this.#ports.getContext();
    if (!canReadSnapshot(context.invalidationReason)) return;
    this.pauseFollowing();
    this.abandonRestore();
    this.#ports.dispatch({ type: 'SELECT_ROW', ordinal });
    const sort = this.#sort;
    if (sort !== undefined && isPhysicalOrdinalSort(sort)) {
      try {
        const rowOrdinal = BigInt(ordinal);
        const sortOffset = sort.direction === 'asc'
          ? rowOrdinal
          : BigInt(this.#latestIndexedRecords) - rowOrdinal - 1n;
        if (sortOffset < 0n) return;
        this.requestRows({ sortOffset: sortOffset.toString() },
          { supersedesRestore: true, navigation: 'logical' });
      } catch { /* Ignore a stale Navigator ordinal outside the current snapshot. */ }
      return;
    }
    this.requestRows({ anchorOrdinal: ordinal, direction: 'forward' }, { supersedesRestore: true });
  }

  public rebuild(): void {
    const context = this.#ports.getContext();
    const captured = captureRebuild({
      session: context.session, query: this.#query, followMode: this.#followsSourceTail(),
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
    this.pauseFollowing();
    this.#query = query;
    this.#resetPaging();
    this.#releaseSubmission();
    if (this.#restoreViewport?.query !== query) this.abandonRestore();
    this.#ports.dispatch({ type: 'SET_QUERY', query });
  }

  public applyFilter(filter: RowFilter | undefined): void {
    this.applyFilters(filter === undefined ? [] : [filter]);
  }

  public applyFilters(filters: readonly RowFilter[]): void {
    if (filters.length > MAX_FIELD_FILTERS) return;
    this.pauseFollowing();
    this.#filters = [...new Map(filters.map((filter) => [JSON.stringify(filter), filter])).values()];
    this.#resetPaging();
    this.#ports.dispatch({ type: 'SET_FILTERS', filters: this.#filters });
    this.requestRows({ sortOffset: '0' }, { navigation: 'logical' });
  }

  public applyRowTypes(selection: RowTypeSelection | undefined): void {
    if (selection !== undefined && selection.values.length > MAX_ROW_TYPES) return;
    this.pauseFollowing();
    this.#rowTypes = selection?.values.length ? { column: selection.column, values: [...new Set(selection.values)] } : undefined;
    this.#resetPaging();
    this.#ports.dispatch({ type: 'SET_ROW_TYPES', rowTypes: this.#rowTypes });
    this.requestRows({ sortOffset: '0' }, { navigation: 'logical' });
  }

  public changeSort(sort: RowSort | undefined, userIntent = true): void {
    if (userIntent) this.pauseFollowing();
    this.#sort = sort;
    this.#resetPaging();
    this.#ports.dispatch({ type: 'SET_SORT', sort });
    this.requestRows({ sortOffset: '0' }, { navigation: 'logical' });
  }

  public requestRowOrder(direction: SortDirection): void {
    const context = this.#ports.getContext();
    if (!context.indexingComplete || context.invalidationReason !== undefined
      || this.#ports.client.hasPending('rebuild') || this.#ports.client.hasPending('order')) return;
    if (direction === this.#sortDirection && (direction === 'asc' ? this.#sort === undefined
      : this.#sort?.columnId === '__ordinal' && this.#sort.direction === 'desc')) return;
    this.pauseFollowing();
    const request = this.#ports.client.send('SET_ROW_ORDER', { direction });
    this.#ports.dispatch({ type: 'REQUEST_SENT', request });
  }

  public requestFollowRows(): void {
    if (!this.#followsSourceTail()) return;
    this.#requestTailRows();
  }

  #requestTailRows(): void {
    this.abandonRestore();
    if (this.#ports.getContext().indexingComplete && this.#sort?.columnId === '__ordinal' && this.#sort.direction === 'desc') {
      this.#setSortPosition({ offset: '0', history: [], page: '1' });
      this.requestRows({ sortOffset: '0' }, { followsTail: true, navigation: 'logical' });
    } else this.requestRows({ direction: 'backward' }, { followsTail: true });
  }

  public nextPage(): void {
    const state = this.#ports.getContext().workspace;
    if (!canReadSnapshot(this.#ports.getContext().invalidationReason)) return;
    this.pauseFollowing();
    const navigation = this.#navigation;
    if (isPhysicalOrdinalSort(this.#sort)) {
      if ((navigation?.hasAfter ?? state.page?.hasAfter) !== true) return;
      const direction = this.#sort?.direction === 'desc' ? 'backward' : 'forward';
      const scan = navigation?.scan ?? state.page?.scan;
      const continuation = scan?.truncatedReason !== undefined && scan.direction === direction
        && scan.examinedRecords !== '0' ? scan.cursorOrdinal : undefined;
      const anchorOrdinal = continuation ?? navigation?.lastOrdinal ?? state.rows.at(-1)?.ref.ordinal
        ?? navigation?.anchorOrdinal ?? state.page?.anchorOrdinal;
      if (anchorOrdinal !== undefined) this.requestRows({ anchorOrdinal, direction }, { navigation: 'physical' });
      return;
    }
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
      this.requestRows({ sortOffset: position.offset }, { navigation: 'logical' });
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
    this.pauseFollowing();
    if (isPhysicalOrdinalSort(this.#sort)) {
      const state = context.workspace;
      const navigation = this.#navigation;
      if ((navigation?.hasBefore ?? state.page?.hasBefore) !== true) return;
      const direction = this.#sort?.direction === 'desc' ? 'forward' : 'backward';
      const scan = navigation?.scan ?? state.page?.scan;
      const continuation = scan?.truncatedReason !== undefined && scan.direction === direction
        && scan.examinedRecords !== '0' ? scan.cursorOrdinal : undefined;
      const anchorOrdinal = continuation ?? navigation?.firstOrdinal ?? state.rows[0]?.ref.ordinal
        ?? navigation?.anchorOrdinal ?? state.page?.anchorOrdinal;
      if (anchorOrdinal !== undefined) this.requestRows({ anchorOrdinal, direction }, { navigation: 'physical' });
      return;
    }
    if (this.#sort !== undefined) {
      const position = previousSortPage(this.#sortOffsetHistory, this.#sortOffset, this.#sortPage, this.#pageSize);
      this.#setSortPosition(position);
      this.#setPageInput(position.page);
      this.requestRows({ sortOffset: position.offset }, { navigation: 'logical' });
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

  public focusPageInput(focused: boolean): void {
    this.#pageInputFocused = focused;
    if (focused) this.pauseFollowing();
  }

  public releasePageInputFocus(): void { this.#pageInputFocused = false; }

  public editPageInput(value: string): void {
    this.pauseFollowing();
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
      this.requestRows({ sortOffset: offset.toString() }, { pageInputSubmission: true, navigation: 'logical' });
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
      restore, session: context.session, query: this.#query, followMode: this.#followsSourceTail(),
      invalidated: context.invalidationReason !== undefined, indexingComplete: context.indexingComplete,
      pageSize: this.#pageSize, totalRecords, requestedOptions, matchedRecords, scanTruncated,
    });
    this.#restoreViewport = decision.kind === 'stop' ? undefined : decision.restore;
    if (decision.kind !== 'retry') return;
    this.requestRows({ ...decision.options, ...(restore.query.trim() ? { query: restore.query } : {}) }, {
      preserveOnRebuild: true, restoreAfterRebuild: true, restorePhase: 'retrying', supersedesRestore: false,
      navigation: isPhysicalOrdinalSort(decision.options.sort ?? this.#sort)
        && decision.options.direction !== undefined ? 'physical' : 'logical',
    });
  }

  #receiveRows(message: Extract<ExtensionMessage, { type: 'ROWS' }>): () => void {
    const context = this.#ports.getContext();
    if (!canReadSnapshot(context.invalidationReason)) return NO_FOLLOW_UP;
    const pending = this.#pendingViewport?.requestId === message.requestId ? this.#pendingViewport : undefined;
    const restore = pending?.restoreAfterRebuild && this.#restoreViewport?.requestId === message.requestId
      && !snapshotIdentityChanged(this.#restoreViewport, context.session) ? this.#restoreViewport : undefined;
    if (pending !== undefined && !pending.preservesAnchor && !pending.followsTail) {
      this.#ports.dispatch({ type: 'RESET_VIEWPORT' });
    }
    const responseQuery = pending?.query ?? this.#query;
    this.#columns = message.payload.columns;
    this.#navigation = { firstOrdinal: message.payload.rows[0]?.ref.ordinal,
      lastOrdinal: message.payload.rows.at(-1)?.ref.ordinal, anchorOrdinal: message.payload.anchorOrdinal,
      sortNextOffset: message.payload.sortNextOffset, scan: message.payload.scan,
      hasBefore: message.payload.hasBefore, hasAfter: message.payload.hasAfter };
    const cursorResponse = isPhysicalOrdinalSort(message.payload.sort)
      && pending?.options.navigation === 'physical' && message.payload.sortOffset === undefined;
    if (cursorResponse) this.#setSortPosition({ offset: '0', history: [], page: '1' });
    if (message.payload.sortOffset !== undefined && responseQuery === this.#query) {
      const offset = normalizeSortOffset(message.payload.sortOffset);
      if (offset !== this.#sortOffset) {
        this.#setSortPosition({ offset, history: [], page: pageFromSortOffset(offset, this.#pageSize) });
      } else this.#sortOffset = offset;
    }
    const sameViewport = this.#viewport !== undefined
      && !snapshotIdentityChanged(this.#viewport, context.session) && this.#viewport.query === responseQuery;
    const savedAnchor = sameViewport ? this.#viewport?.firstVisibleOrdinal
      : message.payload.sort?.direction === 'desc' ? restore?.firstVisibleOrdinal : undefined;
    const retainedAnchor = this.#viewportMode === 'reading' && pending?.preservesAnchor === true
      && message.payload.rows.some((row) => row.ref.ordinal === savedAnchor) ? savedAnchor : undefined;
    const firstVisibleOrdinal = retainedAnchor ?? message.payload.rows[0]?.ref.ordinal
      ?? (sameViewport ? this.#viewport?.firstVisibleOrdinal : undefined);
    const queryWindow = queryWindowForPage(message.payload, pending?.options, this.#pageSize);
    this.#viewport = { ...context.session, query: responseQuery,
      ...(firstVisibleOrdinal === undefined ? {} : { firstVisibleOrdinal }),
      ...(queryWindow === undefined ? {} : { queryWindow }),
      ...(isPhysicalOrdinalSort(message.payload.sort) && message.payload.sort?.direction === 'desc'
        && message.payload.rows[0]?.ref.ordinal !== undefined
        ? { windowFirstOrdinal: message.payload.rows[0].ref.ordinal, sortDirection: 'desc' as const } : {}) };
    this.#retainedViewport = undefined;
    if (pending !== undefined) {
      if (this.#pageInputRequestId === message.requestId) this.#releaseSubmission();
      this.#pendingViewport = undefined;
    }
    if (message.payload.rows.length > 0 && responseQuery === this.#query
      && !this.#pageInputDirty && !this.#pageInputFocused) {
      this.#setPageInput(cursorResponse ? '' : this.#sort === undefined
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
      if (flags.openedGenerationChanged) this.#latestIndexedRecords = message.payload.indexedRecords;
      const decision = planOpened({
        opened: message.payload.snapshot, firstOpenedSession: flags.firstOpenedSession,
        snapshotChanged: flags.openedGenerationChanged, query: this.#query, followMode: this.#followsSourceTail(),
        pageText: this.#pageInput, pageSize: this.#pageSize, viewport: this.#viewport,
        pending: this.#pendingViewport, rebuild: this.#rebuildViewport,
      });
      if (decision.kind === 'none') return NO_FOLLOW_UP;
      if (this.#sort === undefined || this.#sort.columnId === '__ordinal') {
        const sort: RowSort | undefined = this.#sortDirection === 'desc'
          && (context.indexingComplete || isPhysicalOrdinalSort(this.#sort))
          ? { columnId: '__ordinal', direction: 'desc' } : undefined;
        if (this.#sort?.direction !== sort?.direction) {
          this.#sort = sort;
          this.#resetPaging();
          this.#ports.dispatch({ type: 'SET_SORT', sort });
        }
      }
      this.#releaseSubmission();
      this.#restoreViewport = decision.restore;
      this.#retainedViewport = this.#viewport ?? this.#retainedViewport;
      this.#viewport = undefined;
      this.#pendingViewport = undefined;
      this.#rebuildViewport = undefined;
      this.#navigation = undefined;
      return () => this.requestRows({ ...decision.options, ...(decision.query === undefined ? {} : { query: decision.query }) },
        decision.replacesSnapshot ? { preserveOnRebuild: true, restoreAfterRebuild: !this.#followsSourceTail(),
          restorePhase: 'initial', supersedesRestore: false, allowWhileInvalidated: true,
          followsTail: this.#followsSourceTail(), navigation: isPhysicalOrdinalSort(decision.options.sort ?? this.#sort)
            && decision.options.direction !== undefined ? 'physical' : 'logical' }
          : { allowWhileInvalidated: true, followsTail: this.#followsSourceTail(),
            navigation: isPhysicalOrdinalSort(decision.options.sort ?? this.#sort)
              && decision.options.direction !== undefined ? 'physical' : 'logical' });
    }
    if (message.type === 'PROFILE_CHANGED' && context.invalidationReason === undefined) {
      const profile = reconcileProfileQueryState(this.#sort, this.#filters[0], this.#columns, message.payload.columns);
      const restore = this.#restoreViewport;
      const pendingRestore = this.#pendingViewport?.restoreAfterRebuild === true && restore !== undefined;
      const pendingOptions = pendingRestore ? this.#pendingViewport?.options : undefined;
      const preservesSort = pendingOptions?.sort !== undefined && profile.sort !== undefined
        && pendingOptions.sort.columnId === profile.sort.columnId && pendingOptions.sort.direction === profile.sort.direction;
      // Keep the correlated page intent; the rendered anchor can still be on its predecessor page.
      const recoveryOptions = pendingOptions === undefined ? undefined : {
        ...(pendingOptions.navigation === undefined ? {} : { navigation: pendingOptions.navigation }),
        ...(pendingOptions.anchorOrdinal === undefined ? {} : { anchorOrdinal: pendingOptions.anchorOrdinal }),
        ...(pendingOptions.direction === undefined ? {} : { direction: pendingOptions.direction }),
        ...(pendingOptions.scanBudget === undefined ? {} : { scanBudget: pendingOptions.scanBudget }),
        ...(pendingOptions.scanWindow === undefined ? {} : { scanWindow: pendingOptions.scanWindow }),
        ...(preservesSort ? { sort: profile.sort, sortOffset: pendingOptions.sortOffset } : {}),
      };
      const previousFilterCount = this.#filters.length;
      const previousRowTypes = this.#rowTypes;
      this.#sort = profile.sort;
      this.#filters = this.#filters.flatMap((filter) => {
        const reconciled = reconcileProfileQueryState(undefined, filter, this.#columns, message.payload.columns).filter;
        return reconciled === undefined ? [] : [reconciled];
      });
      if (this.#rowTypes?.column.source === 'profile'
        && !message.payload.columns.some((column) => column.id === this.#rowTypes?.column.id && column.source === 'profile')) {
        this.#rowTypes = undefined;
      }
      const preservesOrdinalWindow = message.requestId === '' && this.#viewportMode === 'reading'
        && isPhysicalOrdinalSort(profile.sort) && profile.sort?.direction === 'desc'
        && this.#viewport?.windowFirstOrdinal !== undefined
        && previousFilterCount === this.#filters.length && previousRowTypes === this.#rowTypes;
      if (!preservesSort && !preservesOrdinalWindow) this.#resetPaging();
      this.#columns = columnsAfterProfileChange(this.#columns, message.payload.columns, context.workspace.columnVisibility);
      // An unsolicited profile projection does not supersede a recovery that
      // is waiting for indexing. Explicit App setProfile already abandons it.
      if (restore !== undefined && !pendingRestore) return NO_FOLLOW_UP;
      const refresh = pendingRestore && !this.#followsSourceTail()
        ? rowsOptionsForViewport(restore.windowFirstOrdinal ?? restore.firstVisibleOrdinal,
          restore.pageText, this.#pageSize, false, recoveryOptions, restore.sortDirection ?? 'asc')
        : preservesOrdinalWindow ? this.currentViewportOptions()
          : rowsOptionsAfterRebuild(this.#viewport?.windowFirstOrdinal ?? this.#viewport?.firstVisibleOrdinal,
            this.#followsSourceTail(), this.#viewport?.sortDirection ?? 'asc');
      return () => this.requestRows({ ...refresh,
        projection: rowProjectionPlanForView(context.workspace.activeTab, context.workspace.displayMode, message.payload.profileId),
        ...(this.#query.trim() ? { query: this.#query } : {}),
        filterColumns: message.payload.columns,
        ...(profile.sort === undefined || preservesSort || preservesOrdinalWindow ? {} : { sortOffset: '0' }) },
      pendingRestore ? { preserveOnRebuild: true, restoreAfterRebuild: true,
        restorePhase: restore.phase === 'retrying' ? 'retrying' : 'initial', supersedesRestore: false,
        navigation: isPhysicalOrdinalSort(profile.sort) && refresh.direction !== undefined ? 'physical' : 'logical' }
        : { preserveOnRebuild: true,
          navigation: isPhysicalOrdinalSort(profile.sort) && refresh.direction !== undefined ? 'physical' : 'logical' });
    }
    if (message.type === 'INDEX_PROGRESS') {
      const tailAdvanced = BigInt(message.payload.indexedRecords) > BigInt(this.#latestIndexedRecords);
      if (tailAdvanced) this.#latestIndexedRecords = message.payload.indexedRecords;
      const restore = this.#restoreViewport;
      const waiting = restore !== undefined && restore.phase === 'waiting-index'
        && restore.documentId === message.documentId && restore.generation === message.generation
        && message.payload.indexingComplete;
      return () => {
        if (waiting) this.#finishEmptyRestore(restore, message.payload.indexedRecords, undefined);
        if (message.payload.indexingComplete && this.#sortDirection === 'desc' && this.#sort === undefined
          && this.#ports.getContext().invalidationReason === undefined) {
          this.changeSort({ columnId: '__ordinal', direction: 'desc' }, false);
          return;
        }
        if (tailAdvanced) this.requestFollowRows();
      };
    }
    if (message.type === 'ROW_ORDER_CHANGED') {
      this.#sortDirection = message.payload.direction;
      this.#sort = message.payload.direction === 'desc' ? { columnId: '__ordinal', direction: 'desc' } : undefined;
      this.#resetPaging();
      return () => {
        this.#ports.dispatch({ type: 'SET_SORT_DIRECTION', direction: message.payload.direction });
        this.#ports.dispatch({ type: 'SET_SORT', sort: this.#sort });
        this.requestRows({ sortOffset: '0' }, { navigation: 'logical' });
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
