export {
  clampDetailWidth,
  DEFAULT_DETAIL_WIDTH,
  DETAIL_OVERLAY_BREAKPOINT,
  detailWidthValueText,
  isOverlayDetailWorkspace,
  MAX_DETAIL_RATIO,
  maxDetailWidth,
  MIN_DETAIL_WIDTH,
  MIN_PRIMARY_WIDTH,
  resizedDetailWidth,
  SPLITTER_WIDTH,
} from './split-pane';
export type {
  DetailSplitterHandlers,
  DetailSplitterInteraction,
  DetailSplitterInteractionOptions,
  DetailSplitterInteractionTargets,
  DetailSplitterKeyboardEvent,
  DetailSplitterPointerDownEvent,
  DetailSplitterPointerEventHost,
  PointerCaptureTarget,
} from './use-detail-splitter';
export { createDetailSplitterInteraction, useDetailSplitter } from './use-detail-splitter';
