import type { AgentRowProjection, FieldPath } from '@shared/types';
import { adaptGenericAgentEvent } from './agent-event-adapter';
import type { AgentProfile, DetectionResult, GenericRecordSample, HydratedRecord, ProjectionContext } from './profile-contract';
import { boundedSummary, createProjection, evidence, keyPath, pushReason, setActor, setDerivedField, setStringField } from './utils';

export class GenericAgentEventsProfile implements AgentProfile {
  public readonly id = 'generic-agent-events';
  public readonly displayName = 'Generic Agent Events';
  public readonly version = '1';

  public detect(sample: readonly GenericRecordSample[]): DetectionResult {
    let recognized = 0;
    let semantic = 0;
    let stableIds = 0;
    const reasons: DetectionResult['reasons'] = [];
    for (const entry of sample) {
      if (entry.parseState !== undefined && entry.parseState !== 'valid') continue;
      const adapted = adaptGenericAgentEvent(entry.value);
      if (!adapted?.recognized) continue;
      recognized += 1;
      if (adapted.semanticSignal) semantic += 1;
      if (adapted.stableIdentityCount > 0) stableIds += 1;
      if (adapted.event) pushReason(reasons, adapted.event.path, `Agent event discriminator: ${adapted.eventName ?? 'unknown'}`);
    }
    const denominator = Math.max(1, sample.length);
    const coverage = recognized / denominator;
    const score = Math.min(0.72, 0.44 * Math.min(1, recognized / 3)
      + 0.26 * Math.min(1, semantic / 3) + 0.2 * Math.min(1, stableIds / 2));
    return {
      profileId: this.id,
      profileVersion: this.version,
      score,
      reasons,
      requiredEvidenceMet: recognized >= 2 && semantic >= 2 && stableIds >= 1 && coverage >= 0.6,
      sampledRecords: sample.length,
    };
  }

  public project(record: HydratedRecord, _context: ProjectionContext): AgentRowProjection {
    const adapted = adaptGenericAgentEvent(record.value);
    if (!adapted) return createProjection(this.id, 'other', boundedSummary(record.value), undefined, keyPath());
    const projection = createProjection(
      this.id,
      adapted.eventKind,
      boundedSummary(adapted.summary?.value ?? adapted.eventName ?? record.value, adapted.eventName ?? 'Agent event'),
      adapted.event?.path,
      adapted.summary?.path ?? adapted.event?.path,
    );
    if (adapted.actor && adapted.role) setActor(projection, adapted.actor, adapted.role.path);
    setLocatedString(projection, 'timestamp', adapted.timestamp);
    setLocatedString(projection, 'sessionId', adapted.sessionId);
    setLocatedString(projection, 'turnId', adapted.turnId);
    setLocatedString(projection, 'messageId', adapted.messageId);
    setLocatedString(projection, 'parentId', adapted.parentId);
    setLocatedString(projection, 'toolCallId', adapted.toolCallId);
    setLocatedString(projection, 'subagentId', adapted.subagentId);
    setLocatedString(projection, 'model', adapted.model);
    setLocatedString(projection, 'status', adapted.status);
    setLocatedString(projection, 'severity', adapted.severity);
    if (adapted.usage) { projection.usage = adapted.usage.value; projection.evidence.push(evidence('usage', adapted.usage.path)); }
    if (adapted.content) {
      setDerivedField(projection, 'content', adapted.content.text, adapted.content.path);
      if (adapted.content.blockKinds.length > 0) setDerivedField(projection, 'contentBlocks', adapted.content.blockKinds.join(', '), adapted.content.path);
      if (adapted.content.hasThinking) setDerivedField(projection, 'hasThinking', true, adapted.content.path);
      if (adapted.content.truncated) setDerivedField(projection, 'contentTruncated', true, adapted.content.path);
    }
    if (adapted.tool) {
      setLocatedDerived(projection, 'toolName', adapted.tool.name);
      setLocatedDerived(projection, 'toolInput', adapted.tool.input);
      setLocatedDerived(projection, 'toolResult', adapted.tool.result);
      setLocatedDerived(projection, 'toolError', adapted.tool.isError);
    }
    return projection;
  }
}

function setLocatedString(
  projection: AgentRowProjection,
  field: 'timestamp' | 'sessionId' | 'turnId' | 'messageId' | 'parentId' | 'toolCallId' | 'subagentId' | 'model' | 'status' | 'severity',
  located: { value: unknown; path: FieldPath } | undefined,
): void {
  if (!located) return;
  const value = typeof located.value === 'string' ? located.value : undefined;
  if (value) setStringField(projection, field, value, located.path);
}

function setLocatedDerived(
  projection: AgentRowProjection,
  field: string,
  located: { value: unknown; path: FieldPath } | undefined,
): void {
  if (!located) return;
  const value = located.value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    setDerivedField(projection, field, value, located.path);
  } else if (value !== undefined && value !== null) {
    setDerivedField(projection, field, boundedSummary(value), located.path);
  }
}
