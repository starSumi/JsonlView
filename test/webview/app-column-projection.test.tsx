import React, { type ComponentType, type ReactElement, type ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_TABLE_COLUMNS, PROTOCOL_VERSION, keyPath, type ColumnSpec, type DocumentSummary,
  type ExtensionMessage, type RowPage, type WebviewRequest } from '../../src/shared/types';
import { ColumnChooser, RecordPager, RecordQueryControls, RecordTable, TopQueryStudio } from '../../src/webview/features/record-query';
import { getColumnText, recordColumnForPath } from '../../src/webview/format';
import type { PersistedWorkspaceState } from '../../src/webview/state';
import { WorkspaceHeader } from '../../src/webview/workspace-header';
import { DetailDrawer } from '../../src/webview/detail-drawer';
import { DatasetInsights } from '../../src/webview/dataset-insights';
import { BfclInsights, InsightsView } from '../../src/webview/widgets/insights-panel';
import { InsightsToolbar } from '../../src/webview/insights-toolbar';
import { summarizeDatasetRecord } from '../../src/profiles/dataset-analysis';
import { summarizeBfclV3Record } from '../../src/profiles/datasets/bfcl-v3';

type Effect = { deps?: readonly unknown[] | undefined; cleanup?: (() => void) | undefined };
const hooks = vi.hoisted(() => ({
  cursor: 0, dirty: false, slots: [] as unknown[], layoutEffects: [] as Array<() => void>, effects: [] as Array<() => void>,
}));
const bodyClasses = new Set<string>();

// The repository uses a Node test environment. This bounded hook host commits
// the real App, effects, reducer and controller without adding a DOM dependency.
// Child components are inspected at App's actual presentation boundary.
vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  const same = (left?: readonly unknown[], right?: readonly unknown[]): boolean =>
    left !== undefined && right !== undefined && left.length === right.length
      && left.every((value, index) => Object.is(value, right[index]));
  const useState = <Value,>(initial: Value | (() => Value)) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === 'function' ? (initial as () => Value)() : initial;
    return [hooks.slots[index], (next: Value | ((value: Value) => Value)) => {
      const previous = hooks.slots[index] as Value;
      const value = typeof next === 'function' ? (next as (value: Value) => Value)(previous) : next;
      if (!Object.is(previous, value)) { hooks.slots[index] = value; hooks.dirty = true; }
    }] as const;
  };
  const useReducer = (reducer: (state: unknown, action: unknown) => unknown, initial: unknown,
    initialize: (value: unknown) => unknown) => {
    const [state, setState] = useState(() => initialize(initial));
    const dispatch = useMemo(() => (action: unknown) => setState((previous: unknown) => reducer(previous, action)), []);
    return [state, dispatch];
  };
  const useRef = <Value,>(initial: Value) => {
    const index = hooks.cursor++;
    hooks.slots[index] ??= { current: initial };
    return hooks.slots[index] as { current: Value };
  };
  const useMemo = <Value,>(factory: () => Value, deps?: readonly unknown[]) => {
    const index = hooks.cursor++;
    const prior = hooks.slots[index] as { value: Value; deps?: readonly unknown[] } | undefined;
    if (prior === undefined || !same(prior.deps, deps)) hooks.slots[index] = { value: factory(), deps };
    return (hooks.slots[index] as { value: Value }).value;
  };
  const useEffect = (setup: () => (() => void) | void, deps?: readonly unknown[]) => {
    const index = hooks.cursor++;
    const previous = hooks.slots[index] as Effect | undefined;
    if (previous !== undefined && same(previous.deps, deps)) return;
    const effect: Effect = { deps };
    hooks.slots[index] = effect;
    hooks.effects.push(() => { previous?.cleanup?.(); effect.cleanup = setup() || undefined; });
  };
  const useLayoutEffect = (setup: () => (() => void) | undefined, deps?: readonly unknown[]) => {
    const index = hooks.cursor++;
    const previous = hooks.slots[index] as Effect | undefined;
    if (previous !== undefined && same(previous.deps, deps)) return;
    const effect: Effect = { deps };
    hooks.slots[index] = effect;
    hooks.layoutEffects.push(() => { previous?.cleanup?.(); effect.cleanup = setup() || undefined; });
  };
  const useEffectEvent = <Args extends readonly unknown[], Result>(callback: (...args: Args) => Result): ((...args: Args) => Result) => {
    const ref = useRef<(...args: Args) => Result>(callback);
    ref.current = callback;
    return useMemo(() => (...args: Args) => ref.current(...args), []);
  };
  const replacements = { useState, useReducer, useRef, useMemo, useEffect, useLayoutEffect, useEffectEvent,
    useCallback: <Value,>(callback: Value, deps: readonly unknown[]) => useMemo(() => callback, deps) };
  return { ...react, ...replacements, default: { ...react, ...replacements } };
});

