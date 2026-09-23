import type { AgentRowProjection } from '../shared/types';
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
  setDerivedField,
  setStringField,
  stringAt,
  usageFromObject,
} from './utils';
import {
  classifyCodexItem,
  codexItemExtensionKind,
  codexItemSummaryKey,
  isKnownCodexItemType,
} from './codex-item-strategy';

/** The stable top-level event tags emitted by `codex exec --json`. */
export const CODEX_EXEC_EVENT_TYPES = new Set([
  'thread.started',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'item.started',
  'item.updated',
  'item.completed',
  'error',
]);

/** Item variants currently guaranteed by the `codex exec --json` contract. */
const CODEX_EXEC_ITEM_TYPES = new Set([
  'agent_message',
  'reasoning',
  'command_execution',
  'file_change',
  'mcp_tool_call',
  'collab_tool_call',
  'web_search',
  'todo_list',
  'error',
]);

/**
 * Adapter for the machine-readable stdout stream produced by `codex exec
 * --json`. It is deliberately content-driven: stdout can be redirected to
 * any filename, so a basename is not identity evidence.
 */
export class CodexExecProfile implements AgentProfile {
  public readonly id = 'codex-exec-jsonl';
  public readonly displayName = 'Codex Exec JSONL';
  public readonly version = '1';

  public detect(sample: readonly GenericRecordSample[]): DetectionResult {
    let known = 0;
    let valid = 0;
    let itemEvents = 0;
    let knownItemKinds = 0;
    let lifecycleEvents = 0;
    let terminalEvents = 0;
    let threadStartedEvents = 0;
    let turnStartedEvents = 0;
    const lifecycleClasses = new Set<string>();
    let firstValidEventType: string | undefined;
    const reasons: DetectionResult['reasons'] = [];

    for (const entry of sample) {
      if (!isObject(entry.value)) continue;
      const type = stringAt(entry.value, 'type');
      if (!type || !CODEX_EXEC_EVENT_TYPES.has(type)) continue;
      known += 1;
      const validEvent = isExecEvent(type, entry.value);
      if (validEvent) {
        valid += 1;
        firstValidEventType ??= type;
        lifecycleClasses.add(lifecycleClass(type));
        pushReason(reasons, keyPath('type'), `Codex exec event: ${type}`);
      }
      if (type.startsWith('item.')) {
        const itemType = stringAt(objectAt(entry.value, 'item'), 'type');
        if (validEvent) itemEvents += 1;
        if (validEvent && itemType !== undefined && isKnownExecItem(objectAt(entry.value, 'item'))) {
          knownItemKinds += 1;
        }
      }
      if (validEvent && (type.startsWith('thread.') || type.startsWith('turn.'))) lifecycleEvents += 1;
      if (validEvent && type === 'thread.started') threadStartedEvents += 1;
      if (validEvent && type === 'turn.started') turnStartedEvents += 1;
      if (validEvent && (type === 'turn.completed' || type === 'turn.failed' || type === 'error')) terminalEvents += 1;
    }

    const denominator = Math.max(1, sample.length);
    const coverage = valid / denominator;
    const score = Math.min(
      0.99,
      0.45 * coverage
        + 0.35 * Math.min(1, known / 4)
        + 0.2 * Math.min(1, (itemEvents + lifecycleEvents) / 3),
    );
    const hasCompleteTurnPath = threadStartedEvents >= 1
      && turnStartedEvents >= 1
      && terminalEvents >= 1
      && lifecycleClasses.size >= 2;
    const hasItemPath = threadStartedEvents >= 1
      && turnStartedEvents >= 1
      && knownItemKinds >= 1
      && lifecycleClasses.size >= 3;
    return {
      profileId: this.id,
      profileVersion: this.version,
      score,
      reasons,
      requiredEvidenceMet: valid >= Math.min(4, denominator)
        && known >= Math.min(3, denominator)
        // A two-line live prefix (thread.started + turn.started) is a useful
        // suggestion but not enough identity evidence for automatic promotion.
        && valid >= Math.min(3, denominator)
        && itemEvents + terminalEvents >= 1
        // An arbitrary `{type: "item.*", item: {id, type}}` shape is common
        // in unrelated event streams. Require one producer-known item kind
        // plus a lifecycle anchor before promoting the semantic profile.
        && (knownItemKinds >= 1 || hasCompleteTurnPath)
        && firstValidEventType === 'thread.started'
        && (hasCompleteTurnPath || hasItemPath)
        && coverage >= 0.5,
      sampledRecords: sample.length,
    };
  }

