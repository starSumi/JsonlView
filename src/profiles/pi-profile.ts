import type { AgentEventKind, AgentRowProjection } from '../shared/types';
import type { AgentProfile, DetectionResult, GenericRecordSample, HydratedRecord, ProjectionContext } from './profile-contract';
import {
  actorFromRole,
  boundedSummary,
  createProjection,
  evidence,
  indexedPath,
  isObject,
  keyPath,
  objectAt,
  own,
  pushReason,
  setActor,
  setDerivedField,
  setStringField,
  stringAt,
  usageFromObject,
} from './utils';

const PI_BUILT_IN_MESSAGE_ROLES = new Set(['system', 'user', 'assistant', 'toolResult', 'bashExecution', 'custom', 'branchSummary', 'compactionSummary']);

/** Pi coding-agent session entries with their nested AgentMessage contract. */
export class PiCodingAgentProfile implements AgentProfile {
  public readonly id = 'pi-coding-agent';
  public readonly displayName = 'Pi Coding Agent';
  public readonly version = '1';

  public detect(sample: readonly GenericRecordSample[]): DetectionResult {
    let headers = 0;
    let messages = 0;
    let nestedContent = 0;
    let stateEntries = 0;
    let stableIds = 0;
    const reasons: DetectionResult['reasons'] = [];
    for (const entry of sample) {
      if (!isObject(entry.value)) continue;
      const value = entry.value;
      if (isPiSessionHeader(value)) {
        headers += 1;
        pushReason(reasons, keyPath('type'), 'Pi session header with id, timestamp, and cwd');
      }
      if (isPiMessageEntry(value)) {
        messages += 1;
        if (Array.isArray(objectAt(value, 'message')?.content) || typeof objectAt(value, 'message')?.content === 'string') {
          nestedContent += 1;
          pushReason(reasons, keyPath('message', 'content'), 'Pi nested AgentMessage content blocks');
        }
        if (stringAt(value, 'id') && own(value, 'parentId') !== undefined) stableIds += 1;
        pushReason(reasons, keyPath('message', 'role'), 'Pi AgentMessage role');
      }
      const type = stringAt(value, 'type');
      if (type === 'model_change' || type === 'thinking_level_change' || type === 'session_info') {
        stateEntries += 1;
        pushReason(reasons, keyPath('type'), 'Pi session state entry: ' + type);
      }
    }
    const denominator = Math.max(1, sample.length);
    const matched = headers + messages + stateEntries;
    const coverage = matched / denominator;
    const requiredEvidenceMet = headers >= 1
      && messages >= 1
      && nestedContent >= 1
      && coverage >= 0.25
      && (stableIds >= 1 || stateEntries >= 1);
    const score = Math.min(0.99,
      0.34 * Math.min(1, headers)
      + 0.34 * Math.min(1, messages / 2)
      + 0.18 * Math.min(1, nestedContent / 2)
      + 0.14 * Math.min(1, stateEntries / 2));
    return { profileId: this.id, profileVersion: this.version, score, reasons, requiredEvidenceMet, sampledRecords: sample.length };
  }

