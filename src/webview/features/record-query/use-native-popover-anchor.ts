import { useEffect, useLayoutEffect, useRef } from 'react';
import type React from 'react';

export interface NativePopoverAnchorSize {
  readonly width: number;
  readonly height: number;
}

export interface NativePopoverAnchorStyle {
  readonly '--query-studio-width': string;
  readonly '--query-studio-height': string;
  readonly '--query-studio-available-width': string;
  readonly '--query-studio-available-height': string;
  readonly '--query-studio-anchor-top': string;
  readonly '--query-studio-anchor-left': string;
}

export interface UseNativePopoverAnchorOptions {
  readonly open: boolean;
  readonly maximized: boolean;
  readonly size: NativePopoverAnchorSize;
  readonly studioRef: React.RefObject<HTMLElement | null>;
  readonly toggleRef: React.RefObject<HTMLElement | null>;
  readonly onSizeChange: (size: NativePopoverAnchorSize) => void;
  readonly clampSize: (size: NativePopoverAnchorSize) => NativePopoverAnchorSize;
}

export interface NativePopoverAnchorResult {
  readonly style: NativePopoverAnchorStyle;
}

type NativePopoverElement = HTMLElement & {
  showPopover?: () => void;
  hidePopover?: () => void;
};

function isNativePopoverOpen(element: NativePopoverElement): boolean {
  try {
    return element.matches(':popover-open');
  } catch {
    return element.dataset.queryStudioNativeOpen === 'true';
  }
}

function syncNativePopover(element: NativePopoverElement, open: boolean): void {
  const hasNativePopover = typeof element.showPopover === 'function';
  try {
    if (open) {
      if (hasNativePopover) element.showPopover();
    } else if (typeof element.hidePopover === 'function') {
      element.hidePopover();
    }
  } catch {
    // Older embedded Chromium builds can expose the attribute without the API.
  }
  if (open && !hasNativePopover) element.dataset.queryStudioNativeOpen = 'true';
  else delete element.dataset.queryStudioNativeOpen;
}

function clearNativeResizeSize(panel: HTMLElement): void {
  panel.style.removeProperty('width');
  panel.style.removeProperty('height');
}

function scheduleAnimationFrame(callback: () => void): number {
  if (typeof window.requestAnimationFrame === 'function') return window.requestAnimationFrame(callback);
  return window.setTimeout(callback, 0);
}

function cancelAnimationFrame(frame: number): void {
  if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(frame);
  else window.clearTimeout(frame);
}

function setGeometryVariable(element: HTMLElement, name: string, value: string): void {
  element.style.setProperty(name, value);
}

export function useNativePopoverAnchor({
  open,
  maximized,
  size,
  studioRef,
  toggleRef,
  onSizeChange,
  clampSize,
}: UseNativePopoverAnchorOptions): NativePopoverAnchorResult {
  const onSizeChangeRef = useRef(onSizeChange);
  const clampSizeRef = useRef(clampSize);
  const observerFrameRef = useRef<number | undefined>(undefined);

  useLayoutEffect(() => {
    onSizeChangeRef.current = onSizeChange;
    clampSizeRef.current = clampSize;
  }, [clampSize, onSizeChange]);

  useLayoutEffect(() => {
    const panel = studioRef.current as NativePopoverElement | null;
    if (panel === null) return;
    if (!open) {
      syncNativePopover(panel, false);
      clearNativeResizeSize(panel);
      return;
    }
    if (!isNativePopoverOpen(panel)) syncNativePopover(panel, true);
    clearNativeResizeSize(panel);
    return () => {
      syncNativePopover(panel, false);
      clearNativeResizeSize(panel);
    };
  }, [open, studioRef]);

  useLayoutEffect(() => {
    if (!open) return;
    const panel = studioRef.current;
    if (panel === null) return;

    const updateAnchorCoordinates = (): void => {
      const anchor = toggleRef.current?.getBoundingClientRect();
      if (anchor === undefined) return;
      setGeometryVariable(panel, '--query-studio-anchor-top', `${Math.max(8, Math.floor(anchor.bottom + 4))}px`);
      setGeometryVariable(panel, '--query-studio-anchor-left', `${Math.max(8, Math.floor(anchor.left))}px`);
      setGeometryVariable(panel, '--query-studio-available-width', `${Math.max(0, Math.floor(window.innerWidth - anchor.left - 8))}px`);
      setGeometryVariable(panel, '--query-studio-available-height', `${Math.max(0, Math.floor(window.innerHeight - anchor.bottom - 12))}px`);
    };
    let frame: number | undefined;
    const scheduleUpdate = (): void => {
      if (frame !== undefined) return;
      frame = scheduleAnimationFrame(() => {
        frame = undefined;
        updateAnchorCoordinates();
      });
    };
    updateAnchorCoordinates();
    window.addEventListener('resize', scheduleUpdate, { passive: true });
    window.addEventListener('scroll', scheduleUpdate, { capture: true, passive: true });
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      window.removeEventListener('resize', scheduleUpdate);
      window.removeEventListener('scroll', scheduleUpdate, { capture: true });
    };
  }, [open, studioRef, toggleRef]);

  useEffect(() => {
    if (!open) return;
    const panel = studioRef.current;
    if (panel === null) return;

    const reportNativeResize = (): void => {
      observerFrameRef.current = undefined;
      if (maximized || (!panel.style.width && !panel.style.height)) return;
      const rect = panel.getBoundingClientRect();
      if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width <= 0 || rect.height <= 0) return;
      onSizeChangeRef.current(clampSizeRef.current({ width: rect.width, height: rect.height }));
    };
    const scheduleNativeResizeReport = (): void => {
      if (observerFrameRef.current !== undefined) return;
      observerFrameRef.current = scheduleAnimationFrame(reportNativeResize);
    };
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(scheduleNativeResizeReport);
    observer?.observe(panel);

    const finishResize = (): void => {
      if (maximized || (!panel.style.width && !panel.style.height)) return;
      if (observerFrameRef.current !== undefined) {
        cancelAnimationFrame(observerFrameRef.current);
        observerFrameRef.current = undefined;
      }
      const rect = panel.getBoundingClientRect();
      if (Number.isFinite(rect.width) && Number.isFinite(rect.height) && rect.width > 0 && rect.height > 0) {
        onSizeChangeRef.current(clampSizeRef.current({ width: rect.width, height: rect.height }));
      }
      clearNativeResizeSize(panel);
    };
    window.addEventListener('pointerup', finishResize, { passive: true });
    window.addEventListener('pointercancel', finishResize, { passive: true });
    return () => {
      observer?.disconnect();
      window.removeEventListener('pointerup', finishResize);
      window.removeEventListener('pointercancel', finishResize);
      if (observerFrameRef.current !== undefined) {
        cancelAnimationFrame(observerFrameRef.current);
        observerFrameRef.current = undefined;
      }
    };
  }, [maximized, open, studioRef]);

  useEffect(() => {
    if (!open) return;
    const panel = studioRef.current;
    if (panel === null) return;
    const control = panel.querySelector<HTMLElement>('input:not([disabled]), select:not([disabled]), button:not([disabled]), textarea:not([disabled])');
    (control ?? panel).focus({ preventScroll: true });
  }, [open, studioRef]);

  return {
    style: {
      '--query-studio-width': `${size.width}px`,
      '--query-studio-height': `${size.height}px`,
      '--query-studio-available-width': 'calc(100vw - 16px)',
      '--query-studio-available-height': 'calc(100vh - 16px)',
      '--query-studio-anchor-top': '8px',
      '--query-studio-anchor-left': '8px',
    },
  };
}