  public project(record: HydratedRecord, _context: ProjectionContext): AgentRowProjection {
    if (!isObject(record.value)) {
      return createProjection(this.id, 'other', boundedSummary(record.value), undefined, keyPath());
    }
    const value = record.value;
    const type = stringAt(value, 'type') ?? 'unknown';
    const eventPath = keyPath('type');
    let projection: AgentRowProjection;

    if (type === 'thread.started') {
      const threadId = stringAt(value, 'thread_id');
      projection = createProjection(this.id, 'session', boundedSummary(threadId, 'Thread started'), eventPath, threadId ? keyPath('thread_id') : eventPath);
      setStringField(projection, 'sessionId', threadId, keyPath('thread_id'));
      setActor(projection, 'system', eventPath);
    } else if (type === 'turn.started') {
      projection = createProjection(this.id, 'turn', 'Turn started', eventPath, eventPath);
      setActor(projection, 'assistant', eventPath);
    } else if (type === 'turn.completed') {
      projection = createProjection(this.id, 'result', 'Turn completed', eventPath, eventPath);
      setActor(projection, 'assistant', eventPath);
      const usage = usageFromObject(objectAt(value, 'usage'));
      if (usage) {
        projection.usage = usage;
        projection.evidence.push(evidence('usage', keyPath('usage')));
      }
    } else if (type === 'turn.failed') {
      const error = objectAt(value, 'error');
      projection = createProjection(this.id, 'error', boundedSummary(error ?? value, 'Turn failed'), eventPath, error ? keyPath('error') : eventPath);
      setActor(projection, 'system', eventPath);
      setStringField(projection, 'severity', 'error', eventPath);
      setStringField(projection, 'status', 'failed', eventPath);
    } else if (type === 'error') {
      projection = createProjection(this.id, 'error', boundedSummary(stringAt(value, 'message') ?? value, 'Codex error'), eventPath, stringAt(value, 'message') ? keyPath('message') : eventPath);
      setActor(projection, 'system', eventPath);
      setStringField(projection, 'severity', 'error', eventPath);
    } else {
      projection = projectItem(this.id, type, objectAt(value, 'item'), eventPath);
    }

    setStringField(projection, 'sessionId', stringAt(value, 'thread_id'), keyPath('thread_id'));
    setStringField(projection, 'turnId', stringAt(value, 'turn_id'), keyPath('turn_id'));
    setStringField(projection, 'timestamp', stringAt(value, 'timestamp') ?? stringAt(value, 'ts'), keyPath(stringAt(value, 'timestamp') ? 'timestamp' : 'ts'));
    return projection;
  }
}

function isExecEvent(type: string, value: Record<string, unknown>): boolean {
  switch (type) {
    case 'thread.started':
      return typeof own(value, 'thread_id') === 'string' && String(own(value, 'thread_id')).length > 0;
    case 'turn.started':
      return true;
    case 'turn.completed':
      return isValidExecUsage(own(value, 'usage'));
    case 'turn.failed':
      return typeof own(objectAt(value, 'error') ?? {}, 'message') === 'string';
    case 'item.started':
    case 'item.updated':
    case 'item.completed': {
      const item = objectAt(value, 'item');
      return isKnownExecItem(item);
    }
    case 'error':
      return typeof own(value, 'message') === 'string';
    default:
      return false;
  }
}

