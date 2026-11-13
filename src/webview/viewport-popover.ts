export interface PopoverAnchor {
  top: number;
  bottom: number;
  right: number;
}

export interface PopoverPlacement {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

export function clampPopoverToViewport(
  anchor: PopoverAnchor,
  desiredWidth: number,
  desiredHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  horizontalBoundary?: { left: number; right: number },
): PopoverPlacement {
  const gap = 4;
  const safeWidth = Math.max(0, Number.isFinite(viewportWidth) ? viewportWidth : 0);
  const safeHeight = Math.max(0, Number.isFinite(viewportHeight) ? viewportHeight : 0);
  const marginX = Math.min(8, safeWidth / 2);
  const marginY = Math.min(8, safeHeight / 2);
  const leftEdge = Math.max(marginX, horizontalBoundary === undefined ? marginX : horizontalBoundary.left + marginX);
  const rightEdge = Math.max(leftEdge, Math.min(safeWidth - marginX,
    horizontalBoundary === undefined ? safeWidth - marginX : horizontalBoundary.right - marginX));
  const width = Math.min(Math.max(0, Number.isFinite(desiredWidth) ? desiredWidth : 0), rightEdge - leftEdge);
  const height = Math.min(Math.max(0, Number.isFinite(desiredHeight) ? desiredHeight : 0), safeHeight - marginY * 2);
  const anchorTop = Number.isFinite(anchor.top) ? anchor.top : 0;
  const anchorBottom = Number.isFinite(anchor.bottom) ? anchor.bottom : 0;
  const anchorRight = Number.isFinite(anchor.right) ? anchor.right : 0;
  const below = safeHeight - marginY - anchorBottom - gap;
  const above = anchorTop - marginY - gap;
  const desiredTop = below >= height || below >= above ? anchorBottom + gap : anchorTop - gap - height;
  const top = Math.max(marginY, Math.min(desiredTop, safeHeight - marginY - height));
  return {
    left: Math.max(leftEdge, Math.min(anchorRight - width, rightEdge - width)),
    top,
    width,
    maxHeight: Math.max(0, Math.min(height, safeHeight - marginY - top)),
  };
}
