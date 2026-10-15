import React, { type ComponentType, type ReactElement, type ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_TABLE_COLUMNS, PROTOCOL_VERSION, keyPath, type ColumnSpec, type DocumentSummary,
  type ExtensionMessage, type RowPage, type WebviewRequest } from '../../src/shared/types';
import { ColumnChooser, RecordPager, RecordQueryControls, RecordTable } from '../../src/webview/features/record-query';
import { getColumnText, recordColumnForPath } from '../../src/webview/format';
import type { PersistedWorkspaceState } from '../../src/webview/state';

type Effect = { deps?: readonly unknown[] | undefined; cleanup?: (() => void) | undefined };
const hooks = vi.hoisted(() => ({
  cursor: 0, dirty: false, slots: [] as unknown[], effects: [] as Array<() => void>,
}));

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
    return hooks.slots[index];
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
  const replacements = { useState, useReducer, useRef, useMemo, useEffect,
    useCallback: <Value,>(callback: Value, deps: readonly unknown[]) => useMemo(() => callback, deps) };
  return { ...react, ...replacements, default: { ...react, ...replacements } };
});

const sent: WebviewRequest[] = [];
let persisted: PersistedWorkspaceState | undefined;
let tree: ReactElement;
let App: () => React.JSX.Element;
let browser: EventTarget;

beforeAll(async () => {
  vi.stubGlobal('document', { body: { dataset: { documentId: 'doc', generation: 'bootstrap', pageSize: '20' } } });
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
  hooks.slots = []; hooks.effects = []; hooks.cursor = 0;
  sent.length = 0; persisted = undefined;
});
afterEach(() => {
  for (const slot of hooks.slots) (slot as Effect | undefined)?.cleanup?.();
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
    for (const run of hooks.effects.splice(0)) run();
  } while (hooks.dirty);
}

function props<Props,>(component: ComponentType<Props>): Props {
  const find = (node: ReactNode): Props | undefined => {
    if (Array.isArray(node)) {
      for (const child of node) { const found = find(child); if (found !== undefined) return found; }
    } else if (React.isValidElement<{ children?: ReactNode }>(node)) {
      if (node.type === component) return node.props as Props;
      return find(node.props.children);
    }
    return undefined;
  };
  const found = find(tree);
  if (found === undefined) throw new Error('App child missing');
  return found;
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
const visibleValues = (): string[] => {
  const table = props(RecordTable);
  return table.columns.map((column) => getColumnText(table.rows[0]!, column.id));
};

describe('App column presentation and projection boundary', () => {
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
