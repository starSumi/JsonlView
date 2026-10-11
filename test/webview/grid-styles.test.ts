import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('../../src/webview/styles.css', import.meta.url), 'utf8');

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
});