const sent: WebviewRequest[] = [];
let persisted: PersistedWorkspaceState | undefined;
let tree: ReactElement;
let App: () => React.JSX.Element;
let browser: EventTarget;

beforeAll(async () => {
  vi.stubGlobal('document', { body: {
    dataset: { documentId: 'doc', generation: 'bootstrap', pageSize: '20' },
    classList: { add: (name: string) => bodyClasses.add(name), remove: (name: string) => bodyClasses.delete(name) },
  } });
  browser = Object.assign(new EventTarget(), { innerWidth: 1400,
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    __jsonlViewVscodeApi: { getState: () => persisted, setState: vi.fn(),
      postMessage: (message: WebviewRequest) => sent.push(message) },
  });
  vi.stubGlobal('window', browser);
  ({ App } = await import('../../src/webview/App'));
});

beforeEach(() => {
  vi.useFakeTimers();
  hooks.slots = []; hooks.layoutEffects = []; hooks.effects = []; hooks.cursor = 0;
  bodyClasses.clear();
  sent.length = 0; persisted = undefined;
});
afterEach(() => {
  for (const slot of hooks.slots) (slot as Effect | undefined)?.cleanup?.();
  hooks.layoutEffects = [];
  hooks.effects = [];
  vi.useRealTimers();
});
afterAll(() => { vi.unstubAllGlobals(); });

function commit(): void {
  let renders = 0;
  do {
    if (++renders > 25) throw new Error('App effects did not settle');
    hooks.cursor = 0; hooks.dirty = false;
    tree = App();
    for (const run of hooks.layoutEffects.splice(0)) run();
    for (const run of hooks.effects.splice(0)) run();
  } while (hooks.dirty);
}

function props<Props,>(component: ComponentType<Props>): Props {
  const find = (node: ReactNode): Props | undefined => {
    if (Array.isArray(node)) {
      for (const child of node) { const found = find(child); if (found !== undefined) return found; }
    } else if (React.isValidElement<{ children?: ReactNode }>(node)) {
      if (node.type === component) return node.props as Props;
      const foundInChildren = find(node.props.children);
      if (foundInChildren !== undefined) return foundInChildren;
      const secondary = (node.props as { secondary?: ReactNode }).secondary;
      return find(secondary);
    }
    return undefined;
  };
  const found = find(tree);
  if (found === undefined) throw new Error('App child missing');
  return found;
}

function elementByClassName(className: string): ReactElement | undefined {
  const find = (node: ReactNode): ReactElement | undefined => {
    if (Array.isArray(node)) {
      for (const child of node) { const found = find(child); if (found !== undefined) return found; }
    } else if (React.isValidElement<{ children?: ReactNode; className?: string; secondary?: ReactNode }>(node)) {
      if (node.props.className?.split(' ').includes(className)) return node;
      const found = find(node.props.children);
      if (found !== undefined) return found;
      return find(node.props.secondary);
    }
    return undefined;
  };
  return find(tree);
}

function buttonWithin(node: ReactNode, label: string): ReactElement<{ children?: ReactNode; onClick?: () => void }> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = buttonWithin(child, label);
      if (found !== undefined) return found;
    }
  } else if (React.isValidElement<{ children?: ReactNode; onClick?: () => void }>(node)) {
    if (node.type === 'button' && node.props.children === label) return node;
    return buttonWithin(node.props.children, label);
  }
  return undefined;
}

