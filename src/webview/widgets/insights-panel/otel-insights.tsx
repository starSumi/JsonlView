import type React from 'react';
import { useId } from 'react';
import type { OpenTelemetrySampleSummary } from '@shared/otel-insights';
import { formatCount } from './insights-chart';

export function OpenTelemetryInsights({ summary }: { summary: OpenTelemetrySampleSummary }): React.JSX.Element {
  const headingId = useId();
  const { coverage } = summary;
  return (
    <section className="insights-panel" aria-labelledby={headingId} data-insight-kind="opentelemetry">
      <header className="insights-panel-header">
        <h2 className="insights-panel-title" id={headingId}>OpenTelemetry insights</h2>
        <span className="insights-panel-meta">
          Current query page · {formatCount(coverage.sampledRecords)} of {formatCount(coverage.requestedRecords)} physical rows{coverage.partial ? ' · partial sample' : ''}
        </span>
      </header>
      <p className="insights-limit-note">
        OTLP envelopes remain physical rows. Nested spans, logs, metrics and data points are bounded observations; Raw remains authoritative for the complete payload.
      </p>
      <div className="insights-grid">
        <CountTable caption="Signals" values={summary.signals} />
        <CountTable caption="Nested records" values={{ physicalRows: coverage.sampledRecords, nestedRecords: summary.nestedRecords, spans: summary.spanCount, traces: summary.traceCount, logs: summary.logCount, metrics: summary.metricCount, dataPoints: summary.dataPointCount, errors: summary.errorCount }} />
        <CountTable caption="Span kinds" values={summary.spanKinds} empty="No spans observed" />
        <CountTable caption="Metric kinds" values={summary.metricKinds} empty="No metrics observed" />
        <CountTable caption="Duration and quality" values={{ durationMs: summary.durationMs, invalidRecords: coverage.invalidRecords }} />
      </div>
      {summary.operations.length > 0 ? <NameTable caption="Observed operations" entries={summary.operations} /> : null}
      {summary.services.length > 0 ? <NameTable caption="Observed services" entries={summary.services} /> : null}
      <p className="insights-limit-note">
        {formatCount(coverage.recognizedRecords)} recognized · {formatCount(coverage.validRecords)} valid physical rows{summary.truncated ? ' · nested inspection budget reached' : ''}.
      </p>
    </section>
  );
}

function CountTable({ caption, values, empty = 'None observed' }: { caption: string; values: Record<string, number>; empty?: string }): React.JSX.Element {
  const entries = Object.entries(values).filter(([, value]) => value > 0).slice(0, 32);
  return (
    <table className="insights-table">
      <caption>{caption}</caption>
      <thead><tr><th scope="col">Observation</th><th scope="col">Count</th></tr></thead>
      <tbody>{entries.length === 0 ? <tr><td colSpan={2}>{empty}</td></tr> : entries.map(([label, value]) => (
        <tr key={label}><th scope="row">{label.replaceAll(/([a-z])([A-Z])/g, '$1 $2').replaceAll('-', ' ')}</th><td className="insights-number">{formatCount(value)}</td></tr>
      ))}</tbody>
    </table>
  );
}

function NameTable({ caption, entries }: { caption: string; entries: ReadonlyArray<{ value: string; count: number }> }): React.JSX.Element {
  return (
    <table className="insights-table">
      <caption>{caption}</caption>
      <thead><tr><th scope="col">Name</th><th scope="col">Rows</th></tr></thead>
      <tbody>{entries.slice(0, 32).map((entry) => <tr key={entry.value}><th scope="row" title={entry.value}>{entry.value}</th><td className="insights-number">{formatCount(entry.count)}</td></tr>)}</tbody>
    </table>
  );
}
