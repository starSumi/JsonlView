import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WorkspaceHeader, type WorkspaceHeaderProps } from '../../src/webview/workspace-header';

const workspaceHeaderStyles = readFileSync(new URL('../../src/webview/styles/workspace-header.css', import.meta.url), 'utf8');
const accessibilityStyles = readFileSync(new URL('../../src/webview/styles/accessibility.css', import.meta.url), 'utf8');
const styles = ['tokens', 'base', 'layout', 'workspace-header', 'record-query', 'views', 'insights-transition', 'source-intake', 'accessibility']
  .map((module) => readFileSync(new URL('../../src/webview/styles/' + module + '.css', import.meta.url), 'utf8'))
  .join('\n');

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

describe('workspace header status', () => {
  it('keeps compact query controls on one horizontally scrollable rail', () => {
    const compactToolbarRules = styles.slice(styles.indexOf('@container workspace (max-width: 900px)'), styles.indexOf('@container workspace (max-width: 720px)'));

    expect(compactToolbarRules).toContain('flex-wrap: nowrap');
    expect(compactToolbarRules).toContain('overflow-x: auto');
    expect(compactToolbarRules).toContain('overscroll-behavior-inline: contain');
    expect(compactToolbarRules).not.toContain('scrollbar-color: var(--vscode-scrollbarSlider-background) transparent');
    expect(compactToolbarRules).toContain('flex: 0 0 clamp(160px, 32vw, 220px)');
    expect(compactToolbarRules).not.toContain('display: none');
  });

  it('keeps the query-rail scrollbar implicit until pointer hover or keyboard focus', () => {
    const scrollbarRules = workspaceHeaderStyles.slice(
      workspaceHeaderStyles.indexOf('.workspace-query-controls > .table-query-toolbar {'),
      workspaceHeaderStyles.indexOf('.preview-lifecycle-actions button,'),
    );

    expect(scrollbarRules).toContain('scrollbar-width: thin;');
    expect(scrollbarRules).toContain('scrollbar-color: transparent transparent;');
    expect(scrollbarRules).toContain('.workspace-query-controls > .table-query-toolbar:hover');
    expect(scrollbarRules).toContain('.workspace-query-controls > .table-query-toolbar:focus-within');
    expect(scrollbarRules).toContain('background: transparent;');
    expect(scrollbarRules).toContain('var(--vscode-scrollbarSlider-hoverBackground, var(--vscode-scrollbarSlider-background))');
    expect(scrollbarRules).not.toContain('flex: 0 0 32px');
    expect(scrollbarRules).not.toContain('border-bottom: 1px solid');
    expect(accessibilityStyles).not.toContain('.workspace-query-controls .table-query-toolbar::-webkit-scrollbar-thumb {');
  });

  it('uses icon-only workspace tabs at narrow widths while retaining their accessible labels', () => {
    const compactHeaderRules = styles.slice(styles.indexOf('@container workspace (max-width: 700px)'), styles.indexOf('@container workspace (max-width: 520px)'));

    expect(compactHeaderRules).toContain('.workspace-tab-label');
    expect(compactHeaderRules).toContain('display: none');
    expect(compactHeaderRules).toContain('.workspace-tabs button');
    expect(compactHeaderRules).toContain('scrollbar-color: var(--vscode-scrollbarSlider-background) transparent');
    expect(styles).not.toContain('.follow-toggle > span');
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

  it('keeps the query rail single-line before container breakpoints are evaluated', () => {
    const queryRail = styles.slice(styles.indexOf('.workspace-query-controls > .table-query-toolbar'), styles.indexOf('.workspace-header-primary > .workspace-controls'));
    expect(queryRail).toContain('flex-wrap: nowrap');
    expect(queryRail).toContain('overflow-x: auto');
    expect(queryRail).toContain('white-space: nowrap');
    expect(queryRail).toContain('min-width: 120px');
  });

  it('applies compact sizing to the nested query controls', () => {
    const compactRules = styles.slice(styles.indexOf('@container workspace (max-width: 720px)'), styles.indexOf('@container workspace (max-width: 520px)'));
    expect(compactRules).toContain('.workspace-query-controls .table-query-toolbar > .search-box');
    expect(compactRules).toContain('.workspace-query-controls .table-query-toolbar > .row-order-control');
    expect(compactRules).not.toContain('.toolbar > .search-box');
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