function last<Type extends WebviewRequest['type']>(type: Type): Extract<WebviewRequest, { type: Type }> {
  const request = [...sent].reverse().find((candidate) => candidate.type === type);
  if (request === undefined) throw new Error(`Missing ${type}`);
  return request as Extract<WebviewRequest, { type: Type }>;
}
function deliver<Type extends ExtensionMessage['type']>(type: Type,
  payload: Extract<ExtensionMessage, { type: Type }>['payload'], request: WebviewRequest): void {
  const message = { protocolVersion: PROTOCOL_VERSION, type, documentId: 'doc', generation: 'g1',
    requestId: request.requestId, payload };
  browser.dispatchEvent(new MessageEvent('message', { data: message }));
  commit();
}
function deliverBroadcast(type: string, payload: unknown): void {
  browser.dispatchEvent(new MessageEvent('message', { data: { protocolVersion: PROTOCOL_VERSION, type,
    documentId: 'doc', generation: 'g1', requestId: '', payload } }));
  commit();
}
const recordColumn = (name: string): ColumnSpec => recordColumnForPath(keyPath(name))!;
const status = recordColumn('status');
const prompt = recordColumn('prompt');
const extra = recordColumn('extra');
const summary: DocumentSummary = {
  snapshot: { documentId: 'doc', generation: 'g1', uri: 'file:///synthetic.jsonl', scheme: 'file', sizeBytes: '9000',
    mtimeMs: 1, prefixFingerprint: 'synthetic', observedAt: '2026-10-15T00:00:00Z' },
  profileId: 'generic', profileSuggestions: [], indexedBytes: '9000', indexedRecords: '80',
  indexingComplete: true, validRecords: '80', problemRecords: '0',
};
function page(columns: ColumnSpec[], start = 0, descending = false): RowPage {
  return { columns, rows: Array.from({ length: 20 }, (_, index) => {
    const ordinal = String(descending ? start - index : start + index);
    return { ref: { generation: 'g1', ordinal, byteStart: String(Number(ordinal) * 100),
      byteEndExclusive: String(Number(ordinal) * 100 + 100), contentByteLength: '99', delimiterByteLength: 1,
      parseState: 'valid' }, genericSummary: `keep ${ordinal}`,
      cells: columns.map((column) => ({ columnId: column.id, kind: 'string', value: `${column.label} ${ordinal}` })) };
  }), anchorOrdinal: String(descending ? start - 19 : start + 19), hasBefore: start > 0,
  hasAfter: true, indexedRecords: '80', totalRecords: '80' };
}
function boot(columns: ColumnSpec[] = [status, prompt]): void {
  commit();
  deliver('OPENED', summary, last('READY'));
  deliver('ROWS', page(columns), last('GET_ROWS'));
}
const rowRequests = (): WebviewRequest[] => sent.filter((request) => request.type === 'GET_ROWS');
function chooseWorkspaceTab(label: string): void {
  const visit = (node: ReactNode): boolean => {
    if (Array.isArray(node)) return node.some(visit);
    if (!React.isValidElement<{ children?: ReactNode; onClick?: () => void; role?: string }>(node)) return false;
    if (node.type === 'button' && node.props.role === 'tab'
      && React.Children.toArray(node.props.children).some((child) =>
        React.isValidElement<{ className?: string; children?: ReactNode }>(child)
          && child.props.className === 'workspace-tab-label' && child.props.children === label)) {
      node.props.onClick?.(); return true;
    }
    return visit(node.props.children);
  };
  expect(visit(props(WorkspaceHeader).navigation)).toBe(true);
  commit();
}
function chooseDisplay(label: string): void {
  const visit = (node: ReactNode): boolean => {
    if (Array.isArray(node)) return node.some(visit);
    if (!React.isValidElement<{ children?: ReactNode; onClick?: () => void; 'aria-pressed'?: boolean }>(node)) return false;
    if (node.type === 'button' && node.props.children === label && node.props['aria-pressed'] !== undefined) {
      node.props.onClick?.(); return true;
    }
    return visit(node.props.children);
  };
  expect(visit(tree)).toBe(true);
  commit();
}
const visibleValues = (): string[] => {
  const table = props(RecordTable);
  return table.columns.map((column) => getColumnText(table.rows[0]!, column.id));
};

