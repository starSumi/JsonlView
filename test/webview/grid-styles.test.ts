import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = ['tokens', 'base', 'layout', 'workspace-header', 'record-query', 'views', 'source-intake', 'accessibility']
  .map((module) => readFileSync(new URL('../../src/webview/styles/' + module + '.css', import.meta.url), 'utf8'))
  .join('\n');

function cssBlock(selector: string): string {
  const start = styles.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = styles.indexOf('\n}', start);
  expect(end).toBeGreaterThan(start);
  return styles.slice(start, end);
}

describe('record grid presentation styles', () => {
  it('gives the sticky header an opaque isolated paint layer', () => {
    const header = cssBlock('.data-grid-header');
    expect(header).toContain('isolation: isolate;');
    expect(header).toContain('z-index: 4;');
    expect(header).toContain('background: var(--vscode-editor-background);');
  });

  it('keeps scrollbars compact and stable across grid and popover surfaces', () => {
    expect(styles).toContain('scrollbar-width: thin;');
    expect(styles).toContain('scrollbar-gutter: stable;');
    expect(styles).toContain('.data-grid-scroll::-webkit-scrollbar-thumb:hover');
  });

  it('keeps only the grid horizontal scrollbar implicit until hover or keyboard focus', () => {
    const gridScrollbar = cssBlock('.data-grid-scroll');
    expect(gridScrollbar).toContain('scrollbar-width: auto;');
    expect(gridScrollbar).toContain('scrollbar-color: auto;');
    expect(styles).toContain('.data-grid-scroll::-webkit-scrollbar-thumb:horizontal {\n  background: transparent;');
    expect(styles).toContain('.data-grid-scroll:hover::-webkit-scrollbar-thumb:horizontal');
    expect(styles).toContain('.data-grid-scroll:focus-within::-webkit-scrollbar-thumb:horizontal');
    expect(styles).toContain('background: var(--vscode-scrollbarSlider-hoverBackground, var(--vscode-scrollbarSlider-background, rgba(128, 128, 128, 0.65)));');
  });

  it('keeps the grid horizontal scrollbar visible with system colors in forced-colors mode', () => {
    const forcedColors = styles.slice(styles.indexOf('@media (forced-colors: active)'));
    expect(forcedColors).toContain('.data-grid-scroll::-webkit-scrollbar-thumb:horizontal,\n  .data-grid-scroll:hover::-webkit-scrollbar-thumb:horizontal,\n  .data-grid-scroll:focus-within::-webkit-scrollbar-thumb:horizontal,\n  .data-grid-scroll::-webkit-scrollbar-thumb:horizontal:hover {\n    background: CanvasText;');
  });

  it('keeps pointer-active cells quiet and reserves the focus ring for keyboard entry', () => {
    const activeCell = cssBlock('.data-grid-scroll .is-active-cell');
    expect(activeCell).toContain('background: transparent;');
    expect(activeCell).toContain('outline: none;');
    expect(activeCell).toContain('box-shadow: none;');

    const keyboardCell = cssBlock('.data-grid-scroll:focus-visible .is-active-cell');
    expect(keyboardCell).toContain('outline: 1px solid var(--vscode-focusBorder);');
  });
});
