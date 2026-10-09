import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WorkspaceHeader, type WorkspaceHeaderProps } from '../../src/webview/workspace-header';

const status: WorkspaceHeaderProps = {
  children: React.createElement('button', { 'aria-label': 'Rebuild index' }, 'Rebuild'),
  indexedBytes: '512',
  sizeBytes: '1024',
  indexedRecords: '24',
  validRecords: '22',
  problemRecords: '2',
  complete: true,
  phase: 'ready',
  appendPending: false,
  rebuildBusy: false,
  onRebuild: () => undefined,
  onOpenNavigator: () => undefined,
};

function render(overrides: Partial<WorkspaceHeaderProps> = {}): string {
  return renderToStaticMarkup(React.createElement(WorkspaceHeader, { ...status, ...overrides }));
}

describe('workspace header status', () => {
  it('places the bounded status region before controls in the wide-layout DOM order', () => {
    const markup = render();

    expect(markup.indexOf('<div class="status-strip"')).toBeGreaterThanOrEqual(0);
    expect(markup.indexOf('<div class="status-strip"')).toBeLessThan(markup.indexOf('<div class="toolbar"'));
    expect(markup).toContain('role="status" aria-live="polite"');
  });

  it('keeps file identity outside the header and labels observed problems', () => {
    const markup = render();

    expect(markup).toContain('<header class="workspace-header"');
    expect(markup).toContain('aria-label="Workspace controls and status"');
    expect(markup).toContain('aria-label="Open Agent Sessions"');
    expect(markup).toContain('24 rows');
    expect(markup).toContain('512 B / 1.0 KB');
    expect(markup).toContain('2 problem records observed during hydration; not a complete-file total');
    expect(markup).toContain('2</span><span class="status-scope">records observed');
    expect(markup).toContain('aria-label="50% indexed"');
    expect(markup).not.toContain('status-file');
    expect(markup).not.toContain('Update pending');
    expect(markup.match(/>Rebuild<\/button>/g)).toHaveLength(1);
  });

  it('shows a nonblocking pending notice with one active Rebuild control', () => {
    const markup = render({ children: null, appendPending: true, phase: 'snapshot' });

    expect(markup).toContain('Update pending');
    expect(markup).toContain('The current snapshot remains readable; rebuild to include appended records.');
    expect(markup).toContain('2 problem records observed during hydration; not a complete-file total');
    expect(markup).toContain('aria-label="Rebuild index to include appended records"');
    expect(markup).toContain('title="Rebuild index to include appended records"');
    expect(markup.match(/>Rebuild<\/span>/g)).toHaveLength(1);
  });

  it('disables the pending action while rebuilding and keeps incomplete progress visible', () => {
    const markup = render({
      children: null,
      appendPending: true,
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
