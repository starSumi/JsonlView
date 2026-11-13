import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('../../src/webview/styles/accessibility.css', import.meta.url), 'utf8');
const viewStyles = readFileSync(new URL('../../src/webview/styles/views.css', import.meta.url), 'utf8');
const studioStyles = readFileSync(new URL('../../src/webview/styles/query-studio.css', import.meta.url), 'utf8');

function blockFor(source: string, selector: string): string {
  const start = source.indexOf(selector);
  if (start < 0) return '';

  const open = source.indexOf('{', start);
  let depth = 1;
  for (let index = open + 1; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(open + 1, index);
  }
  return '';
}

describe('query toolbar container layout', () => {
  it('uses local compact and More Actions breakpoints without wrapping the rail', () => {
    const compact = blockFor(styles, '@container query-toolbar (max-width: 760px)');
    const narrow = blockFor(styles, '@container query-toolbar (max-width: 540px)');
    const tight = blockFor(styles, '@container query-toolbar (max-width: 420px)');
    const rail = blockFor(compact, '.workspace-query-controls > .table-query-toolbar');

    expect(blockFor(viewStyles, '.workspace-query-controls {')).toContain('container: query-toolbar / inline-size;');
    expect(rail).toMatch(/flex-wrap:\s*nowrap\s*;/u);
    expect(rail).not.toMatch(/overflow-x:\s*auto\s*;/u);
    expect(narrow).toContain('.more-actions-menu > summary');
    expect(blockFor(tight, '.workspace-query-controls .table-query-toolbar > .search-box')).toContain('min-width: 70px;');
    expect(styles).not.toContain('@container query-toolbar (max-width: 720px)');
  });

  it('presents the same closed disclosure contents inline at wide widths', () => {
    const supported = blockFor(styles, '@supports selector(::details-content)');
    const wide = blockFor(supported, '@container query-toolbar (min-width: 541px)');
    const content = blockFor(wide, '.more-actions-menu::details-content');
    const actions = blockFor(wide, '.more-actions-menu > .more-actions-popover,');

    expect(blockFor(wide, '.more-actions-menu > summary')).toContain('display: none;');
    expect(content).toContain('display: contents;');
    expect(content).toContain('content-visibility: visible;');
    expect(wide).toContain('.more-actions-menu:not([open]) > .more-actions-popover');
    expect(actions).toContain('position: static;');
    expect(actions).toContain('display: inline-flex;');
    expect(actions).toContain('flex-direction: row;');
  });

  it('restores native closed and open disclosure states at narrow widths', () => {
    const narrow = blockFor(styles, '@container query-toolbar (max-width: 540px)');

    expect(blockFor(narrow, '.more-actions-menu > summary')).toContain('display: inline-flex;');
    expect(blockFor(narrow, '.more-actions-menu:not([open])::details-content')).toContain('content-visibility: hidden;');
    expect(blockFor(narrow, '.more-actions-menu[open]::details-content')).toContain('content-visibility: visible;');
    expect(blockFor(viewStyles, '.more-actions-menu:not([open]) > .more-actions-popover')).toContain('display: none;');
    expect(blockFor(viewStyles, '.workspace-header:has(.more-actions-menu[open])')).toContain('overflow: visible;');
    expect(blockFor(viewStyles, '.more-actions-menu > .more-actions-popover')).toContain('calc(100cqi - 8px)');
    expect(narrow).toContain('.more-actions-popover .toolbar-action-label');
    expect(narrow).toContain('display: inline;');
  });

  it('keeps combined filter sections and row type options in vertical flow', () => {
    const fields = blockFor(viewStyles, '.field-filter-form,');
    const options = blockFor(viewStyles, '.row-type-filter-fields fieldset');

    expect(fields).toContain('display: flex;');
    expect(fields).toContain('flex-direction: column;');
    expect(options).toContain('flex-direction: column;');
    expect(options).toContain('min-width: 0;');
    expect(viewStyles).toContain('.row-type-filter-fields label.row-type-option');
    expect(viewStyles).toContain('.row-type-filter-fields .row-type-option > span');
  });

  it('keeps the icon-only Studio trigger fixed beside the compact toolbar', () => {
    expect(blockFor(studioStyles, '.query-studio-toggle')).toContain('flex: 0 0 28px;');
    expect(blockFor(viewStyles, '.workspace-query-controls:has(> .table-query-toolbar) > .query-studio-shell')).toContain('margin-inline-end: 0;');
  });
});
