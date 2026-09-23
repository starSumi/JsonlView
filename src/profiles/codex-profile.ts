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
  setDerivedField,
  setStringField,
  stringAt,
  usageFromObject,
} from './utils';
import { sourceSurfaceEvidence } from './shape-discovery';
import {
  classifyCodexItem,
  codexItemExtensionKind,
  codexItemSummaryKey,
  isKnownCodexItemType,
} from './codex-item-strategy';

const CODEX_TYPES = new Set([
  'session_meta',
  'turn_context',
  'response_item',
  'event_msg',
  'world_state',
  'compacted',
  'inter_agent_communication_metadata',
  'inter_agent_communication',
  'token_usage_record',
  'retained_context',
  'security_risk_score',
  'realtime_item',
]);

const CODEX_EVENT_MESSAGE_TYPES = new Set([
  'error',
  'warning',
  'auth_recovery_started',
  'auth_recovery_completed',
  'guardian_warning',
  'realtime_conversation_started',
  'realtime_conversation_realtime',
  'realtime_conversation_closed',
  'realtime_conversation_sdp',
  'model_reroute',
  'model_verification',
  'turn_moderation_metadata',
  'safety_buffering',
  'context_compacted',
  'thread_rolled_back',
  'task_started',
  'turn_started',
  'thread_settings_applied',
  'turn_complete',
  'task_complete',
  'token_count',
  'agent_message',
  'assistant_message',
  'user_message',
  'agent_reasoning',
  'agent_reasoning_raw_content',
  'agent_reasoning_section_break',
  'session_configured',
  'environment_connected',
  'environment_disconnected',
  'thread_goal_updated',
  'thread_queue_changed',
  'mcp_startup_update',
  'mcp_startup_complete',
  'mcp_tool_call_begin',
  'mcp_tool_call_end',
  'web_search_begin',
  'web_search_end',
  'image_generation_begin',
  'image_generation_end',
  'exec_command_begin',
  'exec_command_output_delta',
  'terminal_interaction',
  'exec_command_end',
  'view_image_tool_call',
  'exec_approval_request',
  'request_permissions',
  'request_user_input',
  'dynamic_tool_call_request',
  'dynamic_tool_call_response',
  'elicitation_request',
  'apply_patch_approval_request',
  'guardian_assessment',
  'deprecation_notice',
  'stream_error',
  'patch_apply_begin',
  'patch_apply_updated',
  'patch_apply_end',
  'turn_diff',
  'realtime_conversation_list_voices_response',
  'plan_update',
  'turn_aborted',
  'shutdown_complete',
  'entered_review_mode',
  'exited_review_mode',
  'raw_response_item',
  'raw_response_completed',
  'item_started',
  'item_completed',
  'hook_started',
  'hook_completed',
  'agent_message_content_delta',
  'plan_delta',
  'reasoning_content_delta',
  'reasoning_raw_content_delta',
  'collab_agent_spawn_begin',
  'collab_agent_spawn_end',
  'collab_agent_interaction_begin',
  'collab_agent_interaction_end',
  'collab_waiting_begin',
  'collab_waiting_end',
  'collab_close_begin',
  'collab_close_end',
  'collab_resume_begin',
  'collab_resume_end',
  'sub_agent_activity',
]);

