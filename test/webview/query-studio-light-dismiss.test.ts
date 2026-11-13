import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

type Cleanup = (() => void) | undefined;
const hook = vi.hoisted(() => ({ setup: undefined as (() => Cleanup) | undefined }));

vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useEffect: (setup: () => Cleanup): void => { hook.setup = setup; },
}));

import { useQueryStudioLightDismiss } from '../../src/webview/features/record-query/use-query-studio-light-dismiss';

class FakeNode {
  children: FakeNode[] = [];
  constructor(public readonly id: string) {}
  append(child: FakeNode): void { this.children.push(child); }
  contains(node: FakeNode | null): boolean {
    return node === this || this.children.some((child) => child.contains(node));
  }
}

const fakeDocument = {
  handlers: new Map<string, (event: Event) => void>(),
  addEventListener(type: string, handler: (event: Event) => void): void { this.handlers.set(type, handler); },
  removeEventListener(type: string): void { this.handlers.delete(type); },
};

interface HarnessProps {
  open: boolean;
  pinned: boolean;
  studio: FakeNode;
  toggle: FakeNode;
  onDismiss: () => void;
}

function HookHarness({ open, pinned, studio, toggle, onDismiss }: HarnessProps): null {
  useQueryStudioLightDismiss(
    { current: studio as unknown as HTMLElement },
    { current: toggle as unknown as HTMLElement },
    open && !pinned,
    onDismiss,
  );
  return null;
}

function mount(open: boolean, pinned: boolean, studio: FakeNode, toggle: FakeNode, onDismiss: () => void): () => void {
  hook.setup = undefined;
  renderToStaticMarkup(createElement(HookHarness, { open, pinned, studio, toggle, onDismiss }));
  const setup = hook.setup as unknown as (() => Cleanup) | undefined;
  const cleanup = setup === undefined ? undefined : setup();
  return cleanup ?? (() => undefined);
}

beforeEach(() => {
  fakeDocument.handlers.clear();
  vi.stubGlobal('Node', FakeNode);
  vi.stubGlobal('document', fakeDocument);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('Query Studio light dismissal', () => {
  it('closes on outside pointer and focus while keeping the toggle and studio inside', () => {
    const studio = new FakeNode('studio');
    const toggle = new FakeNode('toggle');
    const inside = new FakeNode('inside');
    studio.append(inside);
    const outside = new FakeNode('outside');
    const onDismiss = vi.fn();
    const cleanup = mount(true, false, studio, toggle, onDismiss);

    fakeDocument.handlers.get('pointerdown')?.({ target: inside } as unknown as Event);
    fakeDocument.handlers.get('focusin')?.({ target: toggle } as unknown as Event);
    expect(onDismiss).not.toHaveBeenCalled();
    fakeDocument.handlers.get('pointerdown')?.({ target: outside } as unknown as Event);
    fakeDocument.handlers.get('focusin')?.({ target: outside } as unknown as Event);
    expect(onDismiss).toHaveBeenCalledTimes(2);

    cleanup();
    expect(fakeDocument.handlers.size).toBe(0);
  });

  it('does not install dismissal while closed or pinned', () => {
    const onDismiss = vi.fn();
    const closedCleanup = mount(false, false, new FakeNode('studio'), new FakeNode('toggle'), onDismiss);
    expect(fakeDocument.handlers.size).toBe(0);
    closedCleanup();

    const pinnedCleanup = mount(true, true, new FakeNode('studio'), new FakeNode('toggle'), onDismiss);
    expect(fakeDocument.handlers.size).toBe(0);
    pinnedCleanup();
  });
});