describe('App column presentation and projection boundary', () => {
  it('registers the window message listener once across state commits', () => {
    const addListener = vi.spyOn(browser, 'addEventListener');
    commit();
    expect(addListener.mock.calls.filter(([type]) => type === 'message')).toHaveLength(1);

    deliverBroadcast('NAVIGATOR_VISIBILITY', { visible: true });
    expect(addListener.mock.calls.filter(([type]) => type === 'message')).toHaveLength(1);
    addListener.mockRestore();
  });

  it('uses committed splitter options and cancels the drag when its separator detaches', () => {
    boot();
    props(RecordTable).onSelect(props(RecordTable).rows[0]!.ref);
    commit();

    type SplitterProps = {
      ref: (instance: HTMLDivElement | null) => void;
      onPointerDown(event: { button: number; pointerId: number; clientX: number; currentTarget: {
        setPointerCapture(pointerId: number): void;
        releasePointerCapture(pointerId: number): void;
      } }): void;
      onKeyDown(event: { key: string; shiftKey: boolean; preventDefault(): void }): void;
    };
    const splitter = (): SplitterProps => {
      const found = elementByClassName('detail-splitter');
      if (found === undefined) throw new Error('Detail splitter missing');
      return found.props as SplitterProps;
    };
    const current = splitter();
    const preventDefault = vi.fn();
    current.onKeyDown({ key: 'ArrowLeft', shiftKey: false, preventDefault });
    commit();
    current.onKeyDown({ key: 'ArrowLeft', shiftKey: false, preventDefault });
    commit();
    const workspace = elementByClassName('workspace')?.props as { style?: Record<string, string> } | undefined;
    expect(workspace?.style?.['--detail-pane-width']).toBe('512px');

    const separator = { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() };
    const latest = splitter();
    latest.onPointerDown({ button: 0, pointerId: 7, clientX: 100, currentTarget: separator });
    expect(bodyClasses.has('is-resizing-detail')).toBe(true);
    latest.ref({} as HTMLDivElement);
    latest.ref(null);
    expect(separator.releasePointerCapture).toHaveBeenCalledWith(7);
    expect(bodyClasses.has('is-resizing-detail')).toBe(false);

    browser.dispatchEvent(Object.assign(new Event('pointermove'), { pointerId: 7, clientX: 50 }));
    commit();
    const afterDetach = elementByClassName('workspace')?.props as { style?: Record<string, string> } | undefined;
    expect(afterDetach?.style?.['--detail-pane-width']).toBe('512px');
  });

  it('correlates the Navigator button with the Host status response', () => {
    boot();
    props(RecordTable).onSelect(page([status]).rows[0]!.ref);
    commit();
    props(WorkspaceHeader).onOpenNavigator();
    const request = last('OPEN_SESSION_NAVIGATOR');
    expect(request.requestId).toBeTruthy();
    deliver('NAVIGATOR_STATUS', {
      version: 1,
      status: 'opened',
      enabled: 'enabled',
      authorization: 'granted',
      authorizationReadback: 'confirmed',
      action: 'focus-sessions',
      sourceId: 'source-1',
      targetDocumentId: 'doc',
    }, request);
  });

  it('tracks host Navigator visibility and gives compact tabs explicit accessible names', () => {
    commit();
    const header = (): Record<string, unknown> => props(WorkspaceHeader) as unknown as Record<string, unknown>;
    expect(header().navigatorVisible).toBe(false);
    deliver('OPENED', summary, last('READY'));

    deliverBroadcast('NAVIGATOR_VISIBILITY', { visible: true });
    expect(header().navigatorVisible).toBe(true);

    const navigation = header().navigation as ReactElement<{ children?: ReactNode }>;
    const tabs = React.Children.toArray(navigation.props.children) as Array<ReactElement<{
      'aria-label'?: string; children?: ReactNode;
    }>>;
    expect(tabs[0]?.props['aria-label']).toBe('Table');
    expect(React.Children.toArray(tabs[0]?.props.children).some((child) =>
      React.isValidElement<{ className?: string }>(child) && child.props.className === 'workspace-tab-label')).toBe(true);
  });

  it('shows Rebuild only while the displayed snapshot is invalidated', () => {
    commit();
    const rebuildAvailable = (): boolean => Boolean(props(WorkspaceHeader).rebuildAvailable);
    expect(rebuildAvailable()).toBe(false);

    deliver('OPENED', summary, last('READY'));
    expect(rebuildAvailable()).toBe(false);

    deliverBroadcast('SOURCE_INVALIDATED', { reason: 'append' });
    expect(rebuildAvailable()).toBe(true);
  });

  it('shows only current-page dataset observations and hides them during a new page request', () => {
    commit();
    deliver('OPENED', { ...summary, profileVersion: '1' }, last('READY'));
    const first = page([prompt]);
    first.rows.forEach((row) => { row.dataset = summarizeDatasetRecord({ question: 'q', answer: 'a' }); });
    deliver('ROWS', first, last('GET_ROWS'));
    chooseWorkspaceTab('Insights');
    expect(props(DatasetInsights).summary).toMatchObject({ scope: 'visible-page', scenes: { qa: 20 } });
    props(InsightsToolbar).onRefresh(); commit();
    deliver('ERROR', { code: 'REQUEST_FAILED', message: 'Synthetic aggregate failure', recoverable: true }, last('GET_INSIGHTS'));
    expect(props(DatasetInsights).summary.scenes).toEqual({ qa: 20 });
    chooseWorkspaceTab('Table');
    props(RecordPager).onNext(); commit();
    chooseWorkspaceTab('Insights');
    expect(() => props(DatasetInsights)).toThrow('App child missing');
    const next = page([prompt], 20);
    next.rows.forEach((row) => { row.dataset = summarizeDatasetRecord({ text: 'Training text' }); });
    deliver('ROWS', next, last('GET_ROWS'));
    expect(props(DatasetInsights).summary.scenes).toEqual({ pretraining: 20 });
  });

  it('renders only BFCL-specific insights and controls for recognized BFCL rows', () => {
    commit();
    deliver('OPENED', { ...summary, profileId: 'generic', profileVersion: '1' }, last('READY'));
    const first = { ...page([prompt]), projection: { conversation: false, dataset: true } };
    first.rows.forEach((row) => {
      row.datasetInsights = { bfclV3: summarizeBfclV3Record({
        id: 'simple_1', multi_turn: false, functions: '[]', tools: '[]', turns: '[]',
        language: 'Python', test_category: 'simple', subset: 'simple', ground_truth: '{}',
      }) };
    });
    deliver('ROWS', first, last('GET_ROWS'));
    chooseWorkspaceTab('Insights');
    expect(props(BfclInsights).summary.coverage).toMatchObject({ requestedRecords: 20, sampledRecords: 20, recognizedRecords: 20 });
    expect(elementByClassName('bfcl-insights-scroll')).toBeDefined();
    expect(() => props(DatasetInsights)).toThrow('App child missing');
    expect(() => props(InsightsView)).toThrow('App child missing');
    expect(() => props(InsightsToolbar)).toThrow('App child missing');

    chooseWorkspaceTab('Table');
    props(RecordPager).onNext();
    commit();
    const nextPageRequest = last('GET_ROWS');
    chooseWorkspaceTab('Insights');
    expect(elementByClassName('insights-transition-status')).toBeDefined();
    expect(() => props(BfclInsights)).toThrow('App child missing');
    expect(() => props(InsightsView)).toThrow('App child missing');
    expect(() => props(InsightsToolbar)).toThrow('App child missing');

    deliver('ERROR', { code: 'REQUEST_FAILED', message: 'Synthetic page failure', recoverable: true }, nextPageRequest);
    const failedStatus = elementByClassName('insights-transition-status');
    expect(failedStatus).toBeDefined();
    expect(() => props(BfclInsights)).toThrow('App child missing');
    expect(() => props(DatasetInsights)).toThrow('App child missing');
    const failedStatusChildren = (failedStatus?.props as { children?: ReactNode } | undefined)?.children;
    expect(buttonWithin(failedStatusChildren, 'Retry')).toBeDefined();

    chooseWorkspaceTab('Table');
    props(RecordPager).onInputChange('4');
    props(RecordPager).onJump();
    commit();
    const pagedRequest = last('GET_ROWS');
    expect(pagedRequest.payload.anchorOrdinal).not.toBe(nextPageRequest.payload.anchorOrdinal);
    props(TopQueryStudio).onCancel();
    commit();
    chooseWorkspaceTab('Insights');
    expect(elementByClassName('insights-transition-status')).toBeUndefined();
    expect(props(BfclInsights).summary.coverage.sampledRecords).toBe(20);

    chooseWorkspaceTab('Table');
    props(RecordQueryControls).onSearchChange('newer query');
    props(RecordQueryControls).onSearchSubmit();
    commit();
    const newerRequest = last('GET_ROWS');
    expect(newerRequest.payload.predicate).toEqual({ op: 'text_search', value: 'newer query', caseSensitive: false });

    chooseWorkspaceTab('Insights');
    const pendingStatus = elementByClassName('insights-transition-status');
    expect(pendingStatus).toBeDefined();
    expect(buttonWithin((pendingStatus?.props as { children?: ReactNode } | undefined)?.children, 'Retry')).toBeUndefined();
    expect(() => props(BfclInsights)).toThrow('App child missing');

    deliver('ERROR', { code: 'REQUEST_FAILED', message: 'Synthetic newer query failure', recoverable: true }, newerRequest);
    const newerFailedStatus = elementByClassName('insights-transition-status');
    const newerFailedStatusChildren = (newerFailedStatus?.props as { children?: ReactNode } | undefined)?.children;
    const retry = buttonWithin(newerFailedStatusChildren, 'Retry');
    expect(retry).toBeDefined();
    retry?.props.onClick?.();
    commit();
    const retriedPage = last('GET_ROWS');
    expect(retriedPage.payload.projection).toEqual({ conversation: false, dataset: true });
    expect(retriedPage.payload.predicate).toEqual(newerRequest.payload.predicate);
    expect(retriedPage.payload.anchorOrdinal).toBe(newerRequest.payload.anchorOrdinal);
    expect(retriedPage.payload.direction).toBe(newerRequest.payload.direction);
    expect(retriedPage.payload.sortOffset).toBe(newerRequest.payload.sortOffset);
  });

  it('keeps generic dataset insights when a page only shares BFCL turns and ground truth fields', () => {
    commit();
    deliver('OPENED', { ...summary, profileId: 'generic', profileVersion: '1' }, last('READY'));
    const first = { ...page([prompt]), projection: { conversation: false, dataset: true } };
    first.rows.forEach((row) => { row.dataset = summarizeDatasetRecord({ question: 'q', answer: 'a' }); });
    deliver('ROWS', first, last('GET_ROWS'));
    chooseWorkspaceTab('Insights');
    expect(props(DatasetInsights).summary).toMatchObject({ scope: 'visible-page', scenes: { qa: 20 } });
    expect(() => props(BfclInsights)).toThrow('App child missing');
    expect(props(InsightsView)).toBeDefined();
    expect(props(InsightsToolbar)).toBeDefined();
  });

  it('reprojects the same logical page when Insights first needs dataset scenes', () => {
    commit();
    deliver('OPENED', { ...summary, profileVersion: '1' }, last('READY'));
    const first = { ...page([prompt]), projection: { conversation: false, dataset: false } };
    deliver('ROWS', first, last('GET_ROWS'));
    const initial = last('GET_ROWS');

    chooseWorkspaceTab('Insights');

    const projectionRequest = last('GET_ROWS');
    expect(projectionRequest.requestId).not.toBe(initial.requestId);
    expect(projectionRequest.payload.projection).toEqual({ conversation: false, dataset: true });
    expect(projectionRequest.payload).toMatchObject({ limit: initial.payload.limit });
    expect(projectionRequest.payload.anchorOrdinal).toBe(initial.payload.anchorOrdinal);
    expect(projectionRequest.payload.predicate).toEqual(initial.payload.predicate);
    expect(() => props(DatasetInsights)).toThrow('App child missing');
    expect(elementByClassName('insights-transition-status')).toBeDefined();
    expect(() => props(InsightsToolbar)).toThrow('App child missing');

    const projected = { ...page([prompt]), projection: { conversation: false, dataset: true } };
    projected.rows.forEach((row) => { row.dataset = summarizeDatasetRecord({ question: 'q', answer: 'a' }); });
    deliver('ROWS', projected, projectionRequest);
    expect(props(DatasetInsights).summary).toMatchObject({ scope: 'visible-page', scenes: { qa: 20 } });
  });

  it('does not present missing dataset scenes as empty and retries only after a new view intent', () => {
    commit();
    deliver('OPENED', { ...summary, profileVersion: '1' }, last('READY'));
    deliver('ROWS', { ...page([prompt]), projection: { conversation: false, dataset: false } }, last('GET_ROWS'));
    chooseWorkspaceTab('Insights');

    const failedProjectionRequest = last('GET_ROWS');
    const countAfterRequest = rowRequests().length;
    deliver('ERROR', { code: 'REQUEST_FAILED', message: 'Synthetic projection failure', recoverable: true }, failedProjectionRequest);

    expect(rowRequests()).toHaveLength(countAfterRequest);
    expect(() => props(DatasetInsights)).toThrow('App child missing');
    expect(elementByClassName('insights-transition-status')).toBeDefined();
    expect(() => props(InsightsToolbar)).toThrow('App child missing');

    const retryStatus = elementByClassName('insights-transition-status');
    const retryStatusChildren = (retryStatus?.props as { children?: ReactNode } | undefined)?.children;
    const retry = buttonWithin(retryStatusChildren, 'Retry');
    retry?.props.onClick?.();
    commit();
    expect(rowRequests()).toHaveLength(countAfterRequest + 1);
    expect(last('GET_ROWS').payload.projection).toEqual({ conversation: false, dataset: true });
    expect(last('GET_ROWS').payload.anchorOrdinal).toBe(failedProjectionRequest.payload.anchorOrdinal);
  });

  it('keeps legacy page capability bound to its profile when a profile refresh fails', () => {
    const providerSummary = { ...summary, profileId: 'kimi-code', profileVersion: '1', profileEpoch: 1 };
    commit();
    deliver('OPENED', providerSummary, last('READY'));
    deliver('ROWS', page([prompt]), last('GET_ROWS'));
    chooseWorkspaceTab('Insights');

    deliverBroadcast('PROFILE_CHANGED', {
      profileId: 'generic', profileVersion: '2', profileEpoch: 2, columns: [prompt],
    });
    let refreshed = last('GET_ROWS');
    expect(refreshed.payload.projection?.dataset).toBe(true);
    const requestCount = rowRequests().length;
    deliver('ERROR', { code: 'REQUEST_FAILED', message: 'Synthetic projection failure', recoverable: true }, refreshed);

    expect(rowRequests()).toHaveLength(requestCount);
    expect(() => props(DatasetInsights)).toThrow('App child missing');
    chooseWorkspaceTab('Table');
    chooseWorkspaceTab('Insights');
    expect(rowRequests()).toHaveLength(requestCount + 1);
  });

  it('keeps the supported table display while conversation projection is temporarily unavailable', () => {
    boot();
    props(RecordQueryControls).onSearchChange('keep');
    props(RecordQueryControls).onSearchSubmit();
    commit();
    deliver('ROWS', page([status, prompt]), last('GET_ROWS'));
    const rows = props(RecordTable).rows;
    props(RecordTable).onSelect(rows[3]!.ref);
    commit();
    const before = sent.length;
    expect(props(RecordTable).displayMode).toBe('table');
    const displayLabels: string[] = [];
    const visit = (node: ReactNode): void => {
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (!React.isValidElement<{ children?: ReactNode }>(node)) return;
      if (node.type === 'button' && typeof node.props.children === 'string') displayLabels.push(node.props.children);
      visit(node.props.children);
    };
    visit(tree);
    expect(displayLabels).not.toContain('Table');
    expect(displayLabels).not.toContain('Conversation');
    expect(props(RecordTable).rows).toBe(rows);
    expect(props(RecordTable).selectedOrdinal).toBe('3');
    expect(props(RecordQueryControls).query).toBe('keep');
    expect(props(RecordTable).selectedOrdinal).toBe('3');
    expect(sent.slice(before).filter((request) => request.type === 'GET_ROWS' || request.type === 'GET_DETAIL')).toEqual([]);
  });
  it('hides and restores projected field values locally without rerunning the active query', () => {
    boot();
    props(RecordQueryControls).onSearchChange('keep');
    props(RecordQueryControls).onSearchSubmit();
    commit();
    expect(last('GET_ROWS').payload.predicate).toBeDefined();
    deliver('ROWS', page([status, prompt]), last('GET_ROWS'));
    const before = rowRequests().length;
    const rows = props(RecordTable).rows;
    props(RecordTable).onSelect(rows[3]!.ref);
    commit();
    props(ColumnChooser).onVisibilityChange(prompt, false);
    commit();
    expect(visibleValues()).toEqual(['0', '$.status 0']);
    props(ColumnChooser).onVisibilityChange(prompt, true);
    commit();
    expect(visibleValues()).toEqual(['0', '$.status 0', '$.prompt 0']);
    expect(props(RecordTable).rows).toBe(rows);
    expect(props(RecordTable).selectedOrdinal).toBe('3');
    expect(props(RecordTable).loading).toBe(false);
    expect(rowRequests()).toHaveLength(before);
  });

  it('keeps rapid display toggles local while a descending next-page request is pending', () => {
    boot();
    props(RecordQueryControls).onSortDirectionChange('desc');
    commit();
    deliver('ROW_ORDER_CHANGED', { direction: 'desc' }, last('SET_ROW_ORDER'));
    deliver('ROWS', { ...page([status, prompt], 79, true), sort: { columnId: '__ordinal', direction: 'desc' },
      sortOffset: '0' }, last('GET_ROWS'));
    props(RecordPager).onNext();
    commit();
    const next = last('GET_ROWS');
    const before = rowRequests().length;
    const chooser = props(ColumnChooser);
    chooser.onVisibilityChange(prompt, false);
    chooser.onVisibilityChange(status, false);
    chooser.onVisibilityChange(prompt, true);
    commit();
    expect(rowRequests()).toHaveLength(before);
    expect(sent.some((request) => request.type === 'CANCEL' && request.payload.targetRequestId === next.requestId)).toBe(false);
    deliver('ROWS', { ...page([status, prompt], 59, true), sort: { columnId: '__ordinal', direction: 'desc' },
      sortOffset: '20' }, next);
    expect(visibleValues()).toEqual(['59', '$.prompt 59']);
    expect(props(RecordPager).pageInput).toBe('2');
    props(RecordPager).onPrevious();
    commit();
    expect(last('GET_ROWS').payload).toMatchObject({ anchorOrdinal: '59', direction: 'forward',
      sort: { columnId: '__ordinal', direction: 'desc' } });
    expect(last('GET_ROWS').payload.columns?.map((column) => column.id)).toEqual([prompt.id]);
  });

  it('restores a column hidden when an in-flight page projection was requested', () => {
    boot();
    props(ColumnChooser).onVisibilityChange(prompt, false);
    commit();
    props(RecordPager).onNext();
    commit();
    const next = last('GET_ROWS');
    expect(next.payload.columns?.map((column) => column.id)).toEqual([status.id]);
    const before = rowRequests().length;
    props(ColumnChooser).onVisibilityChange(prompt, true);
    commit();
    expect(rowRequests()).toHaveLength(before);
    deliver('ROWS', page([status], 20), next);
    const refresh = last('GET_ROWS');
    expect(refresh.requestId).not.toBe(next.requestId);
    expect(rowRequests()).toHaveLength(before + 1);
    expect(refresh.payload).toMatchObject({ anchorOrdinal: '19', direction: 'forward' });
    expect(refresh.payload.columns?.map((column) => column.id)).toEqual([status.id, prompt.id]);
    expect(props(RecordPager).pageInput).toBe('2');
    deliver('ROWS', page([status], 20), next);
    expect(rowRequests()).toHaveLength(before + 1);
    expect(props(RecordPager).pageInput).toBe('2');
    deliver('ROWS', page([status, prompt], 20), refresh);
    expect(visibleValues()).toEqual(['20', '$.status 20', '$.prompt 20']);
    expect(props(RecordPager).pageInput).toBe('2');
    expect(props(RecordTable).loading).toBe(false);
  });

  it('refreshes a missing field and preserves the active query and viewport', () => {
    boot();
    deliver('SCHEMA', { fields: [{ path: extra.path!, displayPath: '$.extra', seenRecords: '80',
      validRecordsObserved: '80', kinds: { string: '80' }, missingRecords: '0', nullRecords: '0',
      examples: ['extra 0'], firstSeenOrdinal: '0', lastSeenOrdinal: '79', confidence: 'sampled' }],
    totalFields: 1, complete: true }, last('GET_SCHEMA'));
    expect(props(ColumnChooser).columns.some((column) => column.id === extra.id)).toBe(true);
    props(RecordQueryControls).onSearchChange('keep');
    props(RecordQueryControls).onSearchSubmit();
    commit();
    deliver('ROWS', page([status, prompt]), last('GET_ROWS'));
    props(RecordPager).onNext();
    commit();
    deliver('ROWS', page([status, prompt], 20), last('GET_ROWS'));
    const prior = last('GET_ROWS');
    const before = rowRequests().length;
    props(ColumnChooser).onVisibilityChange(extra, true);
    commit();
    const refresh = last('GET_ROWS');
    expect(rowRequests()).toHaveLength(before + 1);
    expect(refresh.payload.predicate).toEqual(prior.payload.predicate);
    expect(refresh.payload.anchorOrdinal).toBe('19');
    expect(refresh.payload.direction).toBe('forward');
    expect(refresh.payload.scanBudget?.maxExaminedRecords).toBe(prior.payload.scanBudget?.maxExaminedRecords);
    expect(refresh.payload.columns?.map((column) => column.id)).toEqual([status.id, prompt.id, extra.id]);
    deliver('ROWS', page([status, prompt, extra], 20), refresh);
    expect(visibleValues()).toEqual(['20', '$.status 20', '$.prompt 20', '$.extra 20']);
  });

  it('refreshes when hiding a projected field promotes a configured overflow field', () => {
    const columns = Array.from({ length: MAX_TABLE_COLUMNS }, (_, index) => recordColumn(`field${index}`));
    const overflow = recordColumn('overflow');
    persisted = { columnVisibility: Object.fromEntries([...columns, overflow].map((column) => [column.id, true])) };
    boot(columns);
    expect(props(ColumnChooser).selectedRecordIds.has(overflow.id)).toBe(true);
    expect(props(RecordTable).columns.filter((column) => column.source === 'record')).toHaveLength(MAX_TABLE_COLUMNS);
    const before = rowRequests().length;
    props(ColumnChooser).onVisibilityChange(columns[0]!, false);
    commit();
    expect(rowRequests()).toHaveLength(before + 1);
    const refresh = last('GET_ROWS');
    expect(refresh.payload.columns).toHaveLength(MAX_TABLE_COLUMNS);
    expect(refresh.payload.columns?.some((column) => column.id === overflow.id)).toBe(true);
    expect(refresh.payload.columns?.some((column) => column.id === columns[0]!.id)).toBe(false);
    deliver('ROWS', page([...columns.slice(1), overflow]), refresh);
    expect(visibleValues()).toContain('$.overflow 0');
  });
});
