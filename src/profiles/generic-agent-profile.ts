import type { AgentEventKind, AgentRowProjection } from '../shared/types';
import type { AgentProfile, DetectionResult, GenericRecordSample, HydratedRecord, ProjectionContext } from './profile-contract';
import {
  actorFromRole,
  boundedSummary,
  createProjection,
  evidence,
  isObject,
  keyPath,
  objectAt,
  own,
  pushReason,
  setActor,
  setStringField,
  stringAt,
  usageFromObject,
} from './utils';

const KIND_MAP: Record<string, AgentEventKind> = {
  session: 'session',
  turn: 'turn',
  message: 'message',
  reasoning: 'reasoning',
  tool_call: 'tool_call',
  tool_use: 'tool_call',
  tool_result: 'tool_result',
  subagent: 'subagent',
  approval: 'approval',
  usage: 'usage',
  error: 'error',
  checkpoint: 'checkpoint',
};

export class GenericAgentEventsProfile implements AgentProfile {
  public readonly id = 'generic-agent-events';
  public readonly displayName = 'Generic Agent Events';
  public readonly version = '1';

  public detect(sample: readonly GenericRecordSample[]): DetectionResult {
    let eventShapes = 0;
    let semanticFields = 0;
    let stableIds = 0;
    const reasons: DetectionResult['reasons'] = [];
    for (const entry of sample) {
      if (!isObject(entry.value)) continue;
      const event = stringAt(entry.value, 'event') ?? stringAt(entry.value, 'event_type');
      const role = stringAt(entry.value, 'role') ?? stringAt(entry.value, 'actor');
      const message = own(entry.value, 'message') ?? own(entry.value, 'content');
      const toolId = stringAt(entry.value, 'tool_call_id') ?? stringAt(entry.value, 'call_id');
      if (event && (mappedKind(event) || role || message !== undefined)) {
        eventShapes += 1;
        pushReason(reasons, stringAt(entry.value, 'event') ? keyPath('event') : keyPath('event_type'), `Agent event discriminator: ${event}`);
      }
      if (role || message !== undefined || objectAt(entry.value, 'usage') || toolId) {
        semanticFields += 1;
        pushReason(reasons, role ? (stringAt(entry.value, 'role') ? keyPath('role') : keyPath('actor')) : keyPath('message'), 'Direct agent semantic fields are present');
      }
      if (stringAt(entry.value, 'turn_id') || stringAt(entry.value, 'message_id') || toolId || stringAt(entry.value, 'parent_id')) {
        stableIds += 1;
      }
    }
    const denominator = Math.max(1, sample.length);
    const score = Math.min(0.82, 0.34 * Math.min(1, eventShapes / 2) + 0.28 * Math.min(1, semanticFields / denominator) + 0.2 * Math.min(1, stableIds / 2));
    return {
      profileId: this.id,
      profileVersion: this.version,
      score,
      reasons,
      requiredEvidenceMet: eventShapes >= 1 && semanticFields >= 2 && stableIds >= 1,
      sampledRecords: sample.length,
    };
  }

  public project(record: HydratedRecord, _context: ProjectionContext): AgentRowProjection {
    if (!isObject(record.value)) {
      return createProjection(this.id, 'other', boundedSummary(record.value), undefined, keyPath());
    }
    const value = record.value;
    const discriminatorKey = stringAt(value, 'event') ? 'event' : (stringAt(value, 'event_type') ? 'event_type' : (stringAt(value, 'type') ? 'type' : undefined));
    const discriminator = discriminatorKey ? stringAt(value, discriminatorKey) : undefined;
    const eventKind = discriminator ? (mappedKind(discriminator) ?? 'other') : 'other';
    const summaryKey = own(value, 'message') !== undefined
      ? 'message'
      : (own(value, 'content') !== undefined ? 'content' : (own(value, 'error') !== undefined ? 'error' : undefined));
    const projection = createProjection(
      this.id,
      eventKind,
      boundedSummary(own(value, 'message') ?? own(value, 'content') ?? own(value, 'error') ?? value, discriminator ?? 'Agent event'),
      discriminatorKey ? keyPath(discriminatorKey) : undefined,
      summaryKey ? keyPath(summaryKey) : keyPath(),
    );

    const roleKey = stringAt(value, 'role') ? 'role' : (stringAt(value, 'actor') ? 'actor' : undefined);
    if (roleKey) setActor(projection, actorFromRole(stringAt(value, roleKey)), keyPath(roleKey));
    setStringField(projection, 'timestamp', stringAt(value, 'timestamp'), keyPath('timestamp'));
    setStringField(projection, 'sessionId', stringAt(value, 'session_id'), keyPath('session_id'));
    setStringField(projection, 'turnId', stringAt(value, 'turn_id'), keyPath('turn_id'));
    setStringField(projection, 'messageId', stringAt(value, 'message_id'), keyPath('message_id'));
    setStringField(projection, 'parentId', stringAt(value, 'parent_id'), keyPath('parent_id'));
    setStringField(projection, 'toolCallId', stringAt(value, 'tool_call_id') ?? stringAt(value, 'call_id'), stringAt(value, 'tool_call_id') ? keyPath('tool_call_id') : keyPath('call_id'));
    setStringField(projection, 'subagentId', stringAt(value, 'subagent_id') ?? stringAt(value, 'agent_id'), stringAt(value, 'subagent_id') ? keyPath('subagent_id') : keyPath('agent_id'));
    setStringField(projection, 'model', stringAt(value, 'model'), keyPath('model'));
    setStringField(projection, 'status', stringAt(value, 'status'), keyPath('status'));
    setStringField(projection, 'severity', stringAt(value, 'severity'), keyPath('severity'));
    const usage = usageFromObject(objectAt(value, 'usage'));
    if (usage) {
      projection.usage = usage;
      projection.evidence.push(evidence('usage', keyPath('usage')));
    }
    return projection;
  }
}

function mappedKind(value: string): AgentEventKind | undefined {
  const key = value.toLowerCase();
  return Object.prototype.hasOwnProperty.call(KIND_MAP, key) ? KIND_MAP[key] : undefined;
}
