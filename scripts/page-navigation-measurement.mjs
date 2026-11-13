export function parsePageCursorOrdinal(cursorText) {
  const marker = cursorText.indexOf('#');
  const separator = cursorText.indexOf('-#', marker + 1);
  if (marker < 0 || separator <= marker + 1) return undefined;
  const ordinal = Number(cursorText.slice(marker + 1, separator));
  return Number.isSafeInteger(ordinal) ? ordinal : undefined;
}

export function samePageNavigationState(left, right) {
  return left.page === right.page
    && left.cursorText === right.cursorText
    && left.cursorOrdinal === right.cursorOrdinal
    && left.mountedOrdinal === right.mountedOrdinal
    && left.generation === right.generation;
}

export function isExpectedPageNavigation(fromPage, toPage, direction) {
  const delta = direction === 'next' ? 1 : direction === 'previous' ? -1 : 0;
  return delta !== 0 && toPage === fromPage + delta;
}
