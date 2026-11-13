import type React from 'react';
import { useId } from 'react';
import type { BfclV3SampleSummary } from '@shared/bfcl-v3-insights';
import { formatCount } from './insights-chart';

export function BfclInsights({ summary }: { summary: BfclV3SampleSummary }): React.JSX.Element {
  const headingId = useId();
  const { coverage } = summary;
  return (
    <section className="insights-panel" aria-labelledby={headingId} data-insight-kind="bfcl-v3">
      <header className="insights-panel-header">
        <h2 className="insights-panel-title" id={headingId}>BFCL dataset insights</h2>
        <span className="insights-panel-meta">
          Current query page · {formatCount(coverage.sampledRecords)} of {formatCount(coverage.requestedRecords)} records{coverage.partial ? ' · partial sample' : ''}
        </span>
      </header>
      <p className="insights-limit-note">Bounded structural observations only. Function names, prompts, arguments, configuration values and benchmark answers are not retained.</p>
      <div className="insights-grid">
        <MetricTable caption="Evaluation rows" values={{ recognized: coverage.recognizedRecords, valid: coverage.validRecords, invalid: coverage.invalidRecords }} />
        <MetricTable caption="Single and multi-turn" values={summary.multiTurn} />
        <MetricTable caption="Function definitions" values={{ records: summary.functions.records, definitions: summary.functions.definitions, valid: summary.functions.validDefinitions, parameterSchemas: summary.functions.parameterObjects, requiredParameters: summary.functions.requiredParameters }} />
        <MetricTable caption="Tool definitions" values={{ records: summary.tools.records, definitions: summary.tools.definitions, valid: summary.tools.validDefinitions, parameterSchemas: summary.tools.parameterObjects, requiredParameters: summary.tools.requiredParameters }} />
        <MetricTable caption="Turn structure" values={{ records: summary.turns.records, turns: summary.turns.turns, messages: summary.turns.messages, invalidTurns: summary.turns.invalidTurns, ...summary.turns.roles }} />
        <MetricTable caption="Expected and missed calls" values={{ expectedGroups: summary.groundTruth.groups, expectedCalls: summary.groundTruth.calls, missedGroups: summary.missedFunctions.groups, missedCalls: summary.missedFunctions.calls }} />
        <MetricTable caption="Initial configuration" values={{ records: summary.initialConfig.records, keys: summary.initialConfig.keys, objects: summary.initialConfig.objects }} />
        <MetricTable caption="Involved classes" values={{ records: summary.involvedClasses.records, values: summary.involvedClasses.values, distinctValues: summary.involvedClasses.distinctValues }} />
      </div>
      {summary.distributions.map((distribution) => (
        <table className="insights-table" key={distribution.field}>
          <caption>{distribution.field} distribution</caption>
          <thead><tr><th scope="col">Value</th><th scope="col">Records</th></tr></thead>
          <tbody>{distribution.values.map((item) => <tr key={item.value}><th scope="row">{item.value}</th><td className="insights-number">{formatCount(item.count)}</td></tr>)}</tbody>
        </table>
      ))}
      <MetricTable caption="Quality issues" values={summary.issues} empty="No bounded issues observed" />
    </section>
  );
}

function MetricTable({ caption, values, empty = 'None observed' }: { caption: string; values: Record<string, number | undefined>; empty?: string }): React.JSX.Element {
  const entries = Object.entries(values).filter(([, value]) => value !== undefined && value > 0).slice(0, 32);
  return (
    <table className="insights-table">
      <caption>{caption}</caption>
      <thead><tr><th scope="col">Observation</th><th scope="col">Count</th></tr></thead>
      <tbody>{entries.length === 0 ? <tr><td colSpan={2}>{empty}</td></tr> : entries.map(([label, value]) => <tr key={label}><th scope="row">{label.replaceAll('-', ' ')}</th><td className="insights-number">{formatCount(value ?? 0)}</td></tr>)}</tbody>
    </table>
  );
}
