import type { AgentEvidence } from '../shared/types';
import type {
  AgentProfile,
  CorrelationEvidence,
  CorrelationInput,
  CorrelationKind,
  CorrelationRelation,
  CorrelationResult,
  CorrelationState,
} from './profile-contract';

export function createCorrelationState(profile: AgentProfile, generation: string): CorrelationState {
  return {
    key: correlationStateKey(profile.id, profile.version, generation),
    profileId: profile.id,
    profileVersion: profile.version,
    generation,
    records: emptyRecord(),
    messages: emptyRecord(),
    sessions: emptyRecord(),
    turns: emptyRecord(),
    tools: emptyRecord(),
    subagents: emptyRecord(),
    pendingParents: emptyRecord(),
    relationKeys: emptyRecord(),
  };
}

export function correlationStateKey(profileId: string, profileVersion: string, generation: string): string {
  return `${profileId}@${profileVersion}:${generation}`;
}

export function correlateBatch(
  profile: AgentProfile,
  generation: string,
  batch: readonly CorrelationInput[],
  previous?: CorrelationState,
): CorrelationResult {
  const expectedKey = correlationStateKey(profile.id, profile.version, generation);
  const state = previous?.key === expectedKey ? cloneState(previous) : createCorrelationState(profile, generation);
  const relations: CorrelationRelation[] = [];
  const emitted = new Set(Object.keys(state.relationKeys));

  for (const item of batch) {
    const projection = item.projection;
    state.records[item.recordKey] = { eventKind: projection.eventKind, evidence: projection.evidence };

    if (projection.sessionId) {
      addGroupRelation(state, state.sessions, projection.sessionId, item.recordKey, 'session_member', relations, emitted);
    }
    if (projection.turnId) {
      addGroupRelation(state, state.turns, projection.turnId, item.recordKey, 'turn_member', relations, emitted);
    }
    if (projection.messageId) {
      state.messages[projection.messageId] = item.recordKey;
      resolvePendingParent(state, projection.messageId, item.recordKey, relations, emitted);
    }
    if (projection.subagentId) {
      state.subagents[projection.subagentId] = item.recordKey;
      resolvePendingParent(state, projection.subagentId, item.recordKey, relations, emitted, 'subagent_parent');
    }
    if (projection.parentId) {
      const parentRecord = state.messages[projection.parentId] ?? state.subagents[projection.parentId];
      if (parentRecord) {
        emitRelation('parent_child', projection.parentId, parentRecord, item.recordKey, state, relations, emitted);
      } else {
        pushUnique(state.pendingParents, projection.parentId, item.recordKey);
      }
    }
    if (projection.toolCallId) {
      const tool = state.tools[projection.toolCallId] ?? { calls: [], results: [] };
      state.tools[projection.toolCallId] = tool;
      const side = projection.eventKind === 'tool_call' || projection.eventKind === 'action'
        ? tool.calls
        : (projection.eventKind === 'tool_result' || projection.eventKind === 'observation' ? tool.results : undefined);
      if (side) pushUniqueValue(side, item.recordKey);
      for (const call of tool.calls) {
        for (const result of tool.results) {
          emitRelation('tool_pair', projection.toolCallId, call, result, state, relations, emitted);
        }
      }
    }
  }

  return { records: [...batch], relations, state };
}

function addGroupRelation(
  state: CorrelationState,
  index: Record<string, string[]>,
  stableId: string,
  recordKey: string,
  kind: 'session_member' | 'turn_member',
  relations: CorrelationRelation[],
  emitted: Set<string>,
): void {
  const members = index[stableId] ?? [];
  index[stableId] = members;
  const anchor = members[0];
  pushUniqueValue(members, recordKey);
  if (anchor && anchor !== recordKey) {
    emitRelation(kind, stableId, anchor, recordKey, state, relations, emitted);
  }
}

function resolvePendingParent(
  state: CorrelationState,
  stableId: string,
  parentRecordKey: string,
  relations: CorrelationRelation[],
  emitted: Set<string>,
  kind: CorrelationKind = 'parent_child',
): void {
  const children = state.pendingParents[stableId] ?? [];
  for (const child of children) {
    const resolvedKind = kind === 'parent_child' && state.records[child]?.eventKind === 'subagent'
      ? 'subagent_parent'
      : kind;
    emitRelation(resolvedKind, stableId, parentRecordKey, child, state, relations, emitted);
  }
  delete state.pendingParents[stableId];
}

function emitRelation(
  kind: CorrelationKind,
  stableId: string,
  sourceRecordKey: string,
  targetRecordKey: string,
  state: CorrelationState,
  relations: CorrelationRelation[],
  emitted: Set<string>,
): void {
  const relationKey = `${kind}\u0000${stableId}\u0000${sourceRecordKey}\u0000${targetRecordKey}`;
  if (emitted.has(relationKey)) return;
  emitted.add(relationKey);
  state.relationKeys[relationKey] = true;
  relations.push({
    kind,
    stableId,
    sourceRecordKey,
    targetRecordKey,
    confidence: 'correlated',
    evidence: [
      ...relationEvidence(sourceRecordKey, state.records[sourceRecordKey]?.evidence ?? [], stableId),
      ...relationEvidence(targetRecordKey, state.records[targetRecordKey]?.evidence ?? [], stableId),
    ],
  });
}

function relationEvidence(recordKey: string, evidence: AgentEvidence[], _stableId: string): CorrelationEvidence[] {
  const candidates = evidence.filter((item) => ['sessionId', 'turnId', 'messageId', 'parentId', 'toolCallId', 'subagentId'].includes(item.field));
  return candidates.slice(0, 2).map((item) => ({ recordKey, field: item.field, path: item.path }));
}

function pushUnique(index: Record<string, string[]>, id: string, value: string): void {
  const values = index[id] ?? [];
  index[id] = values;
  pushUniqueValue(values, value);
}

function pushUniqueValue(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

function cloneState(state: CorrelationState): CorrelationState {
  return {
    ...state,
    records: cloneRecord(state.records),
    messages: cloneRecord(state.messages),
    sessions: cloneStringArrayRecord(state.sessions),
    turns: cloneStringArrayRecord(state.turns),
    tools: cloneToolRecord(state.tools),
    subagents: cloneRecord(state.subagents),
    pendingParents: cloneStringArrayRecord(state.pendingParents),
    relationKeys: cloneRecord(state.relationKeys),
  };
}

function cloneStringArrayRecord(value: Record<string, string[]>): Record<string, string[]> {
  const result = emptyRecord<string[]>();
  for (const [key, entries] of Object.entries(value)) {
    result[key] = [...entries];
  }
  return result;
}

function cloneToolRecord(value: CorrelationState['tools']): CorrelationState['tools'] {
  const result = emptyRecord<{ calls: string[]; results: string[] }>();
  for (const [key, entries] of Object.entries(value)) {
    result[key] = { calls: [...entries.calls], results: [...entries.results] };
  }
  return result;
}

function cloneRecord<T>(value: Record<string, T>): Record<string, T> {
  return Object.assign(emptyRecord<T>(), value);
}

function emptyRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}
