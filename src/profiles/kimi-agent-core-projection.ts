import type { AgentRowProjection, FieldPath } from '@shared/types';
import { isKimiAgentCoreRecord, kimiContentPreview, kimiUsage } from './kimi-record';
import { actorFromRole, boundedSummary, createProjection, evidence, indexedPath, keyPath, numberAt, objectAt, own, setActor, setDerivedField as setRawDerivedField, setStringField as setRawStringField, stringAt } from './utils';

export function projectKimiAgentCoreEvent(
  value: Record<string, unknown>,
  profileId: string,
): AgentRowProjection | undefined {
  if (!isKimiAgentCoreRecord(value)) return undefined;

  switch (stringAt(value, 'type')) {
    case 'runtime.set_binding': {
      const projection = createProjection(profileId, 'observation', 'Kimi runtime binding', keyPath('type'));
      setActor(projection, 'system', keyPath('type'));
      setDerived(projection, 'workspaceId', stringAt(value, 'workspaceId'), keyPath('workspaceId'));
      setDerived(projection, 'runtimeId', stringAt(value, 'runtimeId'), keyPath('runtimeId'));
      return projection;
    }
    case 'permission.set_mode': {
      const projection = createProjection(profileId, 'observation', 'Kimi permission mode', keyPath('type'));
      setActor(projection, 'system', keyPath('type'));
      setDerived(projection, 'permissionMode', stringAt(value, 'mode'), keyPath('mode'));
      return projection;
    }
    case 'plugin.session_start': {
      const content = own(value, 'content');
      const projection = createProjection(profileId, 'session', 'Kimi plugin session start', keyPath('type'));
      setActor(projection, 'system', keyPath('type'));
      setDerived(projection, 'pluginContentLength', typeof content === 'string' ? content.length : undefined, keyPath('content'));
      return projection;
    }
    case 'agent.message.appended': {
      const message = objectAt(value, 'message', 'message');
      return message ? projectKimiMessage(message, profileId, ['message', 'message']) : undefined;
    }
    case 'agent.turn.started': {
      const projection = createProjection(profileId, 'turn', 'Kimi agent turn started', keyPath('type'));
      setActor(projection, 'assistant', keyPath('type'));
      setStatus(projection, 'running', keyPath('type'));
      setTurn(projection, own(value, 'turnId'), keyPath('turnId'));
      setDerived(projection, 'queueItemId', stringAt(value, 'queueItemId'), keyPath('queueItemId'));
      return projection;
    }
    case 'agent.turn.ended': {
      const outcome = stringAt(value, 'outcome')!;
      const status = outcome === 'done' ? 'completed' : outcome;
      const projection = createProjection(profileId, 'turn', boundedSummary(outcome, 'Kimi agent turn ended'), keyPath('type'));
      setActor(projection, 'assistant', keyPath('type'));
      setStatus(projection, status, keyPath('outcome'));
      setTurn(projection, own(value, 'turnId'), keyPath('turnId'));
      return projection;
    }
    case 'turn.ended': {
      const reason = stringAt(value, 'reason')!;
      const projection = createProjection(profileId, 'turn', boundedSummary(reason, 'Kimi turn ended'), keyPath('type'));
      setActor(projection, 'assistant', keyPath('type'));
      setStatus(projection, reason, keyPath('reason'));
      setTurn(projection, own(value, 'turnId'), keyPath('turnId'));
      setDerived(projection, 'durationMs', numberAt(value, 'durationMs'), keyPath('durationMs'));
      return projection;
    }
    case 'llm.request': {
      const provider = stringAt(value, 'provider')!;
      const model = stringAt(value, 'model')!;
      const projection = createProjection(profileId, 'observation', boundedSummary(`${provider}/${model}`, 'Kimi LLM request'), keyPath('type'));
      setActor(projection, 'system', keyPath('type'));
      setDerived(projection, 'provider', provider, keyPath('provider'));
      setDerived(projection, 'model', model, keyPath('model'));
      setDerived(projection, 'requestKind', stringAt(value, 'kind'), keyPath('kind'));
      setDerived(projection, 'messageCount', numberAt(value, 'messageCount'), keyPath('messageCount'));
      setDerived(projection, 'toolSelect', own(value, 'toolSelect') as boolean, keyPath('toolSelect'));
      setDerived(projection, 'systemPromptHash', stringAt(value, 'systemPromptHash'), keyPath('systemPromptHash'));
      setDerived(projection, 'toolsHash', stringAt(value, 'toolsHash'), keyPath('toolsHash'));
      return projection;
    }
    case 'usage.record': {
      const usage = kimiUsage(own(value, 'usage'));
      const projection = createProjection(profileId, 'observation', boundedSummary(stringAt(value, 'model'), 'Kimi usage'), keyPath('type'));
      setActor(projection, 'system', keyPath('type'));
      setDerived(projection, 'model', stringAt(value, 'model'), keyPath('model'));
      setDerived(projection, 'usageScope', stringAt(value, 'usageScope'), keyPath('usageScope'));
      if (usage) {
        projection.usage = usage;
        projection.evidence.push(evidence('usage', keyPath('usage')));
      }
      return projection;
    }
    case 'token_counting.measured':
    case 'token_counting.turn_recorded': {
      const turnId = own(value, 'turnId');
      const projection = createProjection(profileId, 'observation', 'Kimi token measurement', keyPath('type'));
      setActor(projection, 'system', keyPath('type'));
      setDerived(projection, 'length', numberAt(value, 'length'), keyPath('length'));
      setDerived(projection, 'tokens', numberAt(value, 'tokens'), keyPath('tokens'));
      if (turnId !== undefined) setTurn(projection, turnId, keyPath('turnId'));
      return projection;
    }
    case 'task.terminated': {
      const info = objectAt(value, 'info')!;
      const description = stringAt(info, 'description')!;
      const projection = createProjection(profileId, 'task', boundedSummary(description, 'Kimi task ended'), keyPath('type'), keyPath('info', 'description'));
      setActor(projection, 'system', keyPath('type'));
      setStatus(projection, stringAt(info, 'status')!, keyPath('info', 'status'));
      setDerived(projection, 'taskId', stringAt(info, 'taskId'), keyPath('info', 'taskId'));
      setDerived(projection, 'taskDescription', description, keyPath('info', 'description'));
      return projection;
    }
    case 'turn.prompt':
    case 'turn.steer': {
      const input = own(value, 'input') as unknown[];
      const origin = stringAt(value, 'origin', 'kind');
      const preview = kimiContentPreview(input);
      const projection = createProjection(profileId, 'message', boundedSummary(preview || origin || 'prompt', 'Kimi prompt'), keyPath('type'), keyPath('input'));
      setActor(projection, origin === 'user' ? 'user' : 'system', keyPath('origin', 'kind'));
      setDerived(projection, 'origin', origin, keyPath('origin', 'kind'));
      setDerived(projection, 'promptId', stringAt(value, 'promptId'), keyPath('promptId'));
      setDerived(projection, 'contentPartCount', input.length, keyPath('input'));
      setTurn(projection, own(value, 'turnId'), keyPath('turnId'));
      return projection;
    }
    case 'prompt.completed': {
      const reason = stringAt(value, 'reason')!;
      const projection = createProjection(profileId, 'turn', boundedSummary(reason, 'Kimi prompt completed'), keyPath('type'));
      setActor(projection, 'system', keyPath('type'));
      setStatus(projection, reason, keyPath('reason'));
      setDerived(projection, 'promptId', stringAt(value, 'promptId'), keyPath('promptId'));
      setDerived(projection, 'finishedAt', stringAt(value, 'finishedAt'), keyPath('finishedAt'));
      return projection;
    }
    default:
      return undefined;
  }
}

