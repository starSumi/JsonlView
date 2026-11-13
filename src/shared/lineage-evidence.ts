import type { AgentRowProjection, FieldPath, RowProjection } from './types';
import type { LineageLookupRelation } from './contracts/lineage';
export type { LineageLookupRelation } from './contracts/lineage';

/** Provider evidence is shared by the page projection and the bounded lookup. */
export function exactLineageEvidence(profile: AgentRowProjection, field: string, keys: readonly string[]): FieldPath | undefined {
  if (profile.confidence !== 'source') return undefined;
  return profile.evidence.find((item) => item.field === field && item.path.tokens.length === keys.length
    && item.path.tokens.every((token, index) => token.kind === 'key' && token.value === keys[index]))?.path;
}

export function lineageParentEvidence(profile: AgentRowProjection): FieldPath | undefined {
  if (profile.profileId === 'claude-code-session') return exactLineageEvidence(profile, 'parentId', ['parentUuid']);
  if (profile.profileId === 'pi-coding-agent') return exactLineageEvidence(profile, 'parentId', ['parentId']);
  if (profile.profileId === 'opentelemetry' && profile.eventKind === 'span') {
    if (profile.parentId === undefined || /^0*$/u.test(profile.parentId)) return undefined;
    return exactLineageEvidence(profile, 'parentId', ['parentSpanId']) ?? exactLineageEvidence(profile, 'parentId', ['ParentSpanId']);
  }
  return undefined;
}

export function lineageIdentityEvidence(profile: AgentRowProjection): boolean {
  if (profile.profileId === 'claude-code-session') return exactLineageEvidence(profile, 'messageId', ['uuid']) !== undefined;
  if (profile.profileId === 'pi-coding-agent') return exactLineageEvidence(profile, 'messageId', ['id']) !== undefined;
  return profile.profileId === 'opentelemetry' && profile.eventKind === 'span'
    && (exactLineageEvidence(profile, 'messageId', ['spanId']) ?? exactLineageEvidence(profile, 'messageId', ['SpanId'])) !== undefined;
}

export function lineageSpanContextEvidence(profile: AgentRowProjection): FieldPath | undefined {
  return profile.profileId === 'opentelemetry' && profile.eventKind === 'log' && profile.parentId !== undefined && !/^0*$/u.test(profile.parentId)
    ? exactLineageEvidence(profile, 'parentId', ['spanId']) ?? exactLineageEvidence(profile, 'parentId', ['SpanId']) : undefined;
}

export function lineageToolEvidence(profile: AgentRowProjection): FieldPath | undefined {
  return profile.profileId === 'codex-rollout' ? exactLineageEvidence(profile, 'toolCallId', ['payload', 'call_id']) : undefined;
}

export function nonemptyLineageValue(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

export function lineageParentKey(generation: string, profile: AgentRowProjection, identifier: string): string | undefined {
  if (!nonemptyLineageValue(profile.sessionId) || !nonemptyLineageValue(identifier)) return undefined;
  if (profile.profileId === 'opentelemetry') {
    // A span's turnId is its own span ID, not a shared parent/child turn.
    const traceEvidence = exactLineageEvidence(profile, 'sessionId', ['traceId']) ?? exactLineageEvidence(profile, 'sessionId', ['TraceId']);
    if (traceEvidence === undefined || /^0+$/u.test(identifier) || /^0+$/u.test(profile.sessionId)) return undefined;
    return JSON.stringify([generation, profile.profileId, profile.sessionId, identifier]);
  }
  return JSON.stringify([generation, profile.profileId, profile.sessionId,
    nonemptyLineageValue(profile.turnId) ? profile.turnId : null, identifier]);
}

export function lineageToolKey(generation: string, profile: AgentRowProjection, identifier: string): string | undefined {
  if (!nonemptyLineageValue(profile.sessionId) || !nonemptyLineageValue(profile.turnId) || !nonemptyLineageValue(identifier)) return undefined;
  return JSON.stringify([generation, profile.profileId, profile.sessionId, profile.turnId, identifier]);
}

export interface LineageLookupTarget { readonly relation: LineageLookupRelation; readonly key: string; readonly label: string }

/** Derive targets from a Host-issued row. The client never supplies a path, ID or offset. */
export function lineageLookupTarget(row: RowProjection, relation: LineageLookupRelation): LineageLookupTarget | undefined {
  const profile = row.profile;
  if (profile === undefined) return undefined;
  if (((relation === 'parent' && lineageParentEvidence(profile) !== undefined)
    || (relation === 'span-context' && lineageSpanContextEvidence(profile) !== undefined)) && profile.parentId !== undefined) {
    const key = lineageParentKey(row.ref.generation, profile, profile.parentId);
    return key === undefined ? undefined : { relation, key, label: profile.parentId };
  }
  if (relation === 'tool-partner' && lineageToolEvidence(profile) !== undefined && profile.toolCallId !== undefined
    && (profile.eventKind === 'tool_call' || profile.eventKind === 'tool_result')) {
    const key = lineageToolKey(row.ref.generation, profile, profile.toolCallId);
    return key === undefined ? undefined : { relation, key, label: profile.toolCallId };
  }
  return undefined;
}

export function matchesLineageTarget(source: RowProjection, candidate: RowProjection, target: LineageLookupTarget): boolean {
  const profile = candidate.profile;
  if (profile === undefined || candidate.ref.generation !== source.ref.generation || profile.profileId !== source.profile?.profileId) return false;
  if (target.relation === 'parent' || target.relation === 'span-context') return profile.messageId !== undefined && lineageIdentityEvidence(profile)
    && lineageParentKey(candidate.ref.generation, profile, profile.messageId) === target.key;
  return lineageToolEvidence(profile) !== undefined && profile.toolCallId !== undefined
    && profile.eventKind === (source.profile?.eventKind === 'tool_call' ? 'tool_result' : 'tool_call')
    && lineageToolKey(candidate.ref.generation, profile, profile.toolCallId) === target.key;
}
