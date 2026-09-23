import React from 'react';
import { AlertTriangle } from 'lucide-react';
import type { RowScanStats, RowSort } from '../../../shared/types';
import { formatScanLimit, isPhysicalOrdinalSort } from './model';

export interface RecordQueryBannerProps {
  scan?: RowScanStats | undefined;
  sort?: RowSort | undefined;
}

export function RecordQueryBanner({ scan, sort }: RecordQueryBannerProps): React.JSX.Element | null {
  if (scan?.truncatedReason === undefined) return null;
  return (
    <div className="workspace-banner query-limit-banner" role="status">
      <AlertTriangle size={15} aria-hidden />
      <span>
        This result is partial: the scan reached its {formatScanLimit(scan.truncatedReason)} allowance
        ({scan.examinedRecords} records examined).
        {sort === undefined
          ? scan.cursorOrdinal === undefined
            ? ' No physical cursor was established; narrow the query or retry.'
            : scan.direction === 'backward'
              ? ' Previous continues from the physical scan cursor.'
              : ' Next continues from the physical scan cursor.'
          : isPhysicalOrdinalSort(sort)
            ? ` This physical ${sort.direction === 'desc' ? 'reverse' : 'forward'} page is partial: only ${scan.examinedRecords} records were examined.`
            : ` This sorted order is partial: only ${scan.examinedRecords} records were examined. `
              + 'The visible order is guaranteed only within the retained sorted window; use Next to inspect that window.'}
      </span>
    </div>
  );
}
