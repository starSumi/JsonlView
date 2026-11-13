import { useEffect, useRef, useState, type ButtonHTMLAttributes, type HTMLAttributes, type Ref } from 'react';

export function nextTabId<Id extends string>(ids: readonly Id[], currentId: Id, key: string): Id | undefined {
  if (ids.length === 0) return undefined;
  const index = Math.max(0, ids.indexOf(currentId));
  if (key === 'ArrowLeft') return ids[(index + ids.length - 1) % ids.length];
  if (key === 'ArrowRight') return ids[(index + 1) % ids.length];
  if (key === 'Home') return ids[0];
  if (key === 'End') return ids.at(-1);
  return undefined;
}

export function useManualTabs<Id extends string>({ ids, activeId, onActivate, idPrefix }: {
  ids: readonly Id[];
  activeId: Id;
  onActivate: (id: Id) => void;
  idPrefix: string;
}): {
  tabListProps: HTMLAttributes<HTMLElement>;
  getTabProps: (id: Id) => ButtonHTMLAttributes<HTMLButtonElement> & { ref: Ref<HTMLButtonElement> };
  getPanelProps: (id: Id) => HTMLAttributes<HTMLElement>;
} {
  const [focusedId, setFocusedId] = useState(activeId);
  const buttons = useRef(new Map<Id, HTMLButtonElement>());
  const focusId = ids.includes(focusedId) ? focusedId : activeId;
  useEffect(() => { setFocusedId(activeId); }, [activeId]);
  return {
    tabListProps: {
      role: 'tablist',
      'aria-orientation': 'horizontal',
      onBlur: (event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusedId(activeId);
      },
    },
    getTabProps: (id) => ({
      role: 'tab',
      id: `${idPrefix}-tab-${id}`,
      'aria-controls': `${idPrefix}-panel-${id}`,
      'aria-selected': activeId === id,
      tabIndex: focusId === id ? 0 : -1,
      ref: (button) => {
        if (button) buttons.current.set(id, button);
        else buttons.current.delete(id);
      },
      onFocus: () => setFocusedId(id),
      onClick: () => { setFocusedId(id); onActivate(id); },
      onKeyDown: (event) => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        const next = nextTabId(ids, id, event.key);
        if (next) {
          event.preventDefault();
          setFocusedId(next);
          buttons.current.get(next)?.focus();
        } else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onActivate(id);
        }
      },
    }),
    getPanelProps: (id) => ({
      role: 'tabpanel',
      id: `${idPrefix}-panel-${id}`,
      'aria-labelledby': `${idPrefix}-tab-${id}`,
      hidden: activeId !== id,
      tabIndex: 0,
    }),
  };
}
