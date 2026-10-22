import type React from 'react';
import type { TemporaryPreviewStatus } from '../../../shared/types';
import { TemporaryPreviewActions } from '../../temporary-preview-actions';
import { ColumnChooser, type ColumnChooserProps } from './ColumnChooser';
import { RecordQueryControls, type RecordQueryControlsProps } from './RecordQueryControls';
import { RowTypeChooser, type RowTypeChooserProps } from './RowTypeChooser';

export interface TableQueryToolbarProps {
  previewStatus: TemporaryPreviewStatus | undefined;
  onSaveAs: () => void;
  queryControls: RecordQueryControlsProps;
  rowTypes: Pick<RowTypeChooserProps, 'sources' | 'selection' | 'disabled' | 'onChange'>;
  showColumns: boolean;
  columns: ColumnChooserProps;
}

/**
 * Render-only seam for the table query controls. Query state and side effects
 * remain owned by App and arrive here as explicit child props and callbacks.
 */
export function TableQueryToolbar({
  previewStatus,
  onSaveAs,
  queryControls,
  rowTypes,
  showColumns,
  columns,
}: TableQueryToolbarProps): React.JSX.Element {
  return (
    <fieldset className="table-query-toolbar" aria-label="Table search and display">
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
