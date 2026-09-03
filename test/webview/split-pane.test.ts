import { describe, expect, it } from 'vitest';
import {
  clampDetailWidth,
  MIN_DETAIL_WIDTH,
  resizedDetailWidth,
} from '../../src/webview/split-pane';

describe('detail split pane sizing', () => {
  it('keeps both panes usable inside the current workspace', () => {
    expect(clampDetailWidth(50, 1200)).toBe(MIN_DETAIL_WIDTH);
    expect(clampDetailWidth(2_000, 1200)).toBe(915);
    expect(clampDetailWidth(560, 1200)).toBe(560);
    expect(clampDetailWidth(Number.NaN, 1200)).toBe(480);
  });

  it('grows the right pane when the splitter moves left', () => {
    expect(resizedDetailWidth(560, 700, 600, 1200)).toBe(660);
    expect(resizedDetailWidth(560, 700, 820, 1200)).toBe(440);
  });
});
