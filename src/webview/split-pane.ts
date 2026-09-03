export const DEFAULT_DETAIL_WIDTH = 480;
export const MIN_DETAIL_WIDTH = 320;
export const MIN_PRIMARY_WIDTH = 280;
export const SPLITTER_WIDTH = 5;

export function clampDetailWidth(desired: number, containerWidth: number): number {
  const safeDesired = Number.isFinite(desired) ? desired : DEFAULT_DETAIL_WIDTH;
  const safeContainerWidth = Number.isFinite(containerWidth) && containerWidth > 0
    ? containerWidth
    : MIN_PRIMARY_WIDTH + SPLITTER_WIDTH + DEFAULT_DETAIL_WIDTH;
  const availableMaximum = Math.max(
    MIN_DETAIL_WIDTH,
    Math.floor(safeContainerWidth) - MIN_PRIMARY_WIDTH - SPLITTER_WIDTH,
  );
  return Math.min(availableMaximum, Math.max(MIN_DETAIL_WIDTH, Math.round(safeDesired)));
}

export function resizedDetailWidth(
  initialWidth: number,
  initialPointerX: number,
  pointerX: number,
  containerWidth: number,
): number {
  return clampDetailWidth(initialWidth + initialPointerX - pointerX, containerWidth);
}
