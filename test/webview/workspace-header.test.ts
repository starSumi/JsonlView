import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CompactQueryHud, type CompactQueryHudProps } from '../../src/webview/features/record-query/CompactQueryHud';
import { WorkspaceHeader, type WorkspaceHeaderProps } from '../../src/webview/workspace-header';

const workspaceHeaderStyles = readFileSync(new URL('../../src/webview/styles/workspace-header.css', import.meta.url), 'utf8');
const queryStudioStyles = readFileSync(new URL('../../src/webview/styles/query-studio.css', import.meta.url), 'utf8');
const viewsStyles = readFileSync(new URL('../../src/webview/styles/views.css', import.meta.url), 'utf8');
const accessibilityStyles = readFileSync(new URL('../../src/webview/styles/accessibility.css', import.meta.url), 'utf8');
const compactQueryHudSource = readFileSync(new URL('../../src/webview/features/record-query/CompactQueryHud.tsx', import.meta.url), 'utf8');
const styles = ['tokens', 'base', 'layout', 'workspace-header', 'record-query', 'views', 'insights-transition', 'source-intake', 'accessibility']
  .map((module) => readFileSync(new URL('../../src/webview/styles/' + module + '.css', import.meta.url), 'utf8'))
  .join('\n');

function blockFor(source: string, selector: string): string {
  const start = source.indexOf(selector);
  if (start < 0) return '';

  const open = source.indexOf('{', start);
  if (open < 0) return '';
  let depth = 1;
  for (let index = open + 1; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(open + 1, index);
  }
  return '';
}

const status: WorkspaceHeaderProps = {
  children: React.createElement('button', { type: 'button', 'aria-label': 'Rebuild index' }, 'Rebuild'),
  indexedBytes: '512',
  sizeBytes: '1024',
  indexedRecords: '24',
  validRecords: '22',
  problemRecords: '2',
  complete: true,
  phase: 'ready',
  appendPending: false,
  rebuildAvailable: false,
  rebuildBusy: false,
  navigatorVisible: false,
  onRebuild: () => undefined,
  onOpenNavigator: () => undefined,
};

function render(overrides: Partial<WorkspaceHeaderProps> = {}): string {
  return renderToStaticMarkup(React.createElement(WorkspaceHeader, { ...status, ...overrides }));
}

const noop = () => undefined;
const queryToolbar: CompactQueryHudProps = {
  previewStatus: { status: 'temporary', recordCount: 20, sizeBytes: 2000, savedCopy: false },
  onSaveAs: noop,
  queryControls: {
    query: 'needle',
    searchDisabled: false,
    sortDirection: 'asc',
    descendingDisabled: false,
    descendingDisabledReason: '',
    onSortDirectionChange: noop,
    onSearchSubmit: noop,
    onSearchChange: noop,
    onSearchClear: noop,
    filterActive: false,
    filters: [],
    filterableColumns: [],
    filterColumnId: '',
    filterOperator: 'contains',
    filterOperators: [{ value: 'contains', label: 'contains', needsValue: true }],
    filterValue: '',
    filterCaseSensitive: false,
    onFilterColumnChange: noop,
    onFilterOperatorChange: noop,
    onFilterValueChange: noop,
    onFilterCaseSensitiveChange: noop,
    onFilterSubmit: noop,
    onFilterClear: noop,
  },
  rowTypes: { sources: [], selection: undefined, disabled: false, onChange: noop },
  showColumns: true,
  columns: {
    columns: [],
    schema: [],
    selectedRecordIds: new Set(),
    visibility: {},
    recordColumnLimit: 64,
    schemaComplete: false,
    schemaLoadFailed: false,
    onRetrySchema: noop,
    onVisibilityChange: noop,
  },
};