function isKnownExecItem(item: Record<string, unknown> | undefined): boolean {
  if (item === undefined) return false;
  const id = own(item, 'id');
  const type = stringAt(item, 'type');
  if (typeof id !== 'string' || id.length === 0 || type === undefined || !CODEX_EXEC_ITEM_TYPES.has(type) || !isKnownCodexItemType(type)) {
    return false;
  }
  switch (type) {
    case 'agent_message':
    case 'reasoning':
      return typeof own(item, 'text') === 'string';
    case 'command_execution':
      return typeof own(item, 'command') === 'string'
        && typeof own(item, 'aggregated_output') === 'string'
        && isNullableIntegerField(item, 'exit_code')
        && isOneOfStrings(own(item, 'status'), ['in_progress', 'completed', 'failed', 'declined']);
    case 'file_change':
      return Array.isArray(own(item, 'changes'))
        && (own(item, 'changes') as unknown[]).every((change) => isObject(change)
          && typeof own(change, 'path') === 'string'
          && isOneOfStrings(own(change, 'kind'), ['add', 'delete', 'update']))
        && isOneOfStrings(own(item, 'status'), ['in_progress', 'completed', 'failed']);
    case 'mcp_tool_call':
      return nonEmptyString(own(item, 'server'))
        && nonEmptyString(own(item, 'tool'))
        && Object.prototype.hasOwnProperty.call(item, 'result')
        && Object.prototype.hasOwnProperty.call(item, 'error')
        && isMcpResult(own(item, 'result'))
        && isMcpError(own(item, 'error'))
        && isOneOfStrings(own(item, 'status'), ['in_progress', 'completed', 'failed']);
    case 'collab_tool_call':
      return isOneOfStrings(own(item, 'tool'), ['spawn_agent', 'send_input', 'wait', 'close_agent'])
        && nonEmptyString(own(item, 'sender_thread_id'))
        && Array.isArray(own(item, 'receiver_thread_ids'))
        && (own(item, 'receiver_thread_ids') as unknown[]).every((id) => nonEmptyString(id))
        && Object.prototype.hasOwnProperty.call(item, 'prompt')
        && (own(item, 'prompt') === null || typeof own(item, 'prompt') === 'string')
        && isCollabAgentStates(own(item, 'agents_states'))
        && isOneOfStrings(own(item, 'status'), ['in_progress', 'completed', 'failed']);
    case 'web_search':
      return nonEmptyString(own(item, 'id'))
        && typeof own(item, 'query') === 'string'
        && isWebSearchAction(own(item, 'action'));
    case 'todo_list':
      return Array.isArray(own(item, 'items'))
        && (own(item, 'items') as unknown[]).every((todo) => isObject(todo)
          && typeof own(todo, 'text') === 'string'
          && typeof own(todo, 'completed') === 'boolean');
    case 'error':
      return typeof own(item, 'message') === 'string';
    default:
      return false;
  }
}

function isValidExecUsage(value: unknown): boolean {
  if (!isObject(value)) return false;
  return ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens']
    .every((key) => typeof own(value, key) === 'number' && Number.isFinite(own(value, key)));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNullableIntegerField(object: Record<string, unknown>, key: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(object, key)) return false;
  const value = own(object, key);
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value));
}

function isMcpResult(value: unknown): boolean {
  if (value === null) return true;
  return isObject(value) && Array.isArray(own(value, 'content'));
}

function isMcpError(value: unknown): boolean {
  return value === null || (isObject(value) && nonEmptyString(own(value, 'message')));
}

function isCollabAgentStates(value: unknown): boolean {
  if (!isObject(value)) return false;
  return Object.values(value).every((state) => isObject(state)
    && isOneOfStrings(own(state, 'status'), [
      'pending_init', 'running', 'interrupted', 'completed', 'errored', 'shutdown', 'not_found',
    ])
    && (own(state, 'message') === null || typeof own(state, 'message') === 'string'));
}

