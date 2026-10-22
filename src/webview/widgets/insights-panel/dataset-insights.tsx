import type React from 'react';
import { useId } from 'react';
import type { DatasetNumericSummary, DatasetSampleSummary } from '../../../shared/dataset-analysis';
import { formatCount } from './insights-chart';

/** Separate from file aggregates: these observations belong to the loaded row page. */
export function DatasetInsights({ summary }: { summary: DatasetSampleSummary }): React.JSX.Element {
  const headingId = useId();
  const { coverage, messages } = summary;
  const limited = coverage.partial || messages.truncated;
  return (
    <section className="insights-panel" aria-labelledby={headingId}>
      <header className="insights-panel-header">
        <h2 className="insights-panel-title" id={headingId}>Dataset observations</h2>
        <span className="insights-panel-meta">
          {summary.scope === 'visible-page' ? 'Current page sample' : 'Observed sample'} · {formatCount(coverage.sampledRecords)} of {formatCount(coverage.requestedRecords)} records{limited ? ' · partial inspection' : ''}
        </span>
      </header>
      <p className="insights-limit-note">
        These observations describe loaded records, not the whole file. Array lengths are observed; token counts and loss weights are source declarations. No tokenizer or trainer configuration is inferred.
      </p>
      <div className="insights-grid">
        <CountTable caption="Record scenes" values={summary.scenes} />
        <CountTable caption="Target presence" values={summary.targets} />
        <CountTable caption="Structural observations" values={summary.issues} empty="No structural issues observed in inspected fields" />
        <CountTable caption="Observed message roles" values={messages.roles} />
        <CountTable caption="Declared message loss weights" values={messages.lossWeights} />
        <CountTable caption="Inert media references" values={summary.media} />
      </div>
      {summary.tokenLengths.length > 0 ? <NumericTable caption="Observed token array lengths" entries={summary.tokenLengths} /> : null}
      {summary.declaredTokenCounts.length > 0 ? <NumericTable caption="Declared token counts" entries={summary.declaredTokenCounts} /> : null}
      {summary.categories.slice(0, 4).map((category) => (
        <div key={category.field}>
          <table className="insights-table">
            <caption>{category.field} distribution · inspected sample</caption>
            <thead><tr><th scope="col">Value</th><th scope="col">Records</th></tr></thead>
            <tbody>{category.values.slice(0, 32).map(({ value, count }) => (
              <tr key={value}><th scope="row">{value}</th><td className="insights-number">{formatCount(count)}</td></tr>
            ))}</tbody>
          </table>
          {category.otherObservations > 0 ? <p className="insights-limit-note">{formatCount(category.otherObservations)} further observations outside the category limit</p> : null}
        </div>
      ))}
      <p className="insights-limit-note">
        {formatCount(coverage.validRecords)} valid records · {formatCount(coverage.invalidRecords)} invalid records · {formatCount(messages.observed)} of {formatCount(messages.total)} messages inspected. Media references remain unopened.
      </p>
    </section>
  );
}

function CountTable({ caption, values, empty = 'None observed' }: { caption: string; values: Record<string, number | undefined>; empty?: string }): React.JSX.Element {
  const entries = Object.entries(values).filter(([, count]) => count !== undefined && count > 0).slice(0, 32);
  return (
    <table className="insights-table">
      <caption>{caption}</caption>
      <thead><tr><th scope="col">Observation</th><th scope="col">Count</th></tr></thead>
      <tbody>{entries.length === 0 ? <tr><td colSpan={2}>{empty}</td></tr> : entries.map(([label, count]) => (
        <tr key={label}><th scope="row">{label.replaceAll('-', ' ')}</th><td className="insights-number">{formatCount(count ?? 0)}</td></tr>
      ))}</tbody>
    </table>
  );
}

function NumericTable({ caption, entries }: { caption: string; entries: ReadonlyArray<{ field: string; statistics: DatasetNumericSummary }> }): React.JSX.Element {
  return (
    <table className="insights-table">
      <caption>{caption}</caption>
      <thead><tr><th scope="col">Source field</th><th scope="col">Records</th><th scope="col">Min</th><th scope="col">Mean</th><th scope="col">Max</th></tr></thead>
      <tbody>{entries.slice(0, 4).map(({ field, statistics }) => (
        <tr key={field}><th scope="row">{field}</th><td>{formatCount(statistics.count)}</td><td>{formatCount(statistics.min)}</td><td>{Number.isFinite(statistics.mean) ? statistics.mean.toFixed(1) : 'Unavailable'}</td><td>{formatCount(statistics.max)}</td></tr>
      ))}</tbody>
    </table>
  );
}
