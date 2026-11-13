import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

type Cleanup = (() => void) | undefined;
const hook = vi.hoisted(() => ({ setup: undefined as (() => Cleanup) | undefined }));

vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useEffect: (setup: () => Cleanup): void => { hook.setup = setup; },
}));

import { useLightDismiss } from '../../src/webview/use-light-dismiss';

class FakeNode {
  constructor(public readonly id: string, public parent: FakeNode | undefined = undefined) {}
  contains(node: FakeNode | null): boolean {
    return node === this || (this.children ?? []).some((child) => child.contains(node));
  }
  children: FakeNode[] = [];
  append(child: FakeNode): void { child.parent = this; this.children.push(child); }
  focus(): void { fakeDocument.activeElement = this; }
}

class FakeDetails extends FakeNode {
  open = false;
  private readonly handlers = new Map<string, (event: Event) => void>();
  constructor(id: string) { super(id); this.append(this.summary); }
  addEventListener(type: string, handler: (event: Event) => void): void { this.handlers.set(type, handler); }
  removeEventListener(type: string): void { this.handlers.delete(type); }
  toggle(): void { this.handlers.get('toggle')?.(new Event('toggle')); }
  summary = new FakeNode(`${this.id}-summary`);
  querySelector<T extends FakeNode>(): T | null { return this.summary as T; }
}

const fakeDocument = {
  activeElement: null as FakeNode | null,
  handlers: new Map<string, (event: Event) => void>(),
  addEventListener(type: string, handler: (event: Event) => void): void { this.handlers.set(type, handler); },
  removeEventListener(type: string): void { this.handlers.delete(type); },
};
const cleanups = new Set<() => void>();

function MenuHarness({ menu }: { menu: FakeDetails }): null {
  useLightDismiss({ current: menu as unknown as HTMLDetailsElement });
  return null;
}

function mount(menu: FakeDetails): () => void {
  hook.setup = undefined;
  renderToStaticMarkup(createElement(MenuHarness, { menu }));
  const setup = hook.setup as unknown as (() => Cleanup) | undefined;
  const cleanup = setup ? setup() : undefined;
  const unmount = (): void => { cleanup?.(); cleanups.delete(unmount); };
  cleanups.add(unmount);
  return unmount;
}

beforeEach(() => {
  fakeDocument.handlers.clear();
  fakeDocument.activeElement = null;
  vi.stubGlobal('Node', FakeNode);
  vi.stubGlobal('document', fakeDocument);
});
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  vi.unstubAllGlobals();
});

