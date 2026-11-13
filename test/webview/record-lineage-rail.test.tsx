import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { projectRecordLineage } from '../../src/webview/features/record-lineage/model';
import { buildLineageRail } from '../../src/webview/features/record-lineage/rail-model';
import { LineageView } from '../../src/webview/features/record-lineage/LineageView';
import { lineageEvidence as evidence, lineageRow as row } from '../support/lineage-fixtures';

function chain() {
  const metadata = row(116, { parentId: 'missing', eventKind: 'checkpoint', actor: 'system', derivedFields: { sourceType: 'attachment', attachmentType: 'token_usage' },
    evidence: [evidence('messageId', 'uuid'), evidence('parentId', 'parentUuid'), evidence('sourceType', 'type'), evidence('attachmentType', 'attachment', 'type')] });
  const assistant = row(117, { parentId: 'm116', actor: 'assistant', evidence: [evidence('messageId', 'uuid'), evidence('parentId', 'parentUuid')] });
  const duration = row(118, { parentId: 'm117', eventKind: 'checkpoint', actor: 'system', derivedFields: { sourceType: 'system', sourceSubtype: 'turn_duration', durationMs: 5200 },
    evidence: [evidence('messageId', 'uuid'), evidence('parentId', 'parentUuid'), evidence('sourceType', 'type'), evidence('sourceSubtype', 'subtype'), evidence('durationMs', 'durationMs')] });
  const selected = row(119, { parentId: 'm118', eventKind: 'checkpoint', summary: '<script>away summary</script>',
    evidence: [evidence('messageId', 'uuid'), evidence('parentId', 'parentUuid')] });
  return { metadata, assistant, duration, selected, rows: [metadata, assistant, duration, selected] };
}
describe('source-evidenced causal rail', () => {
  it('folds only chain metadata, keeps real references and the selected summary, and exposes the unknown parent without a fake ordinal', () => {
    const f = chain(); const projection = projectRecordLineage(f.rows, f.selected.ref); const rail = buildLineageRail(projection);
    expect(rail.entries.map((entry) => entry.key)).toEqual(['117', '119']);
    expect(rail.metadataCount).toBe(2);
    expect(rail.entries[0]).toMatchObject({ badges: [{ node: { ref: f.metadata.ref } }, { node: { ref: f.duration.ref }, label: '5.2 s' }] });
    expect(rail.gaps).toMatchObject([{ node: { ref: f.metadata.ref }, label: 'missing' }]);
    const html = renderToStaticMarkup(<LineageView projection={projection} unavailableReason={undefined} onSelectRecord={() => {}} />);
    expect(html).toContain('aria-current="true"'); expect(html).toContain('&lt;script&gt;away summary&lt;/script&gt;');
    expect(html).toContain('its location is unknown'); expect(html).not.toContain('Record #12');
  });
  it('never folds the selected metadata or a metadata node at a fork', () => {
    const f = chain(); const selected = buildLineageRail(projectRecordLineage(f.rows, f.duration.ref));
    expect(selected.entries.some((entry) => entry.kind === 'record' && entry.node.ref.ordinal === '118')).toBe(true);
    const sibling = row(120, { parentId: 'm116', evidence: [evidence('messageId', 'uuid'), evidence('parentId', 'parentUuid')] });
    const fork = buildLineageRail(projectRecordLineage([...f.rows, sibling], f.assistant.ref));
    expect(fork.entries.some((entry) => entry.kind === 'record' && entry.node.ref.ordinal === '116')).toBe(true);
  });
  it('does not fold unsupported or unverified summaries resembling metadata', () => {
    const f = chain(); f.metadata.profile!.evidence = [evidence('messageId', 'uuid'), evidence('parentId', 'parentUuid')];
    const rail = buildLineageRail(projectRecordLineage(f.rows, f.selected.ref));
    expect(rail.metadataCount).toBe(1);
    expect(rail.entries.some((entry) => entry.kind === 'record' && entry.key === '116')).toBe(true);
  });
  it('groups tool siblings by the explicit shared parent, and never by adjacent source order', () => {
    const parent = row(1); const tools = [2, 3, 4].map((n) => row(n, { eventKind: 'tool_call', parentId: 'm1',
      evidence: [evidence('messageId', 'uuid'), evidence('parentId', 'parentUuid')] }));
    const rail = buildLineageRail(projectRecordLineage([parent, ...tools], parent.ref));
    expect(rail.entries[1]).toMatchObject({ kind: 'branch', label: '3 tool calls · shared parent', records: tools.map((tool) => ({ node: { ref: tool.ref } })) });
    const unrelated = row(5, { eventKind: 'tool_call' });
    expect(buildLineageRail(projectRecordLineage([parent, unrelated], unrelated.ref)).entries).toHaveLength(1);
  });
  it('keys OpenTelemetry span parents by trace and span, with no cross-trace or all-zero root edge', () => {
    const span = (n: number, trace: string, id: string, parent?: string) => row(n, { profileId: 'opentelemetry', eventKind: 'span', sessionId: trace,
      turnId: id, messageId: id, ...(parent === undefined ? {} : { parentId: parent }), evidence: [evidence('sessionId', 'traceId'),
        evidence('messageId', 'spanId'), ...(parent === undefined ? [] : [evidence('parentId', 'parentSpanId')])] });
    const parent = span(1, 'trace-a', 'span-a'); const other = span(2, 'trace-b', 'span-a'); const child = span(3, 'trace-a', 'span-b', 'span-a');
    expect(projectRecordLineage([parent, other, child], child.ref).edges).toEqual([{ from: parent.ref, to: child.ref, kind: 'parent' }]);
    const root = span(4, 'trace-a', 'span-root', '00000000');
    expect(projectRecordLineage([root], root.ref).coverage.reasons).toEqual([]);
    const log = (n: number) => row(n, { profileId: 'opentelemetry', eventKind: 'log', sessionId: 'trace-a', turnId: 'span-b',
      parentId: 'span-b', evidence: [evidence('sessionId', 'traceId'), evidence('parentId', 'spanId')] });
    const firstLog = log(5); const secondLog = log(6);
    const withLogs = projectRecordLineage([parent, child, firstLog, secondLog], child.ref);
    expect(withLogs.edges.filter((edge) => edge.kind === 'span-context')).toHaveLength(2);
    expect(buildLineageRail(withLogs).metadataCount).toBe(2);
    expect(buildLineageRail(projectRecordLineage([child, firstLog, secondLog], firstLog.ref)).entries
      .some((entry) => entry.kind === 'record' && entry.node.ref.ordinal === '5')).toBe(true);
  });
});
