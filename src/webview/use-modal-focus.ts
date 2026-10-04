import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

export const NARROW_VIEWPORT_QUERY = '(max-width: 900px)';

export function useNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined'
    && (window.matchMedia?.(NARROW_VIEWPORT_QUERY).matches ?? window.innerWidth <= 900));
  useEffect(() => {
    const media = window.matchMedia?.(NARROW_VIEWPORT_QUERY);
    const update = (): void => { setNarrow(media?.matches ?? window.innerWidth <= 900); };
    update();
    if (media) media.addEventListener('change', update);
    else window.addEventListener('resize', update);
    return () => {
      if (media) media.removeEventListener('change', update);
      else window.removeEventListener('resize', update);
    };
  }, []);
  return narrow;
}

export function modalTabTarget(index: number, count: number, backwards: boolean): number | undefined {
  if (count === 0) return -1;
  if (index < 0) return backwards ? count - 1 : 0;
  if (backwards && index === 0) return count - 1;
  if (!backwards && index === count - 1) return 0;
  return undefined;
}

function makeBackgroundInert(dialog: HTMLElement): () => void {
  const previous = new Map<HTMLElement, string | null>();
  const parents = new Set<HTMLElement>();
  const restore = (element: HTMLElement, attribute: string | null): void => {
    if (attribute === null) element.removeAttribute('inert');
    else element.setAttribute('inert', attribute);
  };
  const apply = (): void => {
    const background = new Set<HTMLElement>();
    let branch: HTMLElement = dialog;
    while (branch.parentElement) {
      parents.add(branch.parentElement);
      for (const sibling of branch.parentElement.children) {
        if (sibling !== branch && sibling instanceof HTMLElement) background.add(sibling);
      }
      branch = branch.parentElement;
      if (branch === document.body) break;
    }
    for (const [element, attribute] of previous) {
      if (!background.has(element)) { restore(element, attribute); previous.delete(element); }
    }
    for (const element of background) {
      if (!previous.has(element)) previous.set(element, element.getAttribute('inert'));
      element.setAttribute('inert', '');
    }
  };
  apply();
  const observer = typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(apply);
  for (const parent of parents) observer?.observe(parent, { childList: true });
  return () => {
    observer?.disconnect();
    for (const [element, attribute] of previous) restore(element, attribute);
  };
}

function tabbableElements(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(
    'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]',
  )].filter((element) => element.tabIndex >= 0 && !element.matches(':disabled') && !element.closest('[hidden], [inert]')
    && element.getClientRects().length > 0);
}

export function useModalFocus({ modal, dialogRef, initialFocusRef, onClose }: {
  modal: boolean;
  dialogRef: RefObject<HTMLElement | null>;
  initialFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}): void {
  const closeRef = useRef(onClose);
  const modalRef = useRef(modal);
  closeRef.current = onClose;
  modalRef.current = modal;
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!modal || !dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const restoreBackground = makeBackgroundInert(dialog);
    const focusStart = (): void => { (initialFocusRef.current ?? dialog).focus({ preventScroll: true }); };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      } else if (event.key === 'Tab') {
        const elements = tabbableElements(dialog);
        const target = modalTabTarget(elements.indexOf(document.activeElement as HTMLElement), elements.length, event.shiftKey);
        if (target !== undefined) {
          event.preventDefault();
          if (target < 0) focusStart();
          else elements[target]?.focus();
        }
      }
    };
    const onFocus = (event: FocusEvent): void => {
      if (event.target instanceof Node && !dialog.contains(event.target)) focusStart();
    };
    dialog.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocus);
    focusStart();
    return () => {
      dialog.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocus);
      restoreBackground();
      // Resizing to a wide aside keeps the user's focus in its content.
      if (!modalRef.current && dialog.isConnected) return;
      const fallback = document.querySelector<HTMLElement>('[role="grid"], .workspace-tabs [aria-selected="true"]');
      const target = opener?.isConnected && opener !== document.body && !opener.matches(':disabled')
        && opener.getClientRects().length > 0 && !opener.closest('[hidden], [inert]')
        ? opener : fallback;
      if (target?.isConnected && !target.closest('[hidden], [inert]')) target.focus({ preventScroll: true });
    };
  }, [modal, dialogRef, initialFocusRef]);
}
