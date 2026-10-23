import type React from 'react';
import type { TemporaryPreviewStatus } from '@shared/types';
import { TemporaryPreviewActions } from '@widgets/workspace-header';
import { ColumnChooser, type ColumnChooserProps } from './ColumnChooser';
import { RecordQueryControls, type RecordQueryControlsProps } from './RecordQueryControls';
import { RowTypeChooser, type RowTypeChooserProps } from './RowTypeChooser';

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
        <TemporaryPreviewActions status={previewStatus} onSaveAs={onSaveAs} />
      </div> : null}
      <RecordQueryControls {...queryControls} />
      <RowTypeChooser {...rowTypes} />
      {showColumns ? <ColumnChooser {...columns} /> : null}
      <small className="table-query-scope">Search and filters query this file together in bounded scans. Results appear in this view.</small>
    </fieldset>
  );
}
