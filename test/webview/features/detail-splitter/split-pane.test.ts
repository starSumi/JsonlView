import { describe, expect, it } from 'vitest';
import {
  clampDetailWidth,
  detailWidthValueText,
  DETAIL_OVERLAY_BREAKPOINT,
  isOverlayDetailWorkspace,
  maxDetailWidth,
  MIN_DETAIL_WIDTH,
  MIN_PRIMARY_WIDTH,
  resizedDetailWidth,
  SPLITTER_WIDTH,
} from '../../../../src/webview/features/detail-splitter';

describe('detail split pane sizing', () => {
  it('keeps both panes usable inside the current workspace', () => {
    expect(clampDetailWidth(50, 1200)).toBe(MIN_DETAIL_WIDTH);
    expect(clampDetailWidth(2_000, 1200)).toBe(480);
    expect(clampDetailWidth(560, 1200)).toBe(480);
    expect(clampDetailWidth(Number.NaN, 1200)).toBe(480);
    expect(maxDetailWidth(2_000)).toBe(800);
    expect(MIN_PRIMARY_WIDTH).toBe(460);
  });

  it('switches to an overlay drawer before the split layout can starve the table', () => {
    expect(DETAIL_OVERLAY_BREAKPOINT).toBe(800);
    expect(isOverlayDetailWorkspace(DETAIL_OVERLAY_BREAKPOINT)).toBe(true);
    expect(isOverlayDetailWorkspace(DETAIL_OVERLAY_BREAKPOINT + 1)).toBe(false);
    expect(isOverlayDetailWorkspace(Number.NaN)).toBe(true);
    expect(clampDetailWidth(480, 800)).toBe(320);
    expect(clampDetailWidth(480, 801)).toBe(320);
  });

  it.each([801, 850, 900, 1200, 1600, 2000])('clamps docked details at %ipx while protecting the table', (width) => {
    const detail = clampDetailWidth(2_000, width);
    expect(detail).toBeLessThanOrEqual(Math.floor(width * 0.4));
    expect(width - detail - SPLITTER_WIDTH).toBeGreaterThanOrEqual(MIN_PRIMARY_WIDTH);
    expect(detail).toBeGreaterThanOrEqual(MIN_DETAIL_WIDTH);
  });

  it('grows the right pane when the splitter moves left', () => {
    expect(resizedDetailWidth(560, 700, 600, 1200)).toBe(480);
    expect(resizedDetailWidth(560, 700, 820, 1200)).toBe(440);
  });

  it('announces the controlled drawer width in pixels', () => {
    expect(detailWidthValueText(480.4)).toBe('480 pixels wide');
    expect(detailWidthValueText(Number.NaN)).toBe('480 pixels wide');
  });
});
