import type React from 'react';
import { useRef } from 'react';
import { Ellipsis } from 'lucide-react';
import type { TemporaryPreviewStatus } from '@shared/types';
import { TemporaryPreviewBadge, TemporaryPreviewSaveAction } from '@widgets/workspace-header';
import { useLightDismiss } from '@webview/shared/hooks/use-light-dismiss';
import { ColumnChooser, type ColumnChooserProps } from './ColumnChooser';
import { RecordQueryControls, type RecordQueryControlsProps } from './RecordQueryControls';
import type { RowTypeChooserProps } from './RowTypeChooser';

export interface CompactQueryHudProps {
  previewStatus: TemporaryPreviewStatus | undefined;
  onSaveAs: () => void;
  queryControls: RecordQueryControlsProps;
  rowTypes: Pick<RowTypeChooserProps, 'sources' | 'selection' | 'disabled' | 'onChange'>;
  showColumns: boolean;
  columns: ColumnChooserProps;
}

/**
 * Render-only query surface. Query state and side effects stay in App and
 * RowQueryController; this component only composes the existing controls.
 */
export function CompactQueryHud({
  previewStatus,
  onSaveAs,
  queryControls,
  rowTypes,
  showColumns,
  columns,
}: CompactQueryHudProps): React.JSX.Element {
  return (
    <fieldset
      className="table-query-toolbar"
      data-query-hud="compact"
      aria-label="Table search and display"
    >
      {previewStatus ? <div className="preview-lifecycle-actions">
        <TemporaryPreviewBadge status={previewStatus} />
      </div> : null}
      <RecordQueryControls {...queryControls} rowTypes={showColumns ? undefined : rowTypes} />
      {previewStatus || showColumns ? <QueryMoreActions rowTypeCount={showColumns ? rowTypes.selection?.values.length : undefined}>
        {previewStatus ? <TemporaryPreviewSaveAction status={previewStatus} onSaveAs={onSaveAs} /> : null}
        {showColumns ? <ColumnChooser {...columns} rowTypes={rowTypes} /> : null}
      </QueryMoreActions> : null}
      <small className="table-query-scope">Search and filters query this file together in bounded scans. Results appear in this view.</small>
    </fieldset>
  );
}

export function QueryMoreActions({ children, rowTypeCount = 0 }: {
  children: React.ReactNode;
  rowTypeCount?: number | undefined;
}): React.JSX.Element {
  const menuRef = useRef<HTMLDetailsElement>(null);
  useLightDismiss(menuRef);
  return <details className="filter-menu more-actions-menu" ref={menuRef}>
    <summary className={`query-tool-button${rowTypeCount ? ' is-active' : ''}`} aria-label="More actions"
      title="More actions: save a copy, columns and row types"
      aria-description={rowTypeCount ? `${rowTypeCount} row types selected in Columns` : undefined}>
      <Ellipsis size={15} aria-hidden /><span className="query-tool-label">More</span>
      {rowTypeCount ? <span className="query-tool-count" aria-hidden="true">({rowTypeCount})</span> : null}
    </summary>
    <div className="filter-popover more-actions-popover" data-popover-width="300" data-popover-height="480">
      {children}
    </div>
  </details>;
}
