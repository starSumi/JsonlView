import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TemporaryPreviewActions } from '../../src/webview/temporary-preview-actions';

const styles = ['tokens', 'base', 'layout', 'workspace-header', 'record-query', 'views', 'insights-transition', 'source-intake', 'accessibility']
  .map((module) => readFileSync(new URL('../../src/webview/styles/' + module + '.css', import.meta.url), 'utf8'))
  .join('\n');

const status = { status: 'temporary' as const, recordCount: 2, sizeBytes: 32, savedCopy: false };

describe('temporary preview query rail', () => {
  it('keeps preview actions in the same semantic toolbar order as query controls', () => {
    const markup = renderToStaticMarkup(
      <fieldset className="table-query-toolbar" aria-label="Table search and display">
        <div className="preview-lifecycle-actions"><TemporaryPreviewActions status={status} onSaveAs={() => undefined} /></div>
        <search className="search-box"><input aria-label="Search records" /></search>
        <fieldset className="row-order-control" aria-label="Record order"><span>Asc</span><span>Desc</span></fieldset>
        <details className="filter-menu"><summary>Field filters</summary></details>
        <details className="filter-menu row-types-menu"><summary>Row types</summary></details>
        <details className="columns-menu"><summary>Columns</summary></details>
      </fieldset>,
    );

    const preview = markup.indexOf('class="preview-lifecycle-actions"');
    const search = markup.indexOf('class="search-box"');
    const order = markup.indexOf('class="row-order-control"');
    const filters = markup.indexOf('class="filter-menu"');
    const rowTypes = markup.indexOf('row-types-menu');
    const columns = markup.indexOf('class="columns-menu"');
    expect(preview).toBeGreaterThanOrEqual(0);
    expect(preview).toBeLessThan(search);
    expect(search).toBeLessThan(order);
    expect(order).toBeLessThan(filters);
    expect(filters).toBeLessThan(rowTypes);
    expect(rowTypes).toBeLessThan(columns);
    expect(markup).toContain('Save As…');
  });

  it('keeps every query child on one overflow rail at compact widths', () => {
    expect(styles).toContain('.workspace-query-controls .table-query-toolbar > .preview-lifecycle-actions');
    expect(styles).toContain('flex: 0 0 clamp(160px, 32vw, 220px);');
    expect(styles).toContain('flex: 0 0 160px;');
    expect(styles).toContain('flex-basis: 120px;');
    expect(styles).toContain('white-space: nowrap;');
    expect(styles).toContain('overflow-x: auto;');
    expect(styles).toContain('flex-wrap: nowrap;');
  });
});
