import React from 'react';
import { AlertTriangle, X } from 'lucide-react';
import type { RowScanStats, RowSort } from '../../../shared/types';
import { formatScanLimit, isPhysicalOrdinalSort } from './model';

export interface RecordQueryBannerProps {
  scan?: RowScanStats | undefined;
  sort?: RowSort | undefined;
  pageIdentity?: string | undefined;
}

export function buildRecordQueryBannerIdentity(
  scan: RowScanStats | undefined,
  sort: RowSort | undefined,
  pageIdentity: string | undefined,
): string | undefined {
  if (scan?.truncatedReason === undefined) return undefined;
  return [
    pageIdentity ?? '',
    sort?.columnId ?? '',
    sort?.direction ?? '',
    scan.truncatedReason,
    scan.examinedRecords,
    scan.examinedBytes,
    scan.cursorOrdinal ?? '',
    scan.direction ?? '',
  ].join('|');
}

export function RecordQueryBanner({ scan, sort, pageIdentity }: RecordQueryBannerProps): React.JSX.Element | null {
  const identity = buildRecordQueryBannerIdentity(scan, sort, pageIdentity);
  const [dismissedIdentity, setDismissedIdentity] = React.useState<string | undefined>();
  React.useEffect(() => {
    setDismissedIdentity(undefined);
  }, [identity]);

  if (scan?.truncatedReason === undefined) return null;
  if (identity !== undefined && dismissedIdentity === identity) return null;

  const physicalHydrationLimited = isPhysicalOrdinalSort(sort) && scan.truncatedReason === 'hydration_limit';
  const message = physicalHydrationLimited
    ? 'Page contains ' + scan.examinedRecords + ' records because the page hydration budget was reached. The physical order remains exact; use Next to continue in the same order.'
    : (
      <>
        This result is partial: the scan reached its {formatScanLimit(scan.truncatedReason)} allowance
        ({scan.examinedRecords} records examined).
        {sort === undefined
          ? scan.cursorOrdinal === undefined
            ? ' No physical cursor was established; narrow the query or retry.'
            : scan.direction === 'backward'
              ? ' Previous continues from the physical scan cursor.'
              : ' Next continues from the physical scan cursor.'
          : isPhysicalOrdinalSort(sort)
            ? ' This physical ' + (sort.direction === 'desc' ? 'reverse' : 'forward') + ' page is bounded; use Next to continue.'
            : ' This sorted order is partial: only ' + scan.examinedRecords + ' records were examined. '
              + 'The visible order is guaranteed only within the retained sorted window; use Next to inspect that window.'}
      </>
    );

  return (
    <div className="workspace-banner query-limit-banner" role="status">
      <AlertTriangle size={15} aria-hidden />
      <span>{message}</span>
      <button
        type="button"
        className="icon-button"
        title="Dismiss partial-result notice"
        aria-label="Dismiss partial-result notice"
        onClick={() => {
          if (identity !== undefined) setDismissedIdentity(identity);
        }}
      >
        <X size={14} aria-hidden />
      </button>
    </div>
  );
}
