import { useEffect, type RefObject } from 'react';

const menus = new Map<HTMLDetailsElement, number>();
let openSequence = 0;

function dismissOutside(event: Event): void {
  const target = event.target;
  if (!(target instanceof Node)) {
    return;
  }

  for (const menu of menus.keys()) {
    if (menu.open && !menu.contains(target)) {
      menu.open = false;
    }
  }
}

function dismissOnEscape(event: KeyboardEvent): void {
  if (event.key !== 'Escape') {
    return;
  }

  const openMenus = [...menus.entries()].filter(([menu]) => menu.open);
  if (openMenus.length === 0) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  const focusMenu = openMenus.find(([menu]) => menu.contains(document.activeElement))?.[0]
    ?? openMenus.sort((left, right) => right[1] - left[1])[0]?.[0];
  for (const [menu] of openMenus) {
    menu.open = false;
  }
  focusMenu?.querySelector<HTMLElement>(':scope > summary')?.focus();
}

function registerMenu(menu: HTMLDetailsElement): () => void {
  const onToggle = (): void => {
    if (menu.open) {
      menus.set(menu, ++openSequence);
      for (const other of menus.keys()) {
        if (other !== menu && other.open) {
          other.open = false;
        }
      }
    }
  };

  if (menus.size === 0) {
    document.addEventListener('pointerdown', dismissOutside, true);
    document.addEventListener('focusin', dismissOutside, true);
    document.addEventListener('keydown', dismissOnEscape, true);
  }
  menus.set(menu, menu.open ? ++openSequence : 0);
  menu.addEventListener('toggle', onToggle);

  return () => {
    menu.removeEventListener('toggle', onToggle);
    menus.delete(menu);
    if (menus.size === 0) {
      document.removeEventListener('pointerdown', dismissOutside, true);
      document.removeEventListener('focusin', dismissOutside, true);
      document.removeEventListener('keydown', dismissOnEscape, true);
    }
  };
}

export function useLightDismiss(ref: RefObject<HTMLDetailsElement | null>): void {
  useEffect(() => {
    const menu = ref.current;
    return menu ? registerMenu(menu) : undefined;
  }, [ref]);
}
