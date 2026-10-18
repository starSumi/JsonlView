import { useEffect, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { clampDetailWidth, resizedDetailWidth } from './split-pane';

type PointerEventName = 'pointermove' | 'pointerup' | 'pointercancel';
type PointerMoveEvent = Pick<PointerEvent, 'clientX'>;

export interface DetailSplitterPointerDownEvent {
  button: number;
  pointerId: number;
  clientX: number;
  currentTarget: PointerCaptureTarget;
}

export interface DetailSplitterKeyboardEvent {
  key: string;
  shiftKey: boolean;
  preventDefault(): void;
}

export interface PointerCaptureTarget {
  setPointerCapture(pointerId: number): void;
  releasePointerCapture?(pointerId: number): void;
}

export interface DetailSplitterPointerEventHost {
  addEventListener(
    type: PointerEventName,
    listener: (event: PointerMoveEvent) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener(type: PointerEventName, listener: (event: PointerMoveEvent) => void): void;
}

export interface DetailSplitterInteractionOptions {
  readContainerWidth(): number;
  readPointerStartWidth(): number;
  readKeyboardStartWidth(): number;
  setWidth(width: number): void;
  pauseFollowing(): void;
}

export interface DetailSplitterInteractionTargets {
  pointerEvents: DetailSplitterPointerEventHost;
  bodyClassList: Pick<DOMTokenList, 'add' | 'remove'>;
}

export interface DetailSplitterInteraction {
  onPointerDown(event: DetailSplitterPointerDownEvent): void;
  onKeyDown(event: DetailSplitterKeyboardEvent): void;
  dispose(): void;
}

export interface DetailSplitterHandlers {
  onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void;
  onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void;
}

export function createDetailSplitterInteraction(
  options: DetailSplitterInteractionOptions,
  targets: DetailSplitterInteractionTargets,
): DetailSplitterInteraction {
  let activeDrag: {
    pointerId: number;
    splitter: PointerCaptureTarget;
    captured: boolean;
    onPointerMove(event: PointerMoveEvent): void;
    finish(): void;
  } | undefined;

  const stopDrag = (releaseCapture: boolean): void => {
    const drag = activeDrag;
    if (drag === undefined) return;
    activeDrag = undefined;
    targets.bodyClassList.remove('is-resizing-detail');
    targets.pointerEvents.removeEventListener('pointermove', drag.onPointerMove);
    targets.pointerEvents.removeEventListener('pointerup', drag.finish);
    targets.pointerEvents.removeEventListener('pointercancel', drag.finish);
    if (releaseCapture && drag.captured) {
      try {
        drag.splitter.releasePointerCapture?.(drag.pointerId);
      } catch {
        // The element may have detached before unmount cleanup runs.
      }
    }
  };

  const onPointerDown = (event: DetailSplitterPointerDownEvent): void => {
    if (event.button !== 0) return;
    stopDrag(true);
    options.pauseFollowing();
    const containerWidth = options.readContainerWidth();
    const initialPointerX = event.clientX;
    const initialWidth = options.readPointerStartWidth();
    const splitter = event.currentTarget;
    let captured = false;
    try {
      splitter.setPointerCapture(event.pointerId);
      captured = true;
    } catch {
      // Window listeners still handle the drag if pointer capture is unavailable.
    }
    targets.bodyClassList.add('is-resizing-detail');

    const onPointerMove = (moveEvent: PointerMoveEvent): void => {
      if (activeDrag?.onPointerMove !== onPointerMove) return;
      options.setWidth(resizedDetailWidth(initialWidth, initialPointerX, moveEvent.clientX, containerWidth));
    };
    const finish = (): void => {
      if (activeDrag?.finish === finish) stopDrag(false);
    };
    activeDrag = {
      pointerId: event.pointerId,
      splitter,
      captured,
      onPointerMove,
      finish,
    };
    try {
      targets.pointerEvents.addEventListener('pointermove', onPointerMove);
      targets.pointerEvents.addEventListener('pointerup', finish, { once: true });
      targets.pointerEvents.addEventListener('pointercancel', finish, { once: true });
    } catch (error) {
      stopDrag(true);
      throw error;
    }
  };

  const onKeyDown = (event: DetailSplitterKeyboardEvent): void => {
    const containerWidth = options.readContainerWidth();
    const step = event.shiftKey ? 64 : 16;
    let desired: number | undefined;
    if (event.key === 'ArrowLeft') desired = options.readKeyboardStartWidth() + step;
    if (event.key === 'ArrowRight') desired = options.readKeyboardStartWidth() - step;
    if (event.key === 'Home') desired = 0;
    if (event.key === 'End') desired = containerWidth;
    if (desired === undefined) return;
    options.pauseFollowing();
    event.preventDefault();
    options.setWidth(clampDetailWidth(desired, containerWidth));
  };

  return {
    onPointerDown,
    onKeyDown,
    dispose: () => stopDrag(true),
  };
}

function browserTargets(): DetailSplitterInteractionTargets {
  return {
    pointerEvents: {
      addEventListener: (type, listener, options) => {
        window.addEventListener(type, listener as unknown as EventListener, options);
      },
      removeEventListener: (type, listener) => {
        window.removeEventListener(type, listener as unknown as EventListener);
      },
    },
    bodyClassList: document.body.classList,
  };
}

export function useDetailSplitter(options: DetailSplitterInteractionOptions): DetailSplitterHandlers {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const interactionRef = useRef<DetailSplitterInteraction | undefined>(undefined);
  if (interactionRef.current === undefined) {
    interactionRef.current = createDetailSplitterInteraction({
      readContainerWidth: () => optionsRef.current.readContainerWidth(),
      readPointerStartWidth: () => optionsRef.current.readPointerStartWidth(),
      readKeyboardStartWidth: () => optionsRef.current.readKeyboardStartWidth(),
      setWidth: (width) => optionsRef.current.setWidth(width),
      pauseFollowing: () => optionsRef.current.pauseFollowing(),
    }, browserTargets());
  }
  const interaction = interactionRef.current;
  useEffect(() => () => interaction.dispose(), [interaction]);
  return interaction;
}
