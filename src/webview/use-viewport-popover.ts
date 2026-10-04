import { useEffect, type RefObject } from 'react';
import { clampPopoverToViewport } from './viewport-popover';

export function useViewportPopover(ref: RefObject<HTMLDetailsElement | null>): void {
  useEffect(() => {
    const menu = ref.current;
    const popup = menu?.querySelector<HTMLElement>(':scope > .columns-popover, :scope > .filter-popover');
    const summary = menu?.querySelector<HTMLElement>(':scope > summary');
    if (!menu || !popup || !summary) return;
    const previousStyle = popup.getAttribute('style');
    const place = (): void => {
      if (!menu.open) return;
      const desiredWidth = popup.classList.contains('columns-popover') ? 220 : 260;
      const anchor = summary.getBoundingClientRect();
      const width = clampPopoverToViewport(anchor, desiredWidth, 0, window.innerWidth, window.innerHeight).width;
      popup.style.width = `${width}px`;
      popup.style.maxHeight = 'none';
      const placement = clampPopoverToViewport(anchor, desiredWidth,
        Math.min(popup.scrollHeight + 2, popup.classList.contains('columns-popover') ? 320 : 420),
        window.innerWidth, window.innerHeight);
      popup.style.position = 'fixed';
      popup.style.right = 'auto';
      popup.style.left = `${placement.left}px`;
      popup.style.top = `${placement.top}px`;
      popup.style.width = `${placement.width}px`;
      popup.style.maxHeight = `${placement.maxHeight}px`;
    };
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(place);
    observer?.observe(popup);
    menu.addEventListener('toggle', place);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    place();
    return () => {
      observer?.disconnect();
      menu.removeEventListener('toggle', place);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      if (previousStyle === null) popup.removeAttribute('style');
      else popup.setAttribute('style', previousStyle);
    };
  }, [ref]);
}
