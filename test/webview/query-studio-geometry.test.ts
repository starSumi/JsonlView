import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('../../src/webview/styles/query-studio.css', import.meta.url), 'utf8');

function declarationsFor(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = styles.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
  return rule?.[1] ?? '';
}

describe('Query Studio panel geometry', () => {
  it('keeps one shared left anchor across views while clamping adjustable size to the viewport', () => {
    const shell = declarationsFor('.query-studio-shell');
    const panel = declarationsFor('.query-studio');

    expect(shell).toMatch(/margin-inline-end:\s*auto\s*;/);
    expect(panel).toContain('left: var(--query-studio-anchor-left, 8px);');
    expect(panel).toContain('top: var(--query-studio-anchor-top, 8px);');
    expect(panel).toContain('inset: auto;');
    expect(panel).toMatch(/position:\s*fixed\s*;/);
    expect(panel).toContain('width: min(var(--query-studio-width, 640px), var(--query-studio-available-width, calc(100vw - 16px)));');
    expect(panel).toContain('height: min(var(--query-studio-height, 430px), var(--query-studio-available-height, calc(100vh - 16px)));');

    for (const viewportWidth of [1280, 720, 390]) {
      for (const anchorLeft of [8, 24, 72]) {
        for (const requestedWidth of [640, 920]) {
          const availableWidth = Math.max(0, viewportWidth - anchorLeft - 8);
          const panelWidth = Math.min(requestedWidth, availableWidth);

          expect(anchorLeft).toBeGreaterThanOrEqual(0);
          expect(anchorLeft + panelWidth).toBeLessThanOrEqual(viewportWidth - 8);
        }
      }
    }
  });

  it('replaces anchored geometry with a viewport-filling rectangle while maximized', () => {
    const maximized = declarationsFor('.query-studio[data-query-studio-maximized="true"]');

    expect(maximized).toMatch(/position:\s*fixed\s*;/);
    expect(maximized).toMatch(/inset:\s*8px\s*;/);
    expect(maximized).toMatch(/resize:\s*none\s*;/);
  });
});
