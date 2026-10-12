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
      const desiredMaxHeight = popup.classList.contains('columns-popover') ? 320 : 420;
      const anchor = summary.getBoundingClientRect();
      const placement = clampPopoverToViewport(anchor, desiredWidth,
        Math.min(popup.scrollHeight + 2, desiredMaxHeight),
        window.innerWidth, window.innerHeight);
      const nextStyle: Record<string, string> = {
        position: 'fixed',
        right: 'auto',
        left: `${placement.left}px`,
        top: `${placement.top}px`,
        width: `${placement.width}px`,
        maxHeight: `${placement.maxHeight}px`,
      };
      for (const [property, value] of Object.entries(nextStyle)) {
        if (popup.style.getPropertyValue(property) !== value) popup.style.setProperty(property, value);
      }
    };
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(place);
    observer?.observe(popup);
    const onScroll = (event: Event): void => {
      // Scrolling the popup must leave its own scroll position untouched.
      // Only an ancestor/window scroll can move the anchor out of view.
      const target = event.target;
      if (target === popup || (typeof Node !== 'undefined' && target instanceof Node && popup.contains(target))) return;
      place();
    };
    menu.addEventListener('toggle', place);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    place();
    return () => {
      observer?.disconnect();
      menu.removeEventListener('toggle', place);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
      if (previousStyle === null) popup.removeAttribute('style');
      else popup.setAttribute('style', previousStyle);
    };
  }, [ref]);
}
