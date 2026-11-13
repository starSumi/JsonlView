import type React from 'react';
import type { BfclV3SampleSummary } from '@shared/bfcl-v3-insights';
import type { DatasetSampleSummary } from '@shared/dataset-analysis';
import type { OpenTelemetrySampleSummary } from '@shared/otel-insights';
import { BfclInsights } from './bfcl-insights';
import { DatasetInsights } from './dataset-insights';
import { InsightsToolbar, type InsightsToolbarProps } from './insights-toolbar';
import { InsightsView } from './insights-view';
import { OpenTelemetryInsights } from './otel-insights';

export interface InsightsPanelProps extends InsightsToolbarProps {
  showAggregates: boolean;
  aggregateError?: string | undefined;
  projectionStatus?: 'pending' | 'failed' | undefined;
  bfclSummary?: BfclV3SampleSummary | undefined;
  opentelemetrySummary?: OpenTelemetrySampleSummary | undefined;
  datasetSummary?: DatasetSampleSummary | undefined;
  onRetryProjection(): void;
}

/** Presentation only: the workspace owns query intent and projection retries. */
export function InsightsPanel({
  showAggregates,
  aggregateError,
  projectionStatus,
  bfclSummary,
  opentelemetrySummary,
  datasetSummary,
  onRetryProjection,
  ...toolbar
}: InsightsPanelProps): React.JSX.Element {
  return (
    <div className={`insights-shell${showAggregates ? '' : ' insights-shell-single'}`}>
      {showAggregates ? <InsightsToolbar {...toolbar} /> : null}
      <div className="insights-content">
        {showAggregates ? (
          <InsightsView
            categories={toolbar.result?.categories ?? []}
            timeBuckets={toolbar.result?.timeBuckets ?? []}
            loading={toolbar.pending}
            error={aggregateError}
          />
        ) : null}
        {projectionStatus !== undefined ? (
          <div className="insights-transition-status" role="status">
            <span>{projectionStatus === 'failed'
              ? 'The requested query page could not be loaded. The previous page is retained.'
              : 'Preparing current-query-page dataset insights...'}</span>
            {projectionStatus === 'failed' ? (
              <button type="button" onClick={onRetryProjection}>Retry</button>
            ) : null}
          </div>
        ) : null}
        {bfclSummary !== undefined ? (
          <div className="bfcl-insights-scroll">
            <BfclInsights summary={bfclSummary} />
          </div>
        ) : null}
        {opentelemetrySummary !== undefined ? (
          <div className="bfcl-insights-scroll">
            <OpenTelemetryInsights summary={opentelemetrySummary} />
          </div>
        ) : null}
        {datasetSummary !== undefined ? <DatasetInsights summary={datasetSummary} /> : null}
      </div>
    </div>
  );
}
