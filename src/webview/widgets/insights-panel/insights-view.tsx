import React, { useId } from 'react';
import {
  CategoryChart,
  formatBucketStart,
  formatCount,
  safeCount,
  TimeChart,
  type InsightCategory,
  type InsightTimeBucket,
} from './insights-chart';

export interface InsightsViewProps {
  categories: readonly InsightCategory[];
  timeBuckets: readonly InsightTimeBucket[];
  loading: boolean;
  error?: string | undefined;
  cancelled?: boolean | undefined;
}

const MAX_TABLE_ROWS = 64;

export function InsightsView({
  categories,
  timeBuckets,
  loading,
  error,
  cancelled = false,
}: InsightsViewProps): React.JSX.Element {
  if (cancelled) {
    return <InsightsState kind="cancelled" message="Aggregate request cancelled" />;
  }
  if (error !== undefined && error.length > 0) {
    return <InsightsState kind="error" message={error} />;
  }
  if (loading) {
    return <InsightsState kind="loading" message="Loading aggregates" busy />;
  }
  if (categories.length === 0 && timeBuckets.length === 0) {
    return <InsightsState kind="empty" message="No aggregate data for the current query" />;
  }

  return (
    <div className="insights-view" aria-busy="false">
      <div className="insights-grid">
        {categories.length > 0 ? <CategoryPanel categories={categories} /> : null}
        {timeBuckets.length > 0 ? <TimePanel buckets={timeBuckets} /> : null}
      </div>
    </div>
  );
}

function InsightsState({
  kind,
  message,
  busy = false,
}: {
  kind: 'loading' | 'error' | 'cancelled' | 'empty';
  message: string;
  busy?: boolean;
}): React.JSX.Element {
  return (
    <div className="insights-view" aria-busy={busy}>
      <div
        className="insights-state"
        data-kind={kind}
        role={kind === 'error' ? 'alert' : 'status'}
        aria-live={kind === 'error' ? 'assertive' : 'polite'}
      >
        {message}
      </div>
    </div>
  );
}

function CategoryPanel({ categories }: { categories: readonly InsightCategory[] }): React.JSX.Element {
  const headingId = useId();
  const visible = categories.slice(0, MAX_TABLE_ROWS);
  const approximate = categories.some((category) => category.approximate === true);
  return (
    <section className="insights-panel" aria-labelledby={headingId}>
      <header className="insights-panel-header">
        <h2 className="insights-panel-title" id={headingId}>Categories</h2>
        <span className="insights-panel-meta">
          {String(categories.length)} values{approximate ? ' · approximate counts' : ''}
        </span>
      </header>
      <CategoryChart categories={categories} />
      <div className="insights-readout">
        <table className="insights-table">
          <caption>Category aggregate values</caption>
          <thead>
            <tr><th scope="col">Category</th><th scope="col">Count</th></tr>
          </thead>
          <tbody>
            {visible.map((category, index) => (
              <tr key={`${category.label}:${String(index)}`}>
                <th scope="row" title={category.label}>{category.label}</th>
                <td className="insights-number">
                  {category.approximate === true ? (
                    <span className="insights-approximate" aria-label={`approximately ${formatCount(category.count)}`}>
                      <span aria-hidden="true">~</span>{formatCount(category.count)}
                    </span>
                  ) : formatCount(category.count)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {visible.length < categories.length ? (
          <div className="insights-limit-note" role="note">
            Showing {String(visible.length)} of {String(categories.length)} categories
          </div>
        ) : null}
      </div>
    </section>
  );
}

function TimePanel({ buckets }: { buckets: readonly InsightTimeBucket[] }): React.JSX.Element {
  const headingId = useId();
  const visible = buckets.slice(0, MAX_TABLE_ROWS);
  const total = buckets.reduce((sum, bucket) => sum + safeCount(bucket.count), 0);
  return (
    <section className="insights-panel" aria-labelledby={headingId}>
      <header className="insights-panel-header">
        <h2 className="insights-panel-title" id={headingId}>Time distribution</h2>
        <span className="insights-panel-meta">{String(buckets.length)} buckets · {formatCount(total)} records</span>
      </header>
      <TimeChart buckets={buckets} />
      <div className="insights-readout">
        <table className="insights-table">
          <caption>Time bucket aggregate values</caption>
          <thead>
            <tr><th scope="col">Bucket start</th><th scope="col">Count</th></tr>
          </thead>
          <tbody>
            {visible.map((bucket, index) => (
              <tr key={`${bucket.start}:${String(index)}`}>
                <th scope="row" title={bucket.start}>{formatBucketStart(bucket.start)}</th>
                <td className="insights-number">{formatCount(bucket.count)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {visible.length < buckets.length ? (
          <div className="insights-limit-note" role="note">
            Showing {String(visible.length)} of {String(buckets.length)} time buckets
          </div>
        ) : null}
      </div>
    </section>
  );
}