describe('light dismiss behavior', () => {
  it('closes an open menu on outside pointer and focus events', () => {
    const menu = new FakeDetails('menu');
    const outside = new FakeNode('outside');
    const cleanup = mount(menu);
    menu.open = true;
    fakeDocument.handlers.get('pointerdown')?.({ target: outside } as unknown as Event);
    expect(menu.open).toBe(false);
    menu.open = true;
    fakeDocument.handlers.get('focusin')?.({ target: outside } as unknown as Event);
    expect(menu.open).toBe(false);
    cleanup();
    expect(fakeDocument.handlers.size).toBe(0);
  });

  it('keeps inside interactions open and closes all menus on Escape', () => {
    const menu = new FakeDetails('menu');
    const inside = new FakeNode('inside');
    menu.append(inside);
    const cleanup = mount(menu);
    menu.open = true;
    fakeDocument.handlers.get('pointerdown')?.({ target: inside } as unknown as Event);
    expect(menu.open).toBe(true);
    fakeDocument.activeElement = inside;
    const event = { key: 'Escape', preventDefault: vi.fn(), stopPropagation: vi.fn() };
    fakeDocument.handlers.get('keydown')?.(event as unknown as Event);
    expect(menu.open).toBe(false);
    expect(fakeDocument.activeElement).toBe(menu.summary);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    cleanup();
  });

  it('makes the newest opened menu exclusive and ignores unrelated keys', () => {
    const first = new FakeDetails('first');
    const second = new FakeDetails('second');
    const cleanupFirst = mount(first);
    const cleanupSecond = mount(second);
    first.open = true; first.toggle();
    second.open = true; second.toggle();
    expect(first.open).toBe(false);
    expect(second.open).toBe(true);
    const event = { key: 'Enter', preventDefault: vi.fn(), stopPropagation: vi.fn() };
    fakeDocument.handlers.get('keydown')?.(event as unknown as Event);
    expect(second.open).toBe(true);
    cleanupSecond(); cleanupFirst();
    expect(fakeDocument.handlers.size).toBe(0);
  });

  it.each(['ancestor-first', 'descendant-first'] as const)(
    'keeps nested disclosures open when toggle events arrive %s',
    (order) => {
      const more = new FakeDetails('more');
      const columns = new FakeDetails('columns');
      more.append(columns);
      mount(columns);
      mount(more);
      more.open = true;
      columns.open = true;

      const toggles = order === 'ancestor-first' ? [more, columns] : [columns, more];
      for (const menu of toggles) menu.toggle();

      expect(more.open).toBe(true);
      expect(columns.open).toBe(true);
    },
  );

  it('closes a sibling disclosure while keeping their shared ancestor open', () => {
    const more = new FakeDetails('more');
    const columns = new FakeDetails('columns');
    const sibling = new FakeDetails('sibling');
    more.append(columns);
    more.append(sibling);
    mount(more);
    mount(columns);
    mount(sibling);
    more.open = true;
    columns.open = true;

    sibling.open = true;
    sibling.toggle();

    expect(more.open).toBe(true);
    expect(columns.open).toBe(false);
    expect(sibling.open).toBe(true);
  });

  it('closes an entire nested chain when an unrelated menu opens', () => {
    const more = new FakeDetails('more');
    const columns = new FakeDetails('columns');
    const filters = new FakeDetails('filters');
    more.append(columns);
    mount(more);
    mount(columns);
    mount(filters);
    more.open = true;
    columns.open = true;

    filters.open = true;
    filters.toggle();

    expect(more.open).toBe(false);
    expect(columns.open).toBe(false);
    expect(filters.open).toBe(true);
  });

  it.each(['pointerdown', 'focusin'])(
    'dismisses only disclosures outside the %s target',
    (type) => {
      const more = new FakeDetails('more');
      const columns = new FakeDetails('columns');
      const insideColumns = new FakeNode('column-control');
      const outside = new FakeNode('outside');
      columns.append(insideColumns);
      more.append(columns);
      mount(more);
      mount(columns);
      more.open = true;
      columns.open = true;

      fakeDocument.handlers.get(type)?.({ target: insideColumns } as unknown as Event);
      expect(more.open).toBe(true);
      expect(columns.open).toBe(true);

      fakeDocument.handlers.get(type)?.({ target: more.summary } as unknown as Event);
      expect(more.open).toBe(true);
      expect(columns.open).toBe(false);

      columns.open = true;
      fakeDocument.handlers.get(type)?.({ target: outside } as unknown as Event);
      expect(more.open).toBe(false);
      expect(columns.open).toBe(false);
    },
  );

  it.each(['ancestor-first', 'descendant-first'] as const)(
    'closes a nested chain on Escape and restores visible focus with %s registration',
    (order) => {
      const more = new FakeDetails('more');
      const columns = new FakeDetails('columns');
      const insideColumns = new FakeNode('column-control');
      columns.append(insideColumns);
      more.append(columns);
      const registration = order === 'ancestor-first' ? [more, columns] : [columns, more];
      for (const menu of registration) mount(menu);
      more.open = true;
      columns.open = true;
      fakeDocument.activeElement = insideColumns;

      const event = { key: 'Escape', preventDefault: vi.fn(), stopPropagation: vi.fn() };
      fakeDocument.handlers.get('keydown')?.(event as unknown as Event);

      expect(more.open).toBe(false);
      expect(columns.open).toBe(false);
      expect(fakeDocument.activeElement).toBe(more.summary);
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(event.stopPropagation).toHaveBeenCalledOnce();
    },
  );
});
