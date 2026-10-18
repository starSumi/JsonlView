import { describe, expect, it, vi } from 'vitest';
import {
  createDetailSplitterInteraction,
  type DetailSplitterInteractionOptions,
  type DetailSplitterInteractionTargets,
  type DetailSplitterPointerEventHost,
} from '../../src/webview/use-detail-splitter';

type PointerEventName = 'pointermove' | 'pointerup' | 'pointercancel';
type PointerListener = Parameters<DetailSplitterPointerEventHost['addEventListener']>[1];

class PointerHost implements DetailSplitterPointerEventHost {
  private readonly listeners = new Map<PointerEventName, Set<PointerListener>>();

  addEventListener(type: PointerEventName, listener: PointerListener): void {
    const listeners = this.listeners.get(type) ?? new Set<PointerListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: PointerEventName, listener: PointerListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: PointerEventName, clientX = 0): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener({ clientX });
  }

  count(type: PointerEventName): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

function fixture(overrides: Partial<DetailSplitterInteractionOptions> = {}) {
  const events: string[] = [];
  const widths: number[] = [];
  const pointerEvents = new PointerHost();
  const classes = new Set<string>();
  const options: DetailSplitterInteractionOptions = {
    readContainerWidth: () => 1000,
    readPointerStartWidth: () => 400,
    readKeyboardStartWidth: () => 400,
    setWidth: (width) => widths.push(width),
    pauseFollowing: () => events.push('pause'),
    ...overrides,
  };
  const targets: DetailSplitterInteractionTargets = {
    pointerEvents,
    bodyClassList: {
      add: (className) => { events.push('class:add'); classes.add(className); },
      remove: (className) => { events.push('class:remove'); classes.delete(className); },
    },
  };
  const interaction = createDetailSplitterInteraction(options, targets);
  return { events, widths, pointerEvents, classes, interaction };
}

function pointerDown(currentTarget: {
  setPointerCapture(pointerId: number): void;
  releasePointerCapture?(pointerId: number): void;
}, overrides: Partial<{ button: number; pointerId: number; clientX: number }> = {}) {
  return { button: 0, pointerId: 7, clientX: 100, currentTarget, ...overrides };
}

describe('detail splitter interactions', () => {
  it('resizes by pointer delta and cleans up listeners on pointerup', () => {
    const test = fixture();
    const splitter = { setPointerCapture: vi.fn() };
    test.interaction.onPointerDown(pointerDown(splitter));
    expect(splitter.setPointerCapture).toHaveBeenCalledWith(7);
    expect(test.classes.has('is-resizing-detail')).toBe(true);
    expect(test.events[0]).toBe('pause');

    test.pointerEvents.emit('pointermove', 80);
    expect(test.widths).toEqual([420]);
    test.pointerEvents.emit('pointerup');
    expect(test.classes.has('is-resizing-detail')).toBe(false);
    expect(test.pointerEvents.count('pointermove')).toBe(0);
    expect(test.pointerEvents.count('pointerup')).toBe(0);
    expect(test.pointerEvents.count('pointercancel')).toBe(0);
    test.pointerEvents.emit('pointermove', 60);
    expect(test.widths).toEqual([420]);
  });

  it('continues through window listeners when pointer capture fails', () => {
    const test = fixture();
    const splitter = { setPointerCapture: vi.fn(() => { throw new Error('capture unavailable'); }) };
    expect(() => test.interaction.onPointerDown(pointerDown(splitter))).not.toThrow();
    test.pointerEvents.emit('pointermove', 90);
    expect(test.widths).toEqual([410]);
    test.pointerEvents.emit('pointerup');
    expect(test.pointerEvents.count('pointermove')).toBe(0);
    expect(test.classes.has('is-resizing-detail')).toBe(false);
  });

  it('cleans up listeners and the resize class on pointercancel', () => {
    const test = fixture();
    test.interaction.onPointerDown(pointerDown({ setPointerCapture: vi.fn() }));
    test.pointerEvents.emit('pointercancel');
    expect(test.classes.has('is-resizing-detail')).toBe(false);
    expect(test.pointerEvents.count('pointermove')).toBe(0);
    expect(test.pointerEvents.count('pointerup')).toBe(0);
    expect(test.pointerEvents.count('pointercancel')).toBe(0);
  });

  it('releases capture and removes listeners when the owning hook unmounts', () => {
    const test = fixture();
    const splitter = { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() };
    test.interaction.onPointerDown(pointerDown(splitter));
    test.interaction.dispose();
    expect(splitter.releasePointerCapture).toHaveBeenCalledWith(7);
    expect(test.classes.has('is-resizing-detail')).toBe(false);
    expect(test.pointerEvents.count('pointermove')).toBe(0);
    expect(test.pointerEvents.count('pointerup')).toBe(0);
    expect(test.pointerEvents.count('pointercancel')).toBe(0);
  });

  it('keeps arrow, shifted arrow, Home and End keyboard behavior', () => {
    const test = fixture();
    const key = (value: string, shiftKey = false) => {
      const preventDefault = vi.fn();
      test.interaction.onKeyDown({ key: value, shiftKey, preventDefault });
      return preventDefault;
    };

    expect(key('ArrowLeft')).toHaveBeenCalledOnce();
    expect(test.widths.at(-1)).toBe(416);
    expect(key('ArrowRight', true)).toHaveBeenCalledOnce();
    expect(test.widths.at(-1)).toBe(336);
    expect(key('Home')).toHaveBeenCalledOnce();
    expect(test.widths.at(-1)).toBe(320);
    expect(key('End')).toHaveBeenCalledOnce();
    expect(test.widths.at(-1)).toBe(715);
    expect(test.events.filter((event) => event === 'pause')).toHaveLength(4);
    expect(key('Escape')).not.toHaveBeenCalled();
    expect(test.events.filter((event) => event === 'pause')).toHaveLength(4);
  });
});
