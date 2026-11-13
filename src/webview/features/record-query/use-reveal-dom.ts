import { useLayoutEffect } from 'react';
import type React from 'react';
import { hasVisibleRevealTarget, type RevealMessage } from './reveal-controller';

/** React commit starts bounded DOM observation; background rAF is not required. */
export function useRevealDom(
  target: RevealMessage | undefined,
  containerRef: React.RefObject<HTMLDivElement | null>,
  seek: () => boolean,
  onRendered: ((requestId: string, ordinal: string) => void) | undefined,
): void {
  useLayoutEffect(() => {
    if (target === undefined || onRendered === undefined || !seek()) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    let previous: { top: number; bottom: number; left: number; right: number } | undefined;
    let stopped = false;
    const verify = (): void => {
      if (stopped) return;
      const container = containerRef.current;
      const row = container?.querySelector<HTMLElement>(
        `[data-row-ordinal="${target.payload.anchorOrdinal}"][data-row-generation="${CSS.escape(target.generation)}"]`,
      );
      if (container && row?.isConnected) {
        const viewport = container.getBoundingClientRect();
        const headerBottom = container.querySelector('.data-grid-header')?.getBoundingClientRect().bottom ?? viewport.top;
        const rect = row.getBoundingClientRect();
        const bounds = { ...viewport.toJSON(), top: Math.max(viewport.top, headerBottom), bottom: viewport.bottom,
          left: viewport.left, right: viewport.right, width: viewport.width, height: Math.max(0, viewport.bottom - Math.max(viewport.top, headerBottom)) };
        if (hasVisibleRevealTarget(bounds, rect, document.hidden)) {
          if (previous && Math.abs(previous.top - rect.top) < 0.5 && Math.abs(previous.bottom - rect.bottom) < 0.5
            && Math.abs(previous.left - rect.left) < 0.5 && Math.abs(previous.right - rect.right) < 0.5) {
            stopped = true;
            onRendered(target.requestId, target.payload.anchorOrdinal);
            return;
          }
          previous = { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
        } else previous = undefined;
      } else previous = undefined;
      if (++attempts < 120) timer = setTimeout(verify, 25);
    };
    timer = setTimeout(verify, 0);
    return () => { stopped = true; if (timer !== undefined) clearTimeout(timer); };
  }, [target, containerRef, seek, onRendered]);
}
