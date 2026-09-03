import type { AgentRowProjection, FieldPath } from '../shared/types';
import type { AgentProfile, DetectionResult, GenericRecordSample, HydratedRecord, ProjectionContext } from './profile-contract';
import {
  actorFromRole,
  boundedSummary,
  createProjection,
  evidence,
  extractText,
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

const CODEX_TYPES = new Set([
  'session_meta',
  'turn_context',
  'response_item',
  'event_msg',
  'world_state',
  'compacted',
  'inter_agent_communication_metadata',
]);

const TOOL_CALL_TYPES = new Set(['function_call', 'custom_tool_call', 'local_shell_call']);
const TOOL_RESULT_TYPES = new Set(['function_call_output', 'custom_tool_call_output', 'local_shell_call_output']);

export class CodexRolloutProfile implements AgentProfile {
  public readonly id = 'codex-rollout';
  public readonly displayName = 'Codex Rollout';
  public readonly version = '1';

  public detect(sample: readonly GenericRecordSample[]): DetectionResult {
    let envelopeCount = 0;
    let knownTypeCount = 0;
    let distinctiveCount = 0;
    const reasons: DetectionResult['reasons'] = [];

    for (const entry of sample) {
      if (!isObject(entry.value)) continue;
      const type = stringAt(entry.value, 'type');
      const timestamp = stringAt(entry.value, 'timestamp');
      const payload = objectAt(entry.value, 'payload');
      if (type && timestamp && payload) {
        envelopeCount += 1;
        pushReason(reasons, keyPath('payload'), 'Codex-style timestamp/type/payload envelope');
      }
      if (type && CODEX_TYPES.has(type)) {
        knownTypeCount += 1;
        pushReason(reasons, keyPath('type'), `Known Codex rollout record type: ${type}`);
      }
      if (
        (type === 'session_meta' && stringAt(payload, 'id'))
        || (type === 'turn_context' && stringAt(payload, 'turn_id'))
        || (type === 'response_item' && stringAt(payload, 'type'))
      ) {
        distinctiveCount += 1;
      }
    }

    const denominator = Math.max(1, sample.length);
    const coverage = Math.min(1, envelopeCount / denominator);
    const score = Math.min(0.99, 0.35 * coverage + 0.35 * Math.min(1, knownTypeCount / 2) + 0.29 * Math.min(1, distinctiveCount / 2));
    return {
      profileId: this.id,
      profileVersion: this.version,
      score,
      reasons,
      requiredEvidenceMet: envelopeCount >= Math.min(2, denominator) && knownTypeCount >= 1 && distinctiveCount >= 1,
      sampledRecords: sample.length,
    };
  }

  public project(record: HydratedRecord, _context: ProjectionContext): AgentRowProjection {
    if (!isObject(record.value)) {
      return createProjection(this.id, 'other', boundedSummary(record.value), undefined, keyPath());
    }
    const value = record.value;
    const type = stringAt(value, 'type');
    const payload = objectAt(value, 'payload');
    const eventPath = type ? keyPath('type') : undefined;
    let projection: AgentRowProjection;

    switch (type) {
      case 'session_meta':
        projection = createProjection(this.id, 'session', boundedSummary(stringAt(payload, 'id') ?? payload, 'Session'), eventPath, stringAt(payload, 'id') ? keyPath('payload', 'id') : keyPath('payload'));
        setStringField(projection, 'sessionId', stringAt(payload, 'id'), keyPath('payload', 'id'));
        setStringField(projection, 'model', stringAt(payload, 'model'), keyPath('payload', 'model'));
        break;
      case 'turn_context':
        projection = createProjection(this.id, 'turn', boundedSummary(stringAt(payload, 'turn_id') ?? payload, 'Turn'), eventPath, stringAt(payload, 'turn_id') ? keyPath('payload', 'turn_id') : keyPath('payload'));
        setStringField(projection, 'turnId', stringAt(payload, 'turn_id'), keyPath('payload', 'turn_id'));
        setStringField(projection, 'model', stringAt(payload, 'model'), keyPath('payload', 'model'));
        break;
      case 'response_item':
        projection = this.projectResponseItem(payload, eventPath);
        break;
      // Some Codex exports flatten response items at the top level instead of
      // wrapping them in a response_item envelope. Keep the same projection
      // semantics and source evidence for those records.
      case 'message':
      case 'reasoning':
      case 'function_call':
      case 'custom_tool_call':
      case 'local_shell_call':
      case 'function_call_output':
      case 'custom_tool_call_output':
      case 'local_shell_call_output':
        projection = this.projectResponseItem(value, eventPath, keyPath());
        break;
      case 'event_msg':
        projection = this.projectEventMessage(payload, eventPath);
        break;
      case 'inter_agent_communication_metadata':
        projection = createProjection(this.id, 'subagent', boundedSummary(payload, 'Agent communication'), eventPath, keyPath('payload'));
        setStringField(projection, 'subagentId', firstString(payload, ['agent_id', 'child_id', 'subagent_id']), keyPath('payload', firstPresentKey(payload, ['agent_id', 'child_id', 'subagent_id']) ?? 'agent_id'));
        setStringField(projection, 'parentId', firstString(payload, ['parent_id', 'parent_agent_id']), keyPath('payload', firstPresentKey(payload, ['parent_id', 'parent_agent_id']) ?? 'parent_id'));
        break;
      case 'compacted':
      case 'world_state':
        projection = createProjection(this.id, 'checkpoint', boundedSummary(payload, type), eventPath, keyPath('payload'));
        break;
      default:
        projection = createProjection(this.id, 'other', boundedSummary(payload ?? value, type ? `Unknown ${type}` : 'Codex record'), eventPath, payload ? keyPath('payload') : keyPath());
        break;
    }

    setStringField(projection, 'timestamp', stringAt(value, 'timestamp'), keyPath('timestamp'));
    return projection;
  }

  private projectResponseItem(
    payload: Record<string, unknown> | undefined,
    outerPath: FieldPath | undefined,
    basePath: FieldPath = keyPath('payload'),
  ): AgentRowProjection {
    const itemType = stringAt(payload, 'type');
    const itemTypePath = appendPath(basePath, 'type');
    const eventPath = itemType ? itemTypePath : outerPath;
    const role = stringAt(payload, 'role');
    const content = own(payload ?? {}, 'content');
    let projection: AgentRowProjection;

    if (itemType === 'message') {
      projection = createProjection(this.id, 'message', boundedSummary(extractText(content) ?? content, role ? `${role} message` : 'Message'), eventPath, appendPath(basePath, 'content'));
      setActor(projection, actorFromRole(role), appendPath(basePath, 'role'));
    } else if (itemType === 'reasoning') {
      projection = createProjection(this.id, 'reasoning', boundedSummary(extractText(content) ?? own(payload ?? {}, 'summary'), 'Reasoning'), eventPath, content !== undefined ? appendPath(basePath, 'content') : appendPath(basePath, 'summary'));
      setActor(projection, 'assistant', itemTypePath);
    } else if (itemType && TOOL_CALL_TYPES.has(itemType)) {
      const name = firstString(payload, ['name', 'tool_name']) ?? 'tool';
      projection = createProjection(this.id, 'tool_call', boundedSummary(own(payload ?? {}, 'arguments') ?? own(payload ?? {}, 'input'), `Tool ${name}`), eventPath, own(payload ?? {}, 'arguments') !== undefined ? appendPath(basePath, 'arguments') : appendPath(basePath, 'input'));
      setActor(projection, 'assistant', itemTypePath);
      setStringField(projection, 'toolCallId', firstString(payload, ['call_id', 'id']), appendPath(basePath, firstPresentKey(payload, ['call_id', 'id']) ?? 'call_id'));
    } else if (itemType && TOOL_RESULT_TYPES.has(itemType)) {
      projection = createProjection(this.id, 'tool_result', boundedSummary(own(payload ?? {}, 'output') ?? own(payload ?? {}, 'result'), 'Tool result'), eventPath, own(payload ?? {}, 'output') !== undefined ? appendPath(basePath, 'output') : appendPath(basePath, 'result'));
      setActor(projection, 'tool', itemTypePath);
      setStringField(projection, 'toolCallId', firstString(payload, ['call_id', 'tool_call_id']), appendPath(basePath, firstPresentKey(payload, ['call_id', 'tool_call_id']) ?? 'call_id'));
    } else {
      projection = createProjection(this.id, 'other', boundedSummary(payload, itemType ? `Unknown response item ${itemType}` : 'Response item'), eventPath, keyPath('payload'));
    }

    setStringField(projection, 'messageId', firstString(payload, ['id', 'message_id']), appendPath(basePath, firstPresentKey(payload, ['id', 'message_id']) ?? 'id'));
    setStringField(projection, 'turnId', stringAt(payload, 'turn_id'), appendPath(basePath, 'turn_id'));
    setStringField(projection, 'parentId', stringAt(payload, 'parent_id'), appendPath(basePath, 'parent_id'));
    return projection;
  }

  private projectEventMessage(payload: Record<string, unknown> | undefined, outerPath: FieldPath | undefined): AgentRowProjection {
    const eventType = stringAt(payload, 'type');
    const eventTypePath = keyPath('payload', 'type');
    const eventPath = eventType ? eventTypePath : outerPath;
    let projection: AgentRowProjection;

    switch (eventType) {
      case 'user_message':
        projection = createProjection(this.id, 'message', boundedSummary(own(payload ?? {}, 'message'), 'User message'), eventPath, keyPath('payload', 'message'));
        setActor(projection, 'user', eventTypePath);
        break;
      case 'agent_message':
      case 'assistant_message':
        projection = createProjection(this.id, 'message', boundedSummary(own(payload ?? {}, 'message'), 'Assistant message'), eventPath, keyPath('payload', 'message'));
        setActor(projection, 'assistant', eventTypePath);
        break;
      case 'token_count': {
        projection = createProjection(this.id, 'usage', 'Token usage', eventPath, eventTypePath);
        const usageObject = objectAt(payload, 'usage') ?? objectAt(payload, 'info', 'total_token_usage') ?? objectAt(payload, 'info');
        const usage = usageFromObject(usageObject);
        if (usage) {
          projection.usage = usage;
          projection.evidence.push(evidence('usage', objectAt(payload, 'usage') ? keyPath('payload', 'usage') : keyPath('payload', 'info')));
        }
        break;
      }
      case 'error':
      case 'turn_aborted':
        projection = createProjection(this.id, 'error', boundedSummary(own(payload ?? {}, 'message') ?? payload, eventType), eventPath, own(payload ?? {}, 'message') !== undefined ? keyPath('payload', 'message') : keyPath('payload'));
        setStringField(projection, 'severity', stringAt(payload, 'severity') ?? 'error', stringAt(payload, 'severity') ? keyPath('payload', 'severity') : eventTypePath);
        break;
      case 'approval_request':
      case 'approval_response':
        projection = createProjection(this.id, 'approval', boundedSummary(payload, eventType), eventPath, keyPath('payload'));
        break;
      case 'task_started':
      case 'task_complete':
        projection = createProjection(this.id, 'subagent', boundedSummary(payload, eventType), eventPath, keyPath('payload'));
        setStringField(projection, 'subagentId', firstString(payload, ['agent_id', 'task_id']), keyPath('payload', firstPresentKey(payload, ['agent_id', 'task_id']) ?? 'agent_id'));
        break;
      default:
        projection = createProjection(this.id, 'other', boundedSummary(payload, eventType ? `Unknown event ${eventType}` : 'Event message'), eventPath, keyPath('payload'));
        break;
    }

    setStringField(projection, 'turnId', stringAt(payload, 'turn_id'), keyPath('payload', 'turn_id'));
    setStringField(projection, 'toolCallId', firstString(payload, ['call_id', 'tool_call_id']), keyPath('payload', firstPresentKey(payload, ['call_id', 'tool_call_id']) ?? 'call_id'));
    return projection;
  }
}

function firstString(object: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = stringAt(object, key);
    if (value) return value;
  }
  return undefined;
}

function appendPath(base: FieldPath, ...keys: string[]): FieldPath {
  return {
    tokens: [
      ...base.tokens,
      ...keys.map((value) => ({ kind: 'key' as const, value })),
    ],
  };
}

function firstPresentKey(object: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!object) return undefined;
  return keys.find((key) => typeof own(object, key) === 'string');
}