describe('workspace header status', () => {
  it('uses CSS container queries for the compact icon presentation at 760px', () => {
    const compactToolbarRules = blockFor(accessibilityStyles, '@container query-toolbar (max-width: 760px)');
    const labels = blockFor(compactToolbarRules, '.table-query-toolbar .query-tool-label,');
    const toolbar = blockFor(compactToolbarRules, '.workspace-query-controls > .table-query-toolbar');

    expect(labels).toMatch(/display:\s*none\s*;/u);
    expect(toolbar).toMatch(/flex-wrap:\s*nowrap\s*;/u);
    expect(toolbar).toMatch(/overflow:\s*visible\s*;/u);
  });

  it('keeps workspace tab labels visible at narrow widths inside the scrollable rail', () => {
    const compactHeaderRules = styles.slice(styles.indexOf('@container workspace (max-width: 700px)'), styles.indexOf('@container workspace (max-width: 520px)'));

    expect(compactHeaderRules).toContain('.workspace-tabs button');
    expect(compactHeaderRules).toContain('min-width: 68px');
    expect(compactHeaderRules).toContain('scrollbar-color: var(--vscode-scrollbarSlider-background) transparent');
    expect(styles).not.toContain('.follow-toggle > span');
  });

  it('uses the selected compact bordered rail with an accent-shaped active tab', () => {
    expect(workspaceHeaderStyles).toContain('padding: 2px;');
    expect(workspaceHeaderStyles).toContain('border: 1px solid var(--vscode-panel-border);');
    expect(workspaceHeaderStyles).toContain('inset 3px 0 0 var(--vscode-focusBorder, var(--vscode-tab-activeBorder, var(--vscode-panel-border)))');
    expect(workspaceHeaderStyles).toContain('.workspace-tabs button:not(.is-active)');
    expect(workspaceHeaderStyles).toContain('border-right-color: color-mix(in srgb, var(--vscode-panel-border) 45%, transparent);');
    expect(workspaceHeaderStyles).toContain('font-weight: 600;');
    expect(workspaceHeaderStyles).toContain('border-bottom: 2px solid var(--vscode-focusBorder, var(--vscode-tab-activeBorder, var(--vscode-panel-border)));');
    expect(workspaceHeaderStyles).not.toContain('.workspace-tabs button.is-active {\n  border-bottom-color:');
  });

  it('allows a second primary row instead of clipping controls at the smallest workspace widths', () => {
    const wrapRules = styles.slice(styles.indexOf('@container workspace (max-width: 720px)'), styles.indexOf('@container workspace (max-width: 460px)'));

    expect(wrapRules).toContain('.workspace-header-primary {');
    expect(wrapRules).toContain('flex: 0 0 auto');
    expect(wrapRules).toContain('flex-basis: calc(100% - 34px)');
  });

  it('renders Navigator visibility as an expanded state with a separate half-panel glyph', () => {
    const closed = render();
    const open = render({ navigatorVisible: true });

    expect(closed).toContain('aria-label="Session Navigator"');
    expect(closed).toContain('aria-expanded="false"');
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain('class="navigator-glyph"');
  });

  it('keeps the base query toolbar as a single row with shrinkable children', () => {
    const queryContainer = blockFor(viewsStyles, '.workspace-query-controls {');
    const queryRail = blockFor(viewsStyles, '.workspace-query-controls > .table-query-toolbar {');
    const searchRule = blockFor(viewsStyles, '.workspace-query-controls .table-query-toolbar .search-box');

    expect(queryContainer).toContain('container: query-toolbar / inline-size;');
    expect(queryRail).toMatch(/flex-wrap:\s*nowrap\s*;/u);
    expect(searchRule).toMatch(/min-width:\s*120px\s*;/u);
  });

  it('gives the Studio trigger a neutral icon-only surface without a duplicate compact action', () => {
    const trigger = blockFor(queryStudioStyles, '.query-studio-toggle {');
    const hover = blockFor(queryStudioStyles, '.query-studio-toggle:hover {');
    const focus = blockFor(queryStudioStyles, '.query-studio-toggle:focus-visible {');
    const markup = render({ secondary: React.createElement(CompactQueryHud, queryToolbar) });

    expect(markup).not.toContain('aria-label="Run query"');
    expect(trigger).toContain('background: transparent;');
    expect(trigger).toContain('color: var(--vscode-foreground);');
    expect(trigger).not.toContain('var(--vscode-button-background)');
    expect(hover).toContain('var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground))');
    expect(focus).toContain('outline: 1px solid var(--vscode-focusBorder);');
  });

  it('exposes the same native More Actions contents inline above 540px and as a disclosure at 540px', () => {
    const supportRules = blockFor(accessibilityStyles, '@supports selector(::details-content)');
    const wideRules = blockFor(supportRules, '@container query-toolbar (min-width: 541px)');
    const wideSummary = blockFor(wideRules, '.more-actions-menu > summary');
    const wideContent = blockFor(wideRules, '.more-actions-menu::details-content');
    const widePopover = blockFor(wideRules, '.more-actions-menu > .more-actions-popover,');
    const narrowRules = blockFor(accessibilityStyles, '@container query-toolbar (max-width: 540px)');
    const narrowSummary = blockFor(narrowRules, '.more-actions-menu > summary');
    const closedContent = blockFor(narrowRules, '.more-actions-menu:not([open])::details-content');
    const openContent = blockFor(narrowRules, '.more-actions-menu[open]::details-content');

    expect(wideSummary).toMatch(/display:\s*none\s*;/u);
    expect(wideContent).toMatch(/display:\s*contents\s*;/u);
    expect(wideContent).toMatch(/content-visibility:\s*visible\s*;/u);
    expect(widePopover).toMatch(/position:\s*static\s*;/u);
    expect(widePopover).toMatch(/display:\s*inline-flex\s*;/u);
    expect(widePopover).toMatch(/flex-direction:\s*row\s*;/u);
    expect(narrowSummary).toMatch(/display:\s*inline-flex\s*;/u);
    expect(closedContent).toMatch(/content-visibility:\s*hidden\s*;/u);
    expect(openContent).toMatch(/content-visibility:\s*visible\s*;/u);
  });

  it('keeps the toolbar breakpoint decision out of JavaScript', () => {
    expect(compactQueryHudSource).toContain('Render-only query surface.');
    expect(compactQueryHudSource).not.toMatch(/\bmatchMedia\s*\(|\bwindow\.innerWidth\b|\bwindow\.addEventListener\s*\(\s*['"](?:resize|orientationchange)['"]/u);
  });

  it('keeps field filters in the toolbar and integrates row types in the column tree', () => {
    const markup = render({ secondary: React.createElement(CompactQueryHud, queryToolbar) });
    const filtersStart = markup.indexOf('<details class="filter-menu">');
    const moreActionsStart = markup.indexOf('<details class="filter-menu more-actions-menu"><summary');
    const coreControls = markup.slice(0, moreActionsStart);
    const moreActions = markup.slice(moreActionsStart);

    expect(filtersStart).toBeGreaterThanOrEqual(0);
    expect(moreActionsStart).toBeGreaterThan(filtersStart);
    expect(coreControls).toContain('aria-label="Search records"');
    expect(coreControls).toContain('aria-label="Field filters"');
    expect(coreControls).not.toContain('aria-label="Run query"');
    expect(coreControls).toContain('Field filters');
    expect(coreControls).not.toContain('class="row-type-filter-fields"');
    expect(coreControls).not.toContain('aria-label="Row types"');
    expect(moreActions).toContain('aria-label="More actions"');
    expect(moreActions).toContain('class="preview-save-action"');
    expect(moreActions).toContain('aria-label="Columns"');
    expect(moreActions).toContain('Columns and row types');
    expect(markup.match(/aria-label="Field filters"/g)).toHaveLength(1);
    expect(markup.match(/class="preview-save-action"/g)).toHaveLength(1);
    expect(markup.match(/aria-label="Columns"/g)).toHaveLength(1);
  });

  it('keeps the search and core Filters usable at 420px without a rail or wrapped toolbar', () => {
    const trigger = blockFor(queryStudioStyles, '.query-studio-toggle {');
    const mediumWidthRules = blockFor(accessibilityStyles, '@container workspace (max-width: 900px)');
    const fixedActions = blockFor(mediumWidthRules, '.workspace-query-controls .table-query-toolbar > :not(.search-box)');
    const narrowToolbarRules = blockFor(accessibilityStyles, '@container query-toolbar (max-width: 420px)');
    const toolbar = blockFor(narrowToolbarRules, '.workspace-query-controls > .table-query-toolbar');
    const search = blockFor(narrowToolbarRules, '.workspace-query-controls .table-query-toolbar > .search-box');
    const markup = render({ secondary: React.createElement(CompactQueryHud, queryToolbar) });

    expect(toolbar).toMatch(/gap:\s*4px\s*;/u);
    expect(toolbar).not.toMatch(/flex-wrap:\s*wrap\s*;/u);
    expect(toolbar).not.toMatch(/overflow-x:\s*auto\s*;/u);
    expect(fixedActions).toMatch(/flex:\s*0 0 auto\s*;/u);
    expect(trigger).toMatch(/flex:\s*0 0 28px\s*;/u);
    expect(markup).not.toContain('lucide-play');
    expect(search).toMatch(/flex-basis:\s*100px\s*;/u);
    expect(search).toMatch(/min-width:\s*70px\s*;/u);
  });

  it('places workspace tabs in the same header while preserving the Navigator action', () => {
    const markup = render({ navigation: React.createElement('nav', { 'aria-label': 'Workspace views' }, 'Table') });
    expect(markup.indexOf('aria-label="Session Navigator"')).toBeLessThan(markup.indexOf('<nav'));
    expect(markup.indexOf('<nav')).toBeLessThan(markup.indexOf('<div class="status-strip"'));
    expect(markup).toContain('aria-label="Session Navigator"');
    expect(markup).toContain('lucide-panel-left');
  });

  it('keeps Navigator, view tabs, and workspace options in the requested order', () => {
    const markup = render({
      navigation: React.createElement('nav', { 'aria-label': 'Workspace views' }, 'Table Timeline Schema Problems Insights'),
      children: React.createElement(React.Fragment, null,
        React.createElement('label', { className: 'profile-field' }, 'Profile'),
        React.createElement('label', { className: 'follow-toggle' }, 'Follow'),
      ),
    });

    const navigatorIndex = markup.indexOf('aria-label="Session Navigator"');
    const tabsIndex = markup.indexOf('aria-label="Workspace views"');
    const optionsIndex = markup.indexOf('class="toolbar workspace-controls"');
    const profileIndex = markup.indexOf('class="profile-field"');
    const followIndex = markup.indexOf('class="follow-toggle"');

    expect(navigatorIndex).toBeGreaterThanOrEqual(0);
    expect(navigatorIndex).toBeLessThan(tabsIndex);
    expect(tabsIndex).toBeLessThan(optionsIndex);
    expect(optionsIndex).toBeLessThan(profileIndex);
    expect(profileIndex).toBeLessThan(followIndex);
  });

  it('places the bounded status region in the second row before query controls', () => {
    const markup = render({ secondary: React.createElement('fieldset', { className: 'table-query-toolbar' }, 'Search records') });

    expect(markup.indexOf('<div class="status-strip"')).toBeGreaterThanOrEqual(0);
    expect(markup.indexOf('class="workspace-header-primary')).toBeLessThan(markup.indexOf('class="workspace-header-secondary'));
    expect(markup.indexOf('<div class="status-strip"')).toBeLessThan(markup.indexOf('<div class="workspace-query-controls"'));
    expect(markup).toContain('Search records');
    expect(markup).toContain('role="status" aria-live="polite"');
  });

  it('keeps Query Studio in the existing secondary rail and floats expanded controls', () => {
    const markup = render({
      secondary: React.createElement(React.Fragment, null,
        React.createElement('div', { className: 'query-studio-shell' }, 'Query Studio'),
        React.createElement('fieldset', { className: 'table-query-toolbar' }, 'Search records'),
      ),
    });
    const secondaryIndex = markup.indexOf('class="workspace-header-secondary');
    const railIndex = markup.indexOf('class="workspace-query-controls"');
    const studioIndex = markup.indexOf('class="query-studio-shell"');

    expect(markup.match(/workspace-header-secondary/g)).toHaveLength(1);
    expect(secondaryIndex).toBeLessThan(railIndex);
    expect(railIndex).toBeLessThan(studioIndex);
    expect(queryStudioStyles).toContain('position: fixed;');
    expect(queryStudioStyles).toContain('top: var(--query-studio-anchor-top, 8px);');
    expect(queryStudioStyles).toContain('left: var(--query-studio-anchor-left, 8px);');
  });

  it('keeps file identity outside the header and labels observed problems', () => {
    const markup = render();

    expect(markup).toContain('<header class="workspace-header"');
    expect(markup).toContain('aria-label="Session Navigator"');
    expect(markup).toContain('24 rows');
    expect(markup).toContain('512 B / 1.0 KB');
    expect(markup).toContain('2 problem records observed during hydration; not a complete-file total');
    expect(markup).toContain('2</span><span class="status-scope">problems observed');
    expect(markup).toContain('aria-label="50% indexed"');
    expect(markup).not.toContain('status-file');
    expect(markup).not.toContain('Update pending');
    expect(markup.match(/>Rebuild<\/button>/g)).toHaveLength(1);
  });

  it('shows a nonblocking pending notice with one active Rebuild control', () => {
    const markup = render({ children: null, appendPending: true, rebuildAvailable: true, phase: 'snapshot' });

    expect(markup).toContain('Update pending');
    expect(markup).toContain('The current snapshot remains readable; rebuild to include appended records.');
    expect(markup).toContain('2 problem records observed during hydration; not a complete-file total');
    expect(markup).toContain('aria-label="Rebuild index to include appended records"');
    expect(markup).toContain('title="Rebuild index to include appended records"');
    expect(markup.match(/>Rebuild<\/span>/g)).toHaveLength(1);
  });

  it('keeps Rebuild available for non-append invalidation without relabeling it as an update', () => {
    const markup = render({ children: null, rebuildAvailable: true, appendPending: false });

    expect(markup).toContain('aria-label="Rebuild index"');
    expect(markup).not.toContain('Update pending');
  });

  it('disables the pending action while rebuilding and keeps incomplete progress visible', () => {
    const markup = render({
      children: null,
      appendPending: true,
      rebuildAvailable: true,
      rebuildBusy: true,
      complete: false,
      phase: 'indexing',
    });

    expect(markup).toMatch(/<button type="button" class="rebuild-action rebuild-action-prominent"[^>]*disabled="">[\s\S]*<span class="rebuild-action-label">Rebuild<\/span><\/button>/);
    expect(markup).toContain('data-complete="false"');
    expect(markup).toContain('indexing');
  });

  it('does not present an unobserved problem as a full-file finding', () => {
    const markup = render({ problemRecords: '0' });

    expect(markup).toContain('data-empty="true"');
    expect(markup).toContain('0 problem records observed during hydration; not a complete-file total');
    expect(markup).not.toContain('class="status-metric status-problems status-problem"');
  });

  it('exposes numeric, bounded indexing progress for assistive technology', () => {
    expect(render()).toContain('role="progressbar" aria-label="50% indexed" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50"');
    expect(render({ indexedBytes: '-10' })).toContain('aria-valuenow="0"');
    expect(render({ indexedBytes: '2000' })).toContain('aria-valuenow="100"');
    expect(render({ sizeBytes: 'Infinity' })).toContain('aria-valuenow="0"');
    expect(render({ sizeBytes: '0' })).toContain('aria-valuenow="0"');
  });

  it('preserves long row and byte labels without inventing a telemetry field', () => {
    const markup = render({ indexedRecords: '13572', indexedBytes: '88200000', sizeBytes: '88200000' });

    expect(markup).toContain('13572 rows');
    expect(markup).toContain('84.1 MB / 84.1 MB');
    expect(markup).toContain('aria-label="100% indexed"');
  });
});
