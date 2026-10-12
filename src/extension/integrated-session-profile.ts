import type { AgentProfileRegistry } from '../profiles';
import type { ColumnSpec, JsonScalar } from '../shared/types';
import { MAX_TABLE_COLUMNS } from '../shared/types';

/**
 * Pure profile policy used by the session facade. It owns presentation
 * metadata, while IntegratedJsonlSession keeps lifecycle and engine state.
 */
export function mergeRequestedColumns(
  profile: readonly ColumnSpec[],
  requested: readonly ColumnSpec[],
): ColumnSpec[] {
  const columns: ColumnSpec[] = [];
  const seen = new Set<string>();
  for (const column of [...profile, ...requested]) {
    if (seen.has(column.id)) continue;
    seen.add(column.id);
    columns.push(column);
    if (columns.length >= MAX_TABLE_COLUMNS) break;
  }
  return columns;
}

export function profileColumns(profileId: string): readonly ColumnSpec[] {
  const column = (id: string, label: string, width: number): ColumnSpec => ({
    id,
    label,
    source: 'profile',
    width,
  });
  if (profileId === 'generic') return [];
  if (profileId === 'opentelemetry') {
    return [
      column('eventKind', 'Signal', 88),
      column('timestamp', 'Timestamp', 190),
      column('severity', 'Severity', 86),
      column('summary', 'Summary', 320),
      column('service', 'Service', 140),
    ];
  }
  if (profileId === 'structured-application-log') {
    return [
      column('timestamp', 'Timestamp', 190),
      column('severity', 'Level', 78),
      column('summary', 'Message', 340),
      column('service', 'Service', 140),
      column('logger', 'Logger', 150),
    ];
  }
  if (profileId === 'software-engineering-agent') {
    return [
      column('eventKind', 'Event', 100),
      column('summary', 'Summary', 320),
      column('task', 'Task', 150),
      column('step', 'Step', 86),
      column('tool', 'Tool', 120),
      column('status', 'Status', 100),
    ];
  }
  if (profileId === 'codex-history') {
    return [
      column('eventKind', 'Event', 104),
      column('timestamp', 'Timestamp', 190),
      column('actor', 'Actor', 88),
      column('summary', 'Message', 360),
      column('sessionId', 'Session', 180),
      column('sourceKind', 'Source', 110),
    ];
  }
  if (profileId === 'codex-session-index') {
    return [
      column('eventKind', 'Event', 104),
      column('timestamp', 'Updated', 190),
      column('summary', 'Thread', 320),
      column('sessionId', 'Session', 180),
      column('threadName', 'Thread name', 220),
      column('sourceKind', 'Source', 120),
    ];
  }
  if (profileId === 'codex-exec-jsonl') {
    return [
      column('eventKind', 'Event', 120),
      column('summary', 'Summary', 360),
      column('actor', 'Actor', 92),
      column('status', 'Status', 110),
      column('sessionId', 'Thread', 180),
      column('model', 'Model', 130),
    ];
  }
  if (profileId === 'codex-trace') {
    return [
      column('eventKind', 'Event', 120),
      column('timestamp', 'Timestamp', 190),
      column('summary', 'Summary', 360),
      column('actor', 'Actor', 92),
      column('status', 'Status', 110),
      column('sessionId', 'Thread', 180),
      column('turnId', 'Turn', 170),
    ];
  }
  return [
    column('eventKind', 'Event', 104),
    column('timestamp', 'Timestamp', 190),
    column('actor', 'Actor', 88),
    column('summary', 'Summary', 340),
    column('status', 'Status', 100),
    column('model', 'Model', 130),
  ];
}

export function profilePredicateFields(
  projection: ReturnType<AgentProfileRegistry['project']>,
): Record<string, JsonScalar | undefined> {
  return {
    ...projection.derivedFields,
    profileId: projection.profileId,
    eventKind: projection.eventKind,
    timestamp: projection.timestamp,
    actor: projection.actor,
    sessionId: projection.sessionId,
    turnId: projection.turnId,
    parentId: projection.parentId,
    messageId: projection.messageId,
    toolCallId: projection.toolCallId,
    subagentId: projection.subagentId,
    model: projection.model,
    status: projection.status,
    severity: projection.severity,
    summary: projection.summary,
    confidence: projection.confidence,
    usageInput: projection.usage?.input,
    usageOutput: projection.usage?.output,
    usageCached: projection.usage?.cached,
    usageTotal: projection.usage?.total,
  };
}
