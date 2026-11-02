import { useEffect, type RefObject } from 'react';

export function useQueryStudioLightDismiss(
  studioRef: RefObject<HTMLElement | null>,
  toggleRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  onDismiss: (restoreFocus?: boolean) => void,
): void {
  useEffect(() => {
    if (!enabled) return;

    const dismissOutside = (event: Event): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (studioRef.current?.contains(target) || toggleRef.current?.contains(target)) return;
      onDismiss(event.type !== 'focusin');
    };

    document.addEventListener('pointerdown', dismissOutside, true);
    document.addEventListener('focusin', dismissOutside, true);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside, true);
      document.removeEventListener('focusin', dismissOutside, true);
    };
  }, [enabled, onDismiss, studioRef, toggleRef]);
}
