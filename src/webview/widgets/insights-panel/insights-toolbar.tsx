import type React from 'react';
import { RefreshCw } from 'lucide-react';
import type { InsightDimension, InsightScope, InsightSummary } from '../../../shared/types';
import { formatScanLimit } from '../../features/record-query/model';

export interface InsightsToolbarProps {
  dimension: InsightDimension;
  scope: InsightScope;
  disabled: boolean;
  pending: boolean;
  result?: InsightSummary | undefined;
  onDimensionChange(dimension: InsightDimension): void;
  onScopeChange(scope: InsightScope): void;
  onRefresh(): void;
}

export function InsightsToolbar({ dimension, scope, disabled, pending, result,
  onDimensionChange, onScopeChange, onRefresh }: InsightsToolbarProps): React.JSX.Element {
  return (
    <div className="insights-toolbar">
      <label className="compact-field">
        <span>Group by</span>
        <select value={dimension} disabled={disabled}
          onChange={(event) => onDimensionChange(event.target.value as InsightDimension)}>
          <option value="eventKind">Event</option>
          <option value="severity">Severity</option>
          <option value="service">Service</option>
          <option value="status">Status</option>
        </select>
      </label>
      <label className="compact-field">
        <span>Scope</span>
        <select value={scope} disabled={disabled}
          onChange={(event) => onScopeChange(event.target.value as InsightScope)}>
          <option value="current-view">Current view</option>
          <option value="whole-file">Whole file</option>
        </select>
      </label>
      <span className="insights-meta" role="status">
        {result === undefined ? '' : formatInsightProvenance(result)}
      </span>
      <button type="button" className="icon-button" title="Refresh aggregates"
        aria-label="Refresh aggregates" disabled={disabled || pending} onClick={onRefresh}>
        <RefreshCw size={14} className={pending ? 'spin' : ''} aria-hidden />
      </button>
    </div>
  );
}

export function formatInsightProvenance(result: InsightSummary): string {
  const scope = result.provenance.scope === 'current-view' ? 'Current view' : 'Whole file';
  const coverage = result.provenance.coverage === 'complete' ? 'complete scan' : 'bounded sample';
  const limit = result.truncatedReason === undefined ? (result.truncated ? ' · limited' : '')
    : ` · ${formatScanLimit(result.truncatedReason)}`;
  return `${scope} · ${coverage} · ${result.examinedRecords} examined · ${result.processedRecords} matched`
    + limit + (result.capacityReached ? ' · grouped overflow' : '');
}
