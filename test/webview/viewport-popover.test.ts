import { describe, expect, it } from 'vitest';
import { clampPopoverToViewport } from '../../src/webview/viewport-popover';

describe('native details popup viewport placement', () => {
  it('keeps left-edge controls reachable in a narrow viewport', () => {
    expect(clampPopoverToViewport({ top: 10, bottom: 38, right: 28 }, 280, 260, 180, 400))
      .toEqual({ left: 8, top: 42, width: 164, maxHeight: 260 });
  });

  it('uses space above a control when the bottom viewport edge is near', () => {
    expect(clampPopoverToViewport({ top: 270, bottom: 298, right: 460 }, 220, 200, 480, 320))
      .toEqual({ left: 240, top: 66, width: 220, maxHeight: 200 });
  });

  it('bounds tall popups so their fields can scroll and actions remain in the viewport', () => {
    const placement = clampPopoverToViewport({ top: 20, bottom: 48, right: 200 }, 280, 800, 240, 200);
    expect(placement.top).toBe(8);
    expect(placement.maxHeight).toBe(184);
    expect(placement.left + placement.width).toBeLessThanOrEqual(232);
    expect(placement.top + placement.maxHeight).toBeLessThanOrEqual(192);
  });

  it('clamps controls outside the viewport after a responsive layout change', () => {
    const placement = clampPopoverToViewport({ top: 500, bottom: 528, right: 1200 }, 220, 300, 320, 240);
    expect(placement.left).toBe(92);
    expect(placement.top).toBe(8);
    expect(placement.top + placement.maxHeight).toBeLessThanOrEqual(232);
  });

  it('keeps empty or invalid viewport metrics finite', () => {
    expect(clampPopoverToViewport({ top: Number.NaN, bottom: Number.NaN, right: Number.NaN },
      Number.NaN, Number.NaN, Number.NaN, 0)).toEqual({ left: 0, top: 0, width: 0, maxHeight: 0 });
  });
});