const RESPONSE_ITEM_TYPES = new Set([
  'additional_tools',
  'message',
  'agent_message',
  'reasoning',
  'local_shell_call',
  'function_call',
  'tool_search_call',
  'function_call_output',
  'mcp_tool_call_output',
  'custom_tool_call',
  'custom_tool_call_output',
  'tool_search_output',
  'web_search_call',
  'image_generation_call',
  'compaction',
  'compaction_summary',
  'configuration_update',
  'compaction_trigger',
  'context_compaction',
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
    const matchingIndices: number[] = [];
    let objectCount = 0;
    const validatedTypes = new Set<string>();
    const reasons: DetectionResult['reasons'] = [];

    for (const [index, entry] of sample.entries()) {
      if (!isObject(entry.value)) continue;
      objectCount += 1;
      const type = stringAt(entry.value, 'type');
      const timestamp = stringAt(entry.value, 'timestamp');
      const payload = objectAt(entry.value, 'payload');
      if (type && timestamp && payload) {
        envelopeCount += 1;
        pushReason(reasons, keyPath('payload'), 'Codex-style timestamp/type/payload envelope');
      }
      const validKnownPayload = type !== undefined && CODEX_TYPES.has(type) && isValidCodexPayload(type, payload);
      if (validKnownPayload) {
        knownTypeCount += 1;
        validatedTypes.add(type);
        pushReason(reasons, keyPath('type'), `Known Codex rollout record type: ${type}`);
      }
      if (type && timestamp && payload && validKnownPayload) matchingIndices.push(index);
      if (
        validKnownPayload && (
          type === 'session_meta'
          || type === 'turn_context'
          || type === 'response_item'
          || (type !== undefined && AUXILIARY_CODEX_TYPES.has(type))
        )
      ) {
        distinctiveCount += 1;
      }
    }

    const denominator = Math.max(1, sample.length);
    const coverage = Math.min(1, envelopeCount / denominator);
    const trustedRolloutPath = sample.length > 0
      && sample.every((entry) => sourceSurfaceEvidence(entry.sourcePathHint)?.kind === 'codex-rollout'
        && sourceSurfaceEvidence(entry.sourcePathHint)?.strength === 'strong');
    const sparseTailRecovery = !trustedRolloutPath && isContiguousMatchingBlock(matchingIndices, sample.length, objectCount);
    if (sparseTailRecovery) {
      pushReason(reasons, keyPath('type'), 'All parseable objects form a bounded matching block among blank/problem rows');
    }
    const coverageFloor = trustedRolloutPath ? 0.2 : sparseTailRecovery ? 0.08 : 0.25;
    const score = Math.min(0.99, 0.35 * coverage + 0.35 * Math.min(1, knownTypeCount / 2) + 0.29 * Math.min(1, distinctiveCount / 2));
    const hasCoreAnchor = ['session_meta', 'turn_context', 'response_item', 'world_state', 'compacted']
      .some((type) => validatedTypes.has(type));
    const hasAuxiliaryQuorum = validatedTypes.size >= 2
      && knownTypeCount >= 3
      && ['token_usage_record', 'realtime_item', 'inter_agent_communication'].some((type) => validatedTypes.has(type));
    const shapeQuorum = trustedRolloutPath
      ? knownTypeCount >= 1
      : knownTypeCount >= 2 && (hasCoreAnchor || hasAuxiliaryQuorum);
    return {
      profileId: this.id,
      profileVersion: this.version,
      score,
      reasons,
      requiredEvidenceMet: envelopeCount >= Math.min(2, denominator)
        && knownTypeCount >= 1
        && distinctiveCount >= 1
        && coverage >= coverageFloor
        && shapeQuorum,
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
    const eventEvidencePath = eventPath ?? keyPath('type');
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
        setStringField(projection, 'subagentId', firstString(payload, ['agent_id', 'child_id', 'subagent_id', 'recipient']), keyPath('payload', firstPresentKey(payload, ['agent_id', 'child_id', 'subagent_id', 'recipient']) ?? 'recipient'));
        setStringField(projection, 'parentId', firstString(payload, ['parent_id', 'parent_agent_id', 'author']), keyPath('payload', firstPresentKey(payload, ['parent_id', 'parent_agent_id', 'author']) ?? 'author'));
        break;
      case 'inter_agent_communication':
        projection = createProjection(this.id, 'subagent', boundedSummary(payload, 'Agent communication'), eventPath, keyPath('payload'));
        setStringField(projection, 'subagentId', firstString(payload, ['agent_id', 'child_id', 'subagent_id', 'recipient', 'receiver_thread_id']), keyPath('payload', firstPresentKey(payload, ['agent_id', 'child_id', 'subagent_id', 'recipient', 'receiver_thread_id']) ?? 'recipient'));
        setStringField(projection, 'parentId', firstString(payload, ['parent_id', 'parent_agent_id', 'author', 'sender_thread_id']), keyPath('payload', firstPresentKey(payload, ['parent_id', 'parent_agent_id', 'author', 'sender_thread_id']) ?? 'author'));
        setActor(projection, 'agent', eventEvidencePath);
        break;
      case 'token_usage_record': {
        projection = createProjection(this.id, 'usage', boundedSummary(payload, 'Token usage'), eventPath, keyPath('payload'));
        const usage = usageFromObject(payload) ?? usageFromObject(objectAt(payload, 'usage'));
        if (usage) {
          projection.usage = usage;
          projection.evidence.push(evidence('usage', keyPath('payload')));
        }
        setStringField(projection, 'sessionId', stringAt(payload, 'session_id'), keyPath('payload', 'session_id'));
        setStringField(projection, 'turnId', stringAt(payload, 'turn_id'), keyPath('payload', 'turn_id'));
        setStringField(projection, 'parentId', stringAt(payload, 'root_turn_id'), keyPath('payload', 'root_turn_id'));
        setStringField(projection, 'messageId', stringAt(payload, 'response_id'), keyPath('payload', 'response_id'));
        setActor(projection, 'system', eventEvidencePath);
        break;
      }
      case 'security_risk_score':
        projection = createProjection(this.id, 'error', boundedSummary(payload, 'Security risk score'), eventPath, keyPath('payload'));
        setStringField(projection, 'severity', 'warning', eventEvidencePath);
        setActor(projection, 'system', eventEvidencePath);
        break;
      case 'retained_context':
        projection = createProjection(this.id, 'checkpoint', boundedSummary(payload, 'Retained context'), eventPath, keyPath('payload'));
        setActor(projection, 'system', eventEvidencePath);
        break;
      case 'realtime_item':
        projection = createProjection(this.id, 'other', boundedSummary(payload, 'Realtime item'), eventPath, keyPath('payload'));
        setActor(projection, 'system', eventEvidencePath);
        break;
      case 'compacted':
      case 'world_state':
        projection = createProjection(this.id, 'checkpoint', boundedSummary(payload, type), eventPath, keyPath('payload'));
        setActor(projection, 'system', eventEvidencePath);
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
      case 'item_started':
      case 'item_updated':
      case 'item_completed':
        projection = this.projectCompletedItem(payload, eventPath, eventType);
        break;
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
      // Codex v1 keeps the historical `task_*` wire names for the turn
      // lifecycle. They are aliases of `turn_started`/`turn_complete`, not
      // sub-agent activity (which has its own `sub_agent_activity` event).
      case 'task_started':
      case 'turn_started':
        projection = createProjection(this.id, 'turn', boundedSummary(payload, 'Turn started'), eventPath, keyPath('payload'));
        setActor(projection, 'assistant', eventTypePath);
        break;
      case 'task_complete':
      case 'turn_complete':
        {
          const terminalMessage = own(payload ?? {}, 'last_agent_message');
          const terminalError = own(payload ?? {}, 'error');
          const summaryValue = terminalMessage ?? terminalError;
          const summaryPath = terminalMessage !== undefined
            ? keyPath('payload', 'last_agent_message')
            : terminalError !== undefined
              ? keyPath('payload', 'error')
              : keyPath('payload');
          projection = createProjection(
            this.id,
            'result',
            boundedSummary(summaryValue, terminalError !== undefined && terminalMessage === undefined ? 'Turn failed' : 'Turn complete'),
            eventPath,
            summaryPath,
          );
        }
        setActor(projection, 'assistant', eventTypePath);
        break;
      case 'agent_reasoning':
      case 'agent_reasoning_raw_content':
      case 'agent_reasoning_section_break':
      case 'reasoning_content_delta':
      case 'reasoning_raw_content_delta':
        projection = createProjection(this.id, 'reasoning', boundedSummary(own(payload ?? {}, 'text') ?? payload, eventType), eventPath, own(payload ?? {}, 'text') !== undefined ? keyPath('payload', 'text') : keyPath('payload'));
        setActor(projection, 'assistant', eventTypePath);
        break;
      case 'thread_settings_applied':
      case 'session_configured':
      case 'environment_connected':
      case 'environment_disconnected':
        projection = createProjection(this.id, 'action', boundedSummary(payload, eventType), eventPath, keyPath('payload'));
        setActor(projection, 'system', eventTypePath);
        break;
      case 'mcp_tool_call_begin':
      case 'exec_command_begin':
      case 'web_search_begin':
      case 'image_generation_begin':
      case 'view_image_tool_call':
      case 'dynamic_tool_call_request':
        projection = createProjection(this.id, 'tool_call', boundedSummary(payload, eventType), eventPath, keyPath('payload'));
        setActor(projection, 'assistant', eventTypePath);
        break;
      case 'mcp_tool_call_end':
      case 'exec_command_end':
      case 'web_search_end':
      case 'image_generation_end':
      case 'dynamic_tool_call_response':
        projection = createProjection(this.id, 'tool_result', boundedSummary(payload, eventType), eventPath, keyPath('payload'));
        setActor(projection, 'tool', eventTypePath);
        break;
      case 'patch_apply_begin':
      case 'patch_apply_updated':
      case 'patch_apply_end':
      case 'turn_diff':
        projection = createProjection(this.id, 'patch', boundedSummary(payload, eventType), eventPath, keyPath('payload'));
        setActor(projection, 'assistant', eventTypePath);
        break;
      case 'plan_update':
      case 'plan_delta':
        projection = createProjection(this.id, 'task', boundedSummary(payload, eventType), eventPath, keyPath('payload'));
        setActor(projection, 'assistant', eventTypePath);
        break;
      case 'sub_agent_activity':
      case 'collab_agent_spawn_begin':
      case 'collab_agent_spawn_end':
      case 'collab_agent_interaction_begin':
      case 'collab_agent_interaction_end':
      case 'collab_waiting_begin':
      case 'collab_waiting_end':
      case 'collab_close_begin':
      case 'collab_close_end':
      case 'collab_resume_begin':
      case 'collab_resume_end':
        projection = createProjection(this.id, 'subagent', boundedSummary(payload, eventType), eventPath, keyPath('payload'));
        setActor(projection, 'agent', eventTypePath);
        setStringField(projection, 'subagentId', firstString(payload, ['agent_thread_id', 'agent_id', 'task_id', 'agent_path']), keyPath('payload', firstPresentKey(payload, ['agent_thread_id', 'agent_id', 'task_id', 'agent_path']) ?? 'agent_thread_id'));
        break;
      default:
        projection = createProjection(this.id, 'other', boundedSummary(payload, eventType ? `Unknown event ${eventType}` : 'Event message'), eventPath, keyPath('payload'));
        break;
    }

    setStringField(projection, 'turnId', stringAt(payload, 'turn_id'), keyPath('payload', 'turn_id'));
    setStringField(projection, 'sessionId', stringAt(payload, 'thread_id') ?? stringAt(payload, 'session_id'), keyPath('payload', stringAt(payload, 'thread_id') ? 'thread_id' : 'session_id'));
    setStringField(projection, 'toolCallId', firstString(payload, ['call_id', 'tool_call_id']), keyPath('payload', firstPresentKey(payload, ['call_id', 'tool_call_id']) ?? 'call_id'));
    return projection;
  }

  private projectCompletedItem(
    payload: Record<string, unknown> | undefined,
    outerPath: FieldPath | undefined,
    lifecycle: 'item_started' | 'item_updated' | 'item_completed',
  ): AgentRowProjection {
    const item = objectAt(payload, 'item');
    const itemPath = keyPath('payload', 'item');
    const itemTypePath = keyPath('payload', 'item', 'type');
    const classification = classifyCodexItem(item, lifecycle);
    const itemType = classification.itemType ?? 'unknown';
    const summaryKey = codexItemSummaryKey(item);
    const summaryValue = summaryKey ? own(item ?? {}, summaryKey) : item;
    const projection = createProjection(
      this.id,
      classification.eventKind,
      boundedSummary(summaryValue, `${itemType} ${lifecycle.replace('item_', '')}`),
      classification.normalizedType ? itemTypePath : outerPath,
      summaryKey ? keyPath('payload', 'item', summaryKey) : itemPath,
    );
    setActor(projection, classification.actor, classification.normalizedType ? itemTypePath : outerPath ?? itemPath);
    setStringField(projection, 'messageId', firstString(item, ['id', 'message_id']), keyPath('payload', 'item', firstPresentKey(item, ['id', 'message_id']) ?? 'id'));
    if (classification.eventKind === 'tool_call' || classification.eventKind === 'tool_result') {
      setStringField(projection, 'toolCallId', firstString(item, ['id', 'call_id', 'tool_call_id']), keyPath('payload', 'item', firstPresentKey(item, ['id', 'call_id', 'tool_call_id']) ?? 'id'));
    }
    setStringField(projection, 'subagentId', firstString(item, ['agent_thread_id', 'agent_id', 'agent_path']), keyPath('payload', 'item', firstPresentKey(item, ['agent_thread_id', 'agent_id', 'agent_path']) ?? 'agent_thread_id'));
    setStringField(projection, 'status', firstString(item, ['status', 'kind']), keyPath('payload', 'item', firstPresentKey(item, ['status', 'kind']) ?? 'status'));
    setDerivedField(projection, 'lifecycle', lifecycle.replace('item_', ''), keyPath('payload', 'type'));
    setDerivedField(projection, 'wireItemType', itemType, itemTypePath);
    const extensionKind = codexItemExtensionKind(item);
    if (extensionKind !== undefined) setDerivedField(projection, 'extensionKind', extensionKind, keyPath('payload', 'item', 'kind'));
    return projection;
  }
}