export function projectKimiMessage(
  message: Record<string, unknown>,
  profileId: string,
  rootPath: readonly string[] = ['message'],
): AgentRowProjection {
  const role = stringAt(message, 'role');
  const calls = Array.isArray(own(message, 'toolCalls')) ? own(message, 'toolCalls') as unknown[] : [];
  const tool = calls[0];
  const toolName = stringAt(tool, 'name') ?? stringAt(tool, 'function', 'name');
  const content = kimiContentPreview(own(message, 'content'));
  const kind = role === 'tool' ? 'tool_result' : role === 'assistant' && calls.length > 0 ? 'tool_call' : 'message';
  const rolePath = pathAt(rootPath, 'role');
  const contentPath = pathAt(rootPath, 'content');
  const callsPath = pathAt(rootPath, 'toolCalls');
  const projection = createProjection(profileId, kind, boundedSummary(content || toolName?.slice(0, 240) || role?.slice(0, 40) || 'message', 'Kimi ' + (role?.slice(0, 40) ?? 'message')),
    rolePath, content ? contentPath : toolName ? indexedPath([...rootPath, 'toolCalls'], 0) : rolePath);
  setActor(projection, actorFromRole(role?.slice(0, 40)), rolePath);
  setIdentity(projection, 'messageId', stringAt(message, 'id'), pathAt(rootPath, 'id'));
  setIdentity(projection, 'toolCallId', stringAt(message, 'toolCallId'), pathAt(rootPath, 'toolCallId'));
  if (calls.length === 1) setIdentity(projection, 'toolCallId', stringAt(tool, 'id'), indexPath(rootPath, 'toolCalls', 0, 'id'));
  if (calls.length > 0) {
    setDerived(projection, 'toolCallCount', calls.length, callsPath);
    setDerived(projection, 'toolName', toolName, indexPath(rootPath, 'toolCalls', 0, stringAt(tool, 'name') ? 'name' : 'function', ...(stringAt(tool, 'name') ? [] : ['name'])));
  }
  setDerived(projection, 'origin', stringAt(message, 'origin', 'kind'), pathAt(rootPath, 'origin', 'kind'));
  if (typeof own(message, 'isError') === 'boolean') setErrorStatus(projection, own(message, 'isError') === true, pathAt(rootPath, 'isError'));
  const usage = kimiUsage(own(message, 'usage'));
  if (usage) {
    projection.usage = usage;
    projection.evidence.push(evidence('usage', pathAt(rootPath, 'usage')));
  }
  return projection;
}

