import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

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

function mount(menu: FakeDetails): () => void {
  hook.setup = undefined;
  useLightDismiss({ current: menu as unknown as HTMLDetailsElement });
  const setup = hook.setup as unknown as (() => Cleanup) | undefined;
  const cleanup = setup ? setup() : undefined;
  return cleanup ?? (() => undefined);
}

beforeEach(() => {
  fakeDocument.handlers.clear();
  fakeDocument.activeElement = null;
  vi.stubGlobal('Node', FakeNode);
  vi.stubGlobal('document', fakeDocument);
});
afterEach(() => { vi.unstubAllGlobals(); });

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
});