  public project(record: HydratedRecord, _context: ProjectionContext): AgentRowProjection {
    if (!isObject(record.value)) return createProjection(this.id, 'other', boundedSummary(record.value), undefined, keyPath());
    const value = record.value;
    const type = stringAt(value, 'type');
    const typePath = type ? keyPath('type') : undefined;
    let projection: AgentRowProjection;
    if (type === 'session') {
      projection = createProjection(this.id, 'session', boundedSummary(value, 'Pi session'), typePath, keyPath('id'));
      setActor(projection, 'system', typePath ?? keyPath());
      setStringField(projection, 'sessionId', stringAt(value, 'id'), keyPath('id'));
      setDerivedField(projection, 'cwd', stringAt(value, 'cwd'), keyPath('cwd'));
    } else if (type === 'model_change') {
      const modelId = stringAt(value, 'modelId');
      projection = createProjection(this.id, 'checkpoint', boundedSummary(modelId ?? value, 'Model changed'), typePath, modelId ? keyPath('modelId') : typePath);
      setActor(projection, 'system', typePath ?? keyPath());
      setStringField(projection, 'model', modelId, keyPath('modelId'));
      setDerivedField(projection, 'provider', stringAt(value, 'provider'), keyPath('provider'));
    } else if (type === 'thinking_level_change') {
      const level = stringAt(value, 'thinkingLevel');
      projection = createProjection(this.id, 'checkpoint', boundedSummary(level ?? value, 'Thinking level'), typePath, level ? keyPath('thinkingLevel') : typePath);
      setActor(projection, 'system', typePath ?? keyPath());
      setStringField(projection, 'status', level, keyPath('thinkingLevel'));
    } else if (type === 'session_info') {
      const name = stringAt(value, 'name');
      projection = createProjection(this.id, 'session', boundedSummary(name ?? value, 'Session info'), typePath, name ? keyPath('name') : typePath);
      setActor(projection, 'system', typePath ?? keyPath());
      setDerivedField(projection, 'name', name, keyPath('name'));
    } else if (type === 'message' && isObject(own(value, 'message'))) {
      const message = objectAt(value, 'message')!;
      const role = stringAt(message, 'role');
      const content = own(message, 'content');
      const blocks = Array.isArray(content) ? content : [];
      const toolCall = blocks.find((item) => isObject(item) && stringAt(item, 'type') === 'toolCall');
      const toolResult = role === 'toolResult';
      const firstType = toolCall ? 'toolCall' : stringAt(blocks.find((item) => isObject(item)), 'type');
      const eventKind: AgentEventKind = toolResult
        ? 'tool_result'
        : firstType === 'toolCall'
          ? 'tool_call'
          : role === 'system' || role === 'branchSummary' || role === 'compactionSummary'
            ? 'checkpoint'
            : role === 'bashExecution'
              ? 'action'
              : PI_BUILT_IN_MESSAGE_ROLES.has(role ?? '') ? 'message' : 'other';
      const summaryValue = role === 'system' ? own(message, 'sections') ?? content : role === 'branchSummary' || role === 'compactionSummary' ? own(message, 'summary') ?? message : role === 'bashExecution' ? own(message, 'command') ?? own(message, 'output') ?? message : toolCall ?? content ?? message;
      const summaryPath = toolCall ? indexedPath(['message', 'content'], blocks.indexOf(toolCall), 'name') : content !== undefined ? keyPath('message', 'content') : keyPath('message');
      projection = createProjection(this.id, eventKind, boundedSummary(summaryValue, 'Pi ' + (role ?? 'message')), typePath, summaryPath);
      setActor(projection, role === 'toolResult' ? 'tool' : actorFromRole(role), keyPath('message', 'role'));
      const toolCallId = stringAt(toolCall, 'id') ?? stringAt(message, 'toolCallId');
      setStringField(projection, 'toolCallId', toolCallId, toolCall ? indexedPath(['message', 'content'], blocks.indexOf(toolCall), 'id') : keyPath('message', 'toolCallId'));
      setStringField(projection, 'timestamp', stringAt(value, 'timestamp'), keyPath('timestamp'));
      setStringField(projection, 'messageId', stringAt(value, 'id'), keyPath('id'));
      setStringField(projection, 'parentId', stringAt(value, 'parentId'), keyPath('parentId'));
      setStringField(projection, 'model', stringAt(message, 'model'), keyPath('message', 'model'));
      setStringField(projection, 'status', stringAt(message, 'stopReason'), keyPath('message', 'stopReason'));
      if (toolResult && typeof own(message, 'isError') === 'boolean') {
        setStringField(projection, 'status', own(message, 'isError') === true ? 'error' : 'completed', keyPath('message', 'isError'));
        if (own(message, 'isError') === true) setStringField(projection, 'severity', 'error', keyPath('message', 'isError'));
      }
      const usage = usageFromObject(own(message, 'usage'));
      if (usage) {
        projection.usage = usage;
        projection.evidence.push(evidence('usage', keyPath('message', 'usage')));
      }
      setDerivedField(projection, 'messageRole', role, keyPath('message', 'role'));
      if (Array.isArray(message.toolsAdded)) setDerivedField(projection, 'toolsAdded', String(message.toolsAdded.length), keyPath('message', 'toolsAdded'));
      if (Array.isArray(message.toolsRemoved)) setDerivedField(projection, 'toolsRemoved', String(message.toolsRemoved.length), keyPath('message', 'toolsRemoved'));
    } else {
      projection = createProjection(this.id, 'other', boundedSummary(value, type ? 'Pi ' + type : 'Pi record'), typePath, keyPath());
    }
    if (type !== 'message') {
      setStringField(projection, 'timestamp', stringAt(value, 'timestamp'), keyPath('timestamp'));
      setStringField(projection, 'messageId', stringAt(value, 'id'), keyPath('id'));
      setStringField(projection, 'parentId', stringAt(value, 'parentId'), keyPath('parentId'));
    }
    return projection;
  }
}

export function isPiSessionHeader(value: unknown): value is Record<string, unknown> {
  return isObject(value)
    && stringAt(value, 'type') === 'session'
    && stringAt(value, 'id') !== undefined
    && stringAt(value, 'timestamp') !== undefined
    && stringAt(value, 'cwd') !== undefined;
}

export function isPiMessageEntry(value: unknown): value is Record<string, unknown> {
  const message = objectAt(value, 'message');
  const role = stringAt(message, 'role');
  return isObject(value)
    && stringAt(value, 'type') === 'message'
    && role !== undefined
    && role.length > 0
    && (own(message!, 'content') !== undefined || role === 'system');
}