function pathAt(root: readonly string[], ...keys: string[]): FieldPath {
  return { tokens: [...root, ...keys].map((value) => ({ kind: 'key' as const, value })) };
}

function indexPath(root: readonly string[], field: string, index: number, ...tail: string[]): FieldPath {
  return indexedPath([...root, field], index, ...tail);
}

function setIdentity(projection: AgentRowProjection, field: 'messageId' | 'toolCallId' | 'turnId', value: string | undefined, path: FieldPath): void {
  if (value !== undefined && value.length > 2048) {
    setDerived(projection, 'identityOmitted', true, path);
    return;
  }
  setString(projection, field, value, path);
}

function setTurn(projection: AgentRowProjection, value: unknown, path: FieldPath): void {
  setIdentity(projection, 'turnId', typeof value === 'string' ? value
    : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined, path);
}

function setErrorStatus(projection: AgentRowProjection, isError: boolean, path: FieldPath): void {
  setStatus(projection, isError ? 'error' : 'completed', path);
  if (isError) setString(projection, 'severity', 'error', path);
}

function setDerived(projection: AgentRowProjection, field: string, value: string | number | boolean | undefined, path: FieldPath): void {
  setRawDerivedField(projection, field, typeof value === 'string' ? value.slice(0, 240) : value, path);
}

function setString<K extends keyof AgentRowProjection>(projection: AgentRowProjection, field: K, value: string | undefined, path: FieldPath): void {
  setRawStringField(projection, field, field === 'status' ? value?.slice(0, 240) : value, path);
}

function setStatus(projection: AgentRowProjection, value: string | undefined, path: FieldPath): void {
  setString(projection, 'status', value, path);
}
