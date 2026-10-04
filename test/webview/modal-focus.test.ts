import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useModalFocus } from '../../src/webview/use-modal-focus';

type Cleanup = (() => void) | void;
const hooks = vi.hoisted(() => ({
  refs: [] as { current: unknown }[],
  refIndex: 0,
  previousDeps: undefined as readonly unknown[] | undefined,
  pendingEffect: undefined as (() => Cleanup) | undefined,
}));

vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useRef: <T,>(initial: T): { current: T } => {
    const index = hooks.refIndex++;
    hooks.refs[index] ??= { current: initial };
    return hooks.refs[index] as { current: T };
  },
  useLayoutEffect: (setup: () => Cleanup, deps: readonly unknown[]): void => {
    if (!hooks.previousDeps || deps.some((value, index) => value !== hooks.previousDeps?.[index])) {
      hooks.pendingEffect = setup;
      hooks.previousDeps = deps;
    }
  },
}));

// This adapter executes the actual hook's layout setup and cleanup decisions.
// Browser focus, native Tab and React's commit scheduling require installed-host evidence.
function fixture() {
  const doc = {
    body: undefined as unknown as Element,
    activeElement: undefined as unknown as Element,
    handlers: new Map<string, (event: { target: Element }) => void>(),
    addEventListener(type: string, handler: (event: { target: Element }) => void): void { this.handlers.set(type, handler); },
    removeEventListener(type: string): void { this.handlers.delete(type); },
    querySelector(): Element | null { return tab.isConnected ? tab : grid.isConnected ? grid : null; },
  };

  class Element {
    children: Element[] = [];
    attributes = new Map<string, string>();
    disabled = false;
    tabIndex = 0;

    constructor(readonly id: string, public parentElement: Element | null = null) {
      parentElement?.children.push(this);
    }
    get isConnected(): boolean { return this === doc.body || this.parentElement?.isConnected === true; }
    getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
    setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
    removeAttribute(name: string): void { this.attributes.delete(name); }
    matches(selector: string): boolean { return selector === ':disabled' && this.disabled; }
    closest(): Element | null {
      return this.attributes.has('hidden') || this.attributes.has('inert') ? this : this.parentElement?.closest() ?? null;
    }
    contains(element: Element | undefined): boolean { return element === this || this.children.some(child => child.contains(element)); }
    getClientRects(): object[] { return this.isConnected && !this.closest() ? [{}] : []; }
    addEventListener(): void { /* No keyboard behavior is simulated. */ }
    removeEventListener(): void { /* No keyboard behavior is simulated. */ }
    focus(): void {
      if (!this.isConnected || this.closest()) return;
      doc.activeElement = this;
      doc.handlers.get('focusin')?.({ target: this });
    }
    remove(): void {
      const hadFocus = this.contains(doc.activeElement);
      if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
      this.parentElement = null;
      if (hadFocus) doc.activeElement = doc.body;
    }
  }

  const body = new Element('body'); doc.body = body; doc.activeElement = body;
  const app = new Element('app', body);
  const header = new Element('header', app);
  const tab = new Element('selected-workspace-tab', app);
  const grid = new Element('grid', app);
  const dialog = new Element('dialog', app);
  const title = new Element('title', dialog);
  const detailButton = new Element('detail-tab', dialog);
  const dialogRef = { current: dialog as unknown as HTMLElement };
  const initialFocusRef = { current: title as unknown as HTMLElement };
  let cleanup: Cleanup;

  vi.stubGlobal('document', doc);
  vi.stubGlobal('HTMLElement', Element);
  vi.stubGlobal('Node', Element);
  vi.stubGlobal('MutationObserver', undefined);

  function render(modal: boolean): void {
    hooks.refIndex = 0; hooks.pendingEffect = undefined;
    useModalFocus({ modal, dialogRef, initialFocusRef, onClose: () => undefined });
    const pendingEffect = hooks.pendingEffect as (() => Cleanup) | undefined;
    if (pendingEffect) {
      cleanup?.();
      cleanup = pendingEffect();
    }
  }

  function closeBeforeRemoval(): string {
    cleanup?.(); cleanup = undefined;
    const beforeRemoval = doc.activeElement.id;
    dialog.remove();
    return beforeRemoval;
  }

  return { doc, header, tab, grid, dialog, title, detailButton, render, closeBeforeRemoval };
}

beforeEach(() => {
  hooks.refs = []; hooks.refIndex = 0; hooks.previousDeps = undefined; hooks.pendingEffect = undefined;
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('modal focus return during layout cleanup', () => {
  it('returns to an external grid opener before dialog removal and restores prior inert attributes', () => {
    const ui = fixture(); ui.header.setAttribute('inert', 'preexisting-owner');
    ui.grid.focus(); ui.render(true);
    expect(ui.doc.activeElement).toBe(ui.title);
    expect(ui.grid.getAttribute('inert')).toBe('');
    expect(ui.closeBeforeRemoval()).toBe('grid');
    expect(ui.doc.activeElement).toBe(ui.grid);
    expect(ui.header.getAttribute('inert')).toBe('preexisting-owner');
    expect(ui.tab.getAttribute('inert')).toBeNull();
  });

  it('uses the visible workspace fallback when a wide detail descendant becomes the modal opener', () => {
    const ui = fixture(); ui.render(false); ui.detailButton.focus(); ui.render(true);
    expect(ui.doc.activeElement).toBe(ui.title);
    expect(ui.dialog.isConnected).toBe(true);
    expect(ui.closeBeforeRemoval()).toBe('selected-workspace-tab');
    expect(ui.doc.activeElement).toBe(ui.tab);
  });

  it('rejects the dialog itself as a closing focus target while it is still connected', () => {
    const ui = fixture(); ui.render(false); ui.dialog.focus(); ui.render(true);
    expect(ui.closeBeforeRemoval()).toBe('selected-workspace-tab');
    expect(ui.doc.activeElement).toBe(ui.tab);
  });

  it('uses the fallback when the original external opener has been removed', () => {
    const ui = fixture(); ui.grid.focus(); ui.render(true); ui.grid.remove();
    expect(ui.closeBeforeRemoval()).toBe('selected-workspace-tab');
    expect(ui.doc.activeElement).toBe(ui.tab);
  });

  it('keeps current detail focus when the narrow dialog becomes a connected wide aside', () => {
    const ui = fixture(); ui.header.setAttribute('inert', 'preexisting-owner');
    ui.grid.focus(); ui.render(true); ui.detailButton.focus(); ui.render(false);
    expect(ui.dialog.isConnected).toBe(true);
    expect(ui.doc.activeElement).toBe(ui.detailButton);
    expect(ui.grid.getAttribute('inert')).toBeNull();
    expect(ui.header.getAttribute('inert')).toBe('preexisting-owner');
  });

  it('uses the fallback when the external opener becomes disabled before closing', () => {
    const ui = fixture(); ui.grid.focus(); ui.render(true); ui.grid.disabled = true;
    expect(ui.closeBeforeRemoval()).toBe('selected-workspace-tab');
    expect(ui.doc.activeElement).toBe(ui.tab);
  });
});
