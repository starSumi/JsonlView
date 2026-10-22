type IdleCallback = (deadline: { didTimeout: boolean; timeRemaining: () => number }) => void;

interface IdleHost {
  requestIdleCallback?: (callback: IdleCallback, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
}

/** Schedule non-critical webview work after the current paint, with a timer fallback. */
export function deferIdle(work: () => void, timeout = 750): () => void {
  const host = globalThis as typeof globalThis & IdleHost;
  let cancelled = false;
  let idleHandle: number | undefined;
  let timerHandle: ReturnType<typeof setTimeout> | undefined;

  if (typeof host.requestIdleCallback === 'function') {
    idleHandle = host.requestIdleCallback(() => {
      if (!cancelled) work();
    }, { timeout });
  } else {
    timerHandle = setTimeout(() => {
      if (!cancelled) work();
    }, 0);
  }

  return () => {
    cancelled = true;
    if (idleHandle !== undefined && typeof host.cancelIdleCallback === 'function') {
      host.cancelIdleCallback(idleHandle);
    }
    if (timerHandle !== undefined) clearTimeout(timerHandle);
  };
}