const AUXILIARY_CODEX_TYPES = new Set([
  'inter_agent_communication',
  'inter_agent_communication_metadata',
  'token_usage_record',
  'retained_context',
  'security_risk_score',
  'realtime_item',
]);

/**
 * Validate the discriminator payload before using it as producer identity.
 * Common `{timestamp,type,payload}` envelopes are deliberately insufficient:
 * each persisted Codex variant has a small, source-backed shape of its own.
 */
function isValidCodexPayload(type: string, payload: Record<string, unknown> | undefined): boolean {
  if (payload === undefined) return false;
  switch (type) {
    case 'session_meta':
      return nonEmptyString(own(payload, 'id'))
        && optionalString(payload, 'session_id')
        && nonEmptyString(own(payload, 'timestamp'))
        && nonEmptyString(own(payload, 'cwd'))
        && nonEmptyString(own(payload, 'originator'))
        && nonEmptyString(own(payload, 'cli_version'));
    case 'turn_context':
      return optionalString(payload, 'turn_id')
        && nonEmptyString(own(payload, 'cwd'))
        && nonEmptyString(own(payload, 'approval_policy'))
        && isObject(own(payload, 'sandbox_policy'))
        && nonEmptyString(own(payload, 'model'));
    case 'response_item':
      return isValidResponseItem(payload);
    case 'event_msg':
      return isValidCodexEventMessage(payload);
    case 'world_state':
      return typeof own(payload, 'full') === 'boolean' && isObject(own(payload, 'state'));
    case 'compacted':
      return nonEmptyString(own(payload, 'message'));
    case 'inter_agent_communication':
      return nonEmptyString(own(payload, 'author'))
        && nonEmptyString(own(payload, 'recipient'))
        && typeof own(payload, 'trigger_turn') === 'boolean'
        && typeof own(payload, 'content') === 'string'
        && optionalString(payload, 'encrypted_content')
        && optionalStringArray(payload, 'other_recipients');
    case 'inter_agent_communication_metadata':
      return typeof own(payload, 'trigger_turn') === 'boolean';
    case 'token_usage_record':
      return ['thread_id', 'turn_id', 'session_id', 'root_turn_id', 'response_id'].every((key) => nonEmptyString(own(payload, key)))
        && isTokenUsage(own(payload, 'usage'))
        && isTokenUsage(own(payload, 'turn_token_usage'))
        && isTokenUsage(own(payload, 'thread_token_usage'));
    case 'retained_context':
      return isRetainedContext(payload);
    case 'security_risk_score':
      return isSecurityRiskScore(payload);
    case 'realtime_item':
      return isRealtimeItem(payload);
    default:
      return false;
  }
}