function isWebSearchAction(value: unknown): boolean {
  if (!isObject(value)) return false;
  const type = own(value, 'type');
  if (type === 'search') {
    return (own(value, 'query') === undefined || typeof own(value, 'query') === 'string')
      && (own(value, 'queries') === undefined
        || (Array.isArray(own(value, 'queries')) && (own(value, 'queries') as unknown[]).every((query) => typeof query === 'string')));
  }
  if (type === 'open_page') return own(value, 'url') === undefined || typeof own(value, 'url') === 'string';
  if (type === 'find_in_page') {
    return (own(value, 'url') === undefined || typeof own(value, 'url') === 'string')
      && (own(value, 'pattern') === undefined || typeof own(value, 'pattern') === 'string');
  }
  // `WebSearchAction` has a serde `other` variant. Preserve a tagged future
  // action as valid source data while leaving its fields opaque.
  return nonEmptyString(type);
}

function isOneOfStrings(value: unknown, choices: readonly string[]): value is string {
  return typeof value === 'string' && choices.includes(value);
}

function lifecycleClass(type: string): string {
  if (type.startsWith('item.')) return 'item';
  if (type.startsWith('turn.')) return 'turn';
  if (type.startsWith('thread.')) return 'thread';
  return type;
}

function firstString(object: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = stringAt(object, key);
    if (value) return value;
  }
  return undefined;
}

function firstPresentKey(object: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  if (!object) return undefined;
  return keys.find((key) => typeof own(object, key) === 'string');
}

function projectItem(
  profileId: string,
  eventType: string,
  item: Record<string, unknown> | undefined,
  eventPath: ReturnType<typeof keyPath>,
): AgentRowProjection {
  const lifecycle = eventType === 'item.started'
    ? 'item_started'
    : eventType === 'item.updated'
      ? 'item_updated'
      : 'item_completed';
  const classification = classifyCodexItem(item, lifecycle);
  const itemType = classification.itemType ?? 'unknown';
  const itemPath = keyPath('item', 'type');
  const summaryKey = codexItemSummaryKey(item);
  const summaryValue = summaryKey ? own(item ?? {}, summaryKey) : item;
  const projection = createProjection(
    profileId,
    classification.eventKind,
    boundedSummary(summaryValue, `${itemType} ${eventType.replace('item.', '')}`),
    classification.normalizedType ? itemPath : eventPath,
    summaryKey ? keyPath('item', summaryKey) : keyPath('item'),
  );
  setActor(projection, classification.actor, classification.normalizedType ? itemPath : eventPath ?? itemPath);
  setStringField(projection, 'messageId', stringAt(item, 'id'), keyPath('item', 'id'));
  if (classification.eventKind === 'tool_call' || classification.eventKind === 'tool_result') {
    setStringField(projection, 'toolCallId', firstString(item, ['id', 'call_id', 'tool_call_id']), keyPath('item', firstPresentKey(item, ['id', 'call_id', 'tool_call_id']) ?? 'id'));
  }
  setStringField(projection, 'status', firstString(item, ['status', 'kind']), keyPath('item', firstPresentKey(item, ['status', 'kind']) ?? 'status'));
  setDerivedField(projection, 'lifecycle', eventType.replace('item.', ''), keyPath('type'));
  setDerivedField(projection, 'wireItemType', itemType, itemPath);
  const extensionKind = codexItemExtensionKind(item);
  if (extensionKind !== undefined) setDerivedField(projection, 'extensionKind', extensionKind, keyPath('item', 'kind'));
  setDerivedField(projection, 'wireEvent', eventType, keyPath('type'));
  const text = extractText(own(item ?? {}, 'content')) ?? stringAt(item, 'text');
  if (text !== undefined && text !== projection.summary) {
    projection.evidence.push(evidence('content', own(item ?? {}, 'content') !== undefined ? keyPath('item', 'content') : keyPath('item', 'text')));
  }
  return projection;
}
