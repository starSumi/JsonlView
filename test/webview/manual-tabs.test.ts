import type React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { nextTabId, useManualTabs } from '../../src/webview/use-manual-tabs';
import { modalTabTarget } from '../../src/webview/use-modal-focus';

vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useEffect: vi.fn(),
  useState: <Value>(initial: Value) => [initial, vi.fn()],
  useRef: <Value>(current: Value) => ({ current }),
}));

describe('manual tab navigation contract', () => {
  const ids = ['tree', 'raw', 'bytes'] as const;
  it('wraps horizontal focus and supports Home and End without activation', () => {
    expect(nextTabId(ids, 'tree', 'ArrowLeft')).toBe('bytes');
    expect(nextTabId(ids, 'bytes', 'ArrowRight')).toBe('tree');
    expect(nextTabId(ids, 'raw', 'Home')).toBe('tree');
    expect(nextTabId(ids, 'raw', 'End')).toBe('bytes');
    expect(nextTabId(ids, 'raw', 'ArrowDown')).toBeUndefined();
    expect(nextTabId([], 'raw', 'Home')).toBeUndefined();
  });

  it('connects every tab and panel and initially exposes one tab stop', () => {
    const tabs = useManualTabs({ ids, activeId: 'raw', onActivate: vi.fn(), idPrefix: 'detail' });
    expect(ids.map((id) => tabs.getTabProps(id).tabIndex)).toEqual([-1, 0, -1]);
    for (const id of ids) {
      const tab = tabs.getTabProps(id);
      const panel = tabs.getPanelProps(id);
      expect(tab['aria-controls']).toBe(panel.id);
      expect(panel['aria-labelledby']).toBe(tab.id);
      expect(panel.hidden).toBe(id !== 'raw');
    }
  });

  it('arrow handlers request focus only and Enter or Space explicitly activates', () => {
    const activate = vi.fn();
    const focus = vi.fn();
    const tabs = useManualTabs({ ids, activeId: 'tree', onActivate: activate, idPrefix: 'detail' });
    const raw = tabs.getTabProps('raw');
    (raw.ref as (button: HTMLButtonElement) => void)({ focus } as unknown as HTMLButtonElement);
    const press = (key: string): void => {
      tabs.getTabProps('tree').onKeyDown?.({ key, preventDefault: vi.fn() } as unknown as React.KeyboardEvent<HTMLButtonElement>);
    };
    press('ArrowRight');
    expect(focus).toHaveBeenCalledOnce();
    expect(activate).not.toHaveBeenCalled();
    press('Enter');
    press(' ');
    expect(activate.mock.calls).toEqual([['tree'], ['tree']]);
  });
});

describe('modal tab boundary decisions', () => {
  it('wraps both ends and enters from a static title or unexpected focus', () => {
    expect(modalTabTarget(2, 3, false)).toBe(0);
    expect(modalTabTarget(0, 3, true)).toBe(2);
    expect(modalTabTarget(-1, 3, false)).toBe(0);
    expect(modalTabTarget(-1, 3, true)).toBe(2);
    expect(modalTabTarget(1, 3, false)).toBeUndefined();
    expect(modalTabTarget(-1, 0, false)).toBe(-1);
  });
});