function isValidCodexEventMessage(payload: Record<string, unknown>): boolean {
  const eventType = own(payload, 'type');
  if (!nonEmptyString(eventType) || !CODEX_EVENT_MESSAGE_TYPES.has(eventType)) return false;
  if (eventType !== 'item_started' && eventType !== 'item_completed') return true;
  const item = objectAt(payload, 'item');
  const itemType = stringAt(item, 'type');
  return nonEmptyString(stringAt(item, 'id')) && isKnownCodexItemType(itemType);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function optionalString(object: Record<string, unknown>, key: string): boolean {
  const value = own(object, key);
  return value === undefined || typeof value === 'string';
}

function optionalStringArray(object: Record<string, unknown>, key: string): boolean {
  const value = own(object, key);
  return value === undefined || (Array.isArray(value) && value.every((item) => nonEmptyString(item)));
}

function isTokenUsage(value: unknown): boolean {
  if (!isObject(value)) return false;
  return ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens']
    .every((key) => typeof own(value, key) === 'number' && Number.isFinite(own(value, key)));
}

function isRetainedContext(value: Record<string, unknown>): boolean {
  // The rollout payload is a tagged RetainedContextEvent. The similarly named
  // `{verified_answers, user_messages, ...}` object is only a nested compaction
  // snapshot and must not establish producer identity at the top level.
  if (own(value, 'type') !== 'verified_answer'
    || !nonEmptyString(own(value, 'turn_id'))
    || !nonEmptyString(own(value, 'call_id'))
    || !Array.isArray(own(value, 'questions'))) {
    return false;
  }
  const questions = own(value, 'questions') as unknown[];
  return questions.every((question) => isObject(question)
    && typeof own(question, 'question') === 'string'
    && typeof own(question, 'answer') === 'string')
    && (own(value, 'acceptance_order') === undefined
      || typeof own(value, 'acceptance_order') === 'number'
      && Number.isSafeInteger(own(value, 'acceptance_order'))
      && (own(value, 'acceptance_order') as number) >= 0);
}

function isSecurityRiskScore(value: Record<string, unknown>): boolean {
  const scores = own(value, 'scores');
  if (!isObject(scores)) return false;
  const entries = Object.values(scores);
  return entries.every((score) => typeof score === 'number' && Number.isFinite(score))
    && optionalString(value, 'call_id')
    && (own(value, 'action') === undefined || own(value, 'action') === null || isObject(own(value, 'action')))
    && (own(value, 'sampled_at') === undefined || typeof own(value, 'sampled_at') === 'string');
}

function isRealtimeItem(value: Record<string, unknown>): boolean {
  if (!nonEmptyString(own(value, 'id')) || !nonEmptyString(own(value, 'realtime_session_id'))) return false;
  switch (own(value, 'type')) {
    case 'realtime_session_started':
      return true;
    case 'transcript_segment':
      return (own(value, 'role') === 'user' || own(value, 'role') === 'assistant') && typeof own(value, 'text') === 'string';
    case 'bem_item_promoted':
      return nonEmptyString(own(value, 'turn_id'))
        && nonEmptyString(own(value, 'item_id'))
        && isBemItemPresentation(own(value, 'presentation'));
    case 'realtime_session_closed':
      return own(value, 'outcome') === 'ended' || own(value, 'outcome') === 'failed';
    default:
      return false;
  }
}

function isBemItemPresentation(value: unknown): boolean {
  if (!isObject(value) || !nonEmptyString(own(value, 'type'))) return false;
  switch (own(value, 'type')) {
    case 'whole_item':
    case 'inline_markdown':
      return true;
    case 'inline_visualization':
      return typeof own(value, 'index') === 'number'
        && Number.isSafeInteger(own(value, 'index'))
        && (own(value, 'index') as number) >= 0;
    default:
      return false;
  }
}

function isValidResponseItem(value: Record<string, unknown>): boolean {
  const type = stringAt(value, 'type');
  if (type === undefined || !RESPONSE_ITEM_TYPES.has(type)) return false;
  switch (type) {
    case 'additional_tools':
      return nonEmptyString(own(value, 'role')) && Array.isArray(own(value, 'tools'));
    case 'message':
      return nonEmptyString(own(value, 'role')) && Array.isArray(own(value, 'content'));
    case 'agent_message':
      return nonEmptyString(own(value, 'author'))
        && nonEmptyString(own(value, 'recipient'))
        && Array.isArray(own(value, 'content'));
    case 'reasoning':
      return Array.isArray(own(value, 'summary'))
        && (own(value, 'content') === undefined || Array.isArray(own(value, 'content')))
        && (own(value, 'encrypted_content') === undefined
          || own(value, 'encrypted_content') === null
          || typeof own(value, 'encrypted_content') === 'string');
    case 'local_shell_call':
      return nonEmptyString(own(value, 'status')) && isObject(own(value, 'action'));
    case 'function_call':
      return nonEmptyString(own(value, 'name'))
        && typeof own(value, 'arguments') === 'string'
        && nonEmptyString(own(value, 'call_id'));
    case 'tool_search_call':
      return nonEmptyString(own(value, 'execution')) && Object.prototype.hasOwnProperty.call(value, 'arguments');
    case 'function_call_output':
    case 'custom_tool_call_output':
      return Object.prototype.hasOwnProperty.call(value, 'output');
    case 'mcp_tool_call_output':
      return nonEmptyString(own(value, 'call_id')) && isObject(own(value, 'output'));
    case 'custom_tool_call':
      return nonEmptyString(own(value, 'call_id'))
        && nonEmptyString(own(value, 'name'))
        && typeof own(value, 'input') === 'string';
    case 'tool_search_output':
      return nonEmptyString(own(value, 'status'))
        && nonEmptyString(own(value, 'execution'))
        && Array.isArray(own(value, 'tools'));
    case 'web_search_call':
      return (own(value, 'action') === undefined || isWebSearchAction(own(value, 'action')))
        && (own(value, 'status') === undefined || typeof own(value, 'status') === 'string');
    case 'image_generation_call':
      return nonEmptyString(own(value, 'status')) && typeof own(value, 'result') === 'string';
    case 'compaction':
    case 'compaction_summary':
      return typeof own(value, 'encrypted_content') === 'string';
    case 'configuration_update':
      return isObject(own(value, 'reasoning'));
    case 'compaction_trigger':
    case 'context_compaction':
      return true;
    default:
      return false;
  }
}

function isWebSearchAction(value: unknown): boolean {
  if (!isObject(value)) return false;
  const type = own(value, 'type');
  if (type === 'search') {
    return (own(value, 'query') === undefined || typeof own(value, 'query') === 'string')
      && (own(value, 'queries') === undefined || (Array.isArray(own(value, 'queries')) && (own(value, 'queries') as unknown[]).every((query) => typeof query === 'string')));
  }
  if (type === 'open_page') return own(value, 'url') === undefined || typeof own(value, 'url') === 'string';
  if (type === 'find_in_page') {
    return (own(value, 'url') === undefined || typeof own(value, 'url') === 'string')
      && (own(value, 'pattern') === undefined || typeof own(value, 'pattern') === 'string');
  }
  return false;
}

function isContiguousMatchingBlock(indices: readonly number[], sampleLength: number, objectCount: number): boolean {
  if (indices.length < 3 || objectCount !== indices.length || sampleLength <= indices.length) return false;
  const ordered = [...indices].sort((left, right) => left - right);
  const first = ordered[0];
  if (first === undefined) return false;
  return ordered.every((index, offset) => index === first + offset);
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
