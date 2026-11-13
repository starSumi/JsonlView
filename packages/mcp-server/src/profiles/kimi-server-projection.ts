import type { AgentRowProjection, FieldPath } from '../contracts/types.js';
import { kimiTimestamp, kimiUsage } from './kimi-record.js';
import { isKimiServerEventType, kimiServerContentPreview, type KimiServerEvent, type KimiServerEventType } from './kimi-server-record.js';
import { actorFromRole, boundedSummary, createProjection, evidence, indexedPath, keyPath, numberAt, objectAt, own, setActor, setDerivedField, setStringField, stringAt } from './utils.js';

const PROFILE = 'kimi-code-session';
const typePath = keyPath('envelope', 'type');
const payloadPath = (...keys: string[]): FieldPath => keyPath('envelope', 'payload', ...keys);
type Projector = (event: KimiServerEvent) => AgentRowProjection;

/** One bounded semantic projection for one physical journal line. */
export function projectKimiServerEvent(event: KimiServerEvent): AgentRowProjection {
  const projection = isKimiServerEventType(event.type) ? projectors[event.type](event) : make(event, 'other', 'system');
  const envelopeSession = stringAt(event.envelope, 'session_id');
  identity(projection, 'sessionId', envelopeSession ?? stringAt(event.payload, 'sessionId'), envelopeSession === undefined ? payloadPath('sessionId') : keyPath('envelope', 'session_id'));
  const clock = stringAt(event.envelope, 'timestamp');
  if (clock !== undefined && clock.length <= 64) {
    const time = Date.parse(clock);
    if (Number.isFinite(time)) setStringField(projection, 'timestamp', new Date(time).toISOString(), keyPath('envelope', 'timestamp'));
  }
  field(projection, 'agentId', stringAt(event.payload, 'agentId'), payloadPath('agentId'));
  const turn = own(event.payload, 'turnId');
  identity(projection, 'turnId', typeof turn === 'string' ? turn : typeof turn === 'number' && Number.isSafeInteger(turn) && turn >= 0 ? String(turn) : undefined, payloadPath('turnId'));
  identity(projection, 'toolCallId', stringAt(event.payload, 'toolCallId'), payloadPath('toolCallId'));
  field(projection, 'stepId', stringAt(event.payload, 'stepId'), payloadPath('stepId'));
  field(projection, 'step', numberAt(event.payload, 'step'), payloadPath('step'));
  field(projection, 'promptId', stringAt(event.payload, 'promptId'), payloadPath('promptId'));
  usage(projection, own(event.payload, 'usage'), payloadPath('usage'));
  return projection;
}

export function projectKimiServerHeader(value: Record<string, unknown>): AgentRowProjection {
  const projection = createProjection(PROFILE, 'session', 'Kimi server journal v1', keyPath('kind'), keyPath('version'));
  setActor(projection, 'system', keyPath('kind'));
  field(projection, 'journalVersion', numberAt(value, 'version'), keyPath('version'));
  setStringField(projection, 'timestamp', kimiTimestamp(numberAt(value, 'created_at')), keyPath('created_at'));
  return projection;
}

function make(event: KimiServerEvent, kind: AgentRowProjection['eventKind'], actor: AgentRowProjection['actor'], detail?: string, detailPath?: FieldPath, actorPath = typePath): AgentRowProjection {
  const projection = createProjection(PROFILE, kind, boundedSummary(detail?.slice(0, 240) ?? event.type.slice(0, 240), 'Kimi'), typePath, detail !== undefined ? detailPath ?? typePath : typePath);
  setActor(projection, actor, actorPath);
  return projection;
}

function session(event: KimiServerEvent): AgentRowProjection {
  const state = objectAt(event.payload, 'session');
  const patch = objectAt(event.payload, 'patch');
  const title = stringAt(state, 'title') ?? stringAt(event.payload, 'title') ?? stringAt(patch, 'title');
  const titlePath = stringAt(state, 'title') !== undefined ? payloadPath('session', 'title')
    : stringAt(event.payload, 'title') !== undefined ? payloadPath('title') : payloadPath('patch', 'title');
  const projection = make(event, 'session', 'system', title, title === undefined ? undefined : titlePath);
  field(projection, 'title', title, titlePath);
  field(projection, 'lastPrompt', stringAt(state, 'last_prompt') ?? stringAt(patch, 'lastPrompt'), stringAt(state, 'last_prompt') !== undefined ? payloadPath('session', 'last_prompt') : payloadPath('patch', 'lastPrompt'));
  const status = stringAt(state, 'status') ?? stringAt(event.payload, 'status') ?? stringAt(event.payload, 'last_turn_reason');
  statusField(projection, status, state && stringAt(state, 'status') !== undefined ? payloadPath('session', 'status')
    : stringAt(event.payload, 'status') !== undefined ? payloadPath('status') : payloadPath('last_turn_reason'));
  field(projection, 'previousStatus', stringAt(event.payload, 'previous_status'), payloadPath('previous_status'));
  field(projection, 'busy', scalar(event.payload, 'busy'), payloadPath('busy'));
  field(projection, 'currentPromptId', stringAt(event.payload, 'current_prompt_id'), payloadPath('current_prompt_id'));
  return projection;
}

function prompt(event: KimiServerEvent): AgentRowProjection {
  const contentEvent = event.type === 'prompt.submitted' || event.type === 'prompt.steered' || event.type === 'prompt.queued' || event.type === 'turn.steer';
  const contentKey = event.type === 'turn.steer' ? 'input' : 'content';
  const text = contentEvent ? kimiServerContentPreview(own(event.payload, contentKey)) : stringAt(event.payload, 'reason');
  const projection = make(event, contentEvent ? 'message' : 'turn', contentEvent ? 'user' : 'system', text || undefined, text ? payloadPath(contentEvent ? contentKey : 'reason') : undefined);
  const userMessageId = stringAt(event.payload, 'userMessageId');
  identity(projection, 'messageId', userMessageId ?? stringAt(event.payload, 'messageId'), payloadPath(userMessageId === undefined ? 'messageId' : 'userMessageId'));
  field(projection, 'activePromptId', stringAt(event.payload, 'activePromptId'), payloadPath('activePromptId'));
  const fixedStatus = event.type === 'prompt.aborted' ? 'aborted' : event.type === 'prompt.started' ? 'running' : event.type === 'prompt.queued' ? 'queued' : undefined;
  statusField(projection, fixedStatus ?? stringAt(event.payload, contentEvent ? 'status' : 'reason'), fixedStatus === undefined ? payloadPath(contentEvent ? 'status' : 'reason') : typePath);
  const content = own(event.payload, contentKey);
  if (Array.isArray(content)) field(projection, 'contentPartCount', content.length, payloadPath(contentKey));
  field(projection, 'queueLength', numberAt(event.payload, 'queueLength'), payloadPath('queueLength'));
  return projection;
}

function turn(event: KimiServerEvent): AgentRowProjection {
  const retry = event.type === 'turn.step.retrying';
  const message = stringAt(event.payload, retry ? 'errorMessage' : 'message');
  const error = stringAt(event.payload, 'error', 'message');
  const reason = stringAt(event.payload, 'reason');
  const detail = message ?? error ?? stringAt(event.payload, 'prompt') ?? reason;
  const detailPath = message !== undefined ? payloadPath(retry ? 'errorMessage' : 'message') : error !== undefined ? payloadPath('error', 'message')
    : stringAt(event.payload, 'prompt') !== undefined ? payloadPath('prompt') : payloadPath('reason');
  const projection = make(event, retry ? 'error' : 'turn', 'assistant', detail, detail === undefined ? undefined : detailPath);
  const statuses: Partial<Record<KimiServerEventType, string>> = { 'turn.started': 'running', 'turn.step.started': 'running', 'turn.step.retrying': 'retrying', 'turn.step.interrupted': 'interrupted' };
  const fixed = isKimiServerEventType(event.type) ? statuses[event.type] : undefined;
  statusField(projection, fixed ?? stringAt(event.payload, event.type === 'turn.step.completed' ? 'finishReason' : 'reason'), fixed === undefined ? payloadPath(event.type === 'turn.step.completed' ? 'finishReason' : 'reason') : typePath);
  if (retry || reason === 'failed' || objectAt(event.payload, 'error')) setStringField(projection, 'severity', retry ? 'warning' : 'error', retry ? typePath : reason === 'failed' ? payloadPath('reason') : payloadPath('error'));
  for (const key of ['nextAttempt', 'maxAttempts', 'delayMs', 'durationMs', 'statusCode']) field(projection, key, numberAt(event.payload, key), payloadPath(key));
  field(projection, 'reason', reason, payloadPath('reason'));
  field(projection, 'origin', stringAt(event.payload, 'origin', 'kind'), payloadPath('origin', 'kind'));
  return projection;
}

function context(event: KimiServerEvent): AgentRowProjection {
  const messages = own(event.payload, 'messages');
  const parts: string[] = [];
  if (Array.isArray(messages)) for (let index = 0; index < Math.min(messages.length, 16); index += 1) {
    const text = kimiServerContentPreview(objectAt(messages[index])?.content);
    if (text) parts.push(text);
    if (parts.join(' ').length >= 240) break;
  }
  const text = parts.join(' ').slice(0, 240);
  const one = Array.isArray(messages) && messages.length === 1 ? objectAt(messages[0]) : undefined;
  const projection = make(event, text ? 'message' : 'checkpoint', one ? actorFromRole(stringAt(one, 'role')) : 'system', text || undefined, text ? payloadPath('messages') : undefined, one ? indexedPath(['envelope', 'payload', 'messages'], 0, 'role') : typePath);
  if (one) {
    identity(projection, 'messageId', stringAt(one, 'id'), indexedPath(['envelope', 'payload', 'messages'], 0, 'id'));
  }
  field(projection, 'messageCount', Array.isArray(messages) ? messages.length : undefined, payloadPath('messages'));
  for (const key of ['start', 'deleteCount']) field(projection, key, numberAt(event.payload, key), payloadPath(key));
  return projection;
}

function error(event: KimiServerEvent): AgentRowProjection {
  const projection = make(event, event.type === 'error' ? 'error' : 'observation', 'system', stringAt(event.payload, 'message'), payloadPath('message'));
  setStringField(projection, 'severity', event.type === 'error' ? 'error' : 'warning', typePath);
  field(projection, 'errorCode', stringAt(event.payload, 'code'), payloadPath('code'));
  field(projection, 'retryable', scalar(event.payload, 'retryable'), payloadPath('retryable'));
  return projection;
}

function observer(event: KimiServerEvent): AgentRowProjection {
  const server = objectAt(event.payload, 'server');
  const name = stringAt(server, 'name') ?? stringAt(event.payload, 'serverName');
  const namePath = stringAt(server, 'name') !== undefined ? payloadPath('server', 'name') : payloadPath('serverName');
  const projection = make(event, 'observation', 'system', name, name === undefined ? undefined : namePath);
  field(projection, 'serverName', name, namePath);
  field(projection, 'toolCount', numberAt(server, 'toolCount'), payloadPath('server', 'toolCount'));
  field(projection, 'reason', stringAt(event.payload, 'reason'), payloadPath('reason'));
  statusField(projection, stringAt(server, 'status') ?? stringAt(event.payload, 'phase', 'kind'), stringAt(server, 'status') !== undefined ? payloadPath('server', 'status') : payloadPath('phase', 'kind'));
  setStringField(projection, 'model', stringAt(event.payload, 'model')?.slice(0, 240), payloadPath('model'));
  const currentUsage = objectAt(event.payload, 'usage', 'currentTurn');
  if (currentUsage) usage(projection, currentUsage, payloadPath('usage', 'currentTurn'));
  return projection;
}

function configWarning(event: KimiServerEvent): AgentRowProjection {
  const warnings = own(event.payload, 'warnings');
  const messages: string[] = [];
  if (Array.isArray(warnings)) for (let index = 0; index < Math.min(warnings.length, 16); index += 1) {
    const message = stringAt(warnings[index], 'message');
    if (message) messages.push(message.slice(0, 240));
    if (messages.join(' ').length >= 240) break;
  }
  const projection = make(event, 'observation', 'system', messages.join(' ') || undefined, payloadPath('warnings'));
  setStringField(projection, 'severity', 'warning', typePath);
  field(projection, 'warningCount', Array.isArray(warnings) ? warnings.length : undefined, payloadPath('warnings'));
  return projection;
}

function content(event: KimiServerEvent): AgentRowProjection {
  const thinking = event.type === 'thinking.delta';
  const detail = stringAt(event.payload, event.type === 'hook.result' ? 'content' : 'delta');
  return make(event, thinking ? 'reasoning' : 'message', 'assistant', detail, payloadPath(event.type === 'hook.result' ? 'content' : 'delta'));
}

function tool(event: KimiServerEvent): AgentRowProjection {
  const result = event.type === 'tool.result';
  const progress = event.type === 'tool.progress';
  const detail = result ? kimiServerContentPreview(own(event.payload, 'output')) : progress ? stringAt(event.payload, 'update', 'text') : stringAt(event.payload, 'name');
  const projection = make(event, result ? 'tool_result' : progress ? 'observation' : 'tool_call', result || progress ? 'tool' : 'assistant', detail || undefined, result ? payloadPath('output') : progress ? payloadPath('update', 'text') : payloadPath('name'));
  field(projection, 'toolName', stringAt(event.payload, 'name'), payloadPath('name'));
  field(projection, 'toolCommand', stringAt(event.payload, 'display', 'command') ?? stringAt(event.payload, 'args', 'command'), stringAt(event.payload, 'display', 'command') !== undefined ? payloadPath('display', 'command') : payloadPath('args', 'command'));
  const isError = own(event.payload, 'isError');
  if (typeof isError === 'boolean') {
    statusField(projection, isError ? 'error' : 'completed', payloadPath('isError'));
    if (isError) setStringField(projection, 'severity', 'error', payloadPath('isError'));
  }
  return projection;
}

function task(event: KimiServerEvent): AgentRowProjection {
  const info = objectAt(event.payload, 'info');
  const projection = make(event, 'task', 'system', stringAt(info, 'description'), payloadPath('info', 'description'));
  statusField(projection, stringAt(info, 'status'), payloadPath('info', 'status'));
  field(projection, 'taskDescription', stringAt(info, 'description'), payloadPath('info', 'description'));
  field(projection, 'taskCommand', stringAt(info, 'command'), payloadPath('info', 'command'));
  field(projection, 'taskId', stringAt(info, 'taskId'), payloadPath('info', 'taskId'));
  return projection;
}

function subagent(event: KimiServerEvent): AgentRowProjection {
  const detail = stringAt(event.payload, 'resultSummary') ?? stringAt(event.payload, 'description') ?? stringAt(event.payload, 'error');
  const projection = make(event, 'subagent', 'agent', detail, payloadPath(stringAt(event.payload, 'resultSummary') !== undefined ? 'resultSummary' : stringAt(event.payload, 'description') !== undefined ? 'description' : 'error'));
  identity(projection, 'subagentId', stringAt(event.payload, 'subagentId'), payloadPath('subagentId'));
  const status = event.type.slice('subagent.'.length);
  statusField(projection, status, typePath);
  if (status === 'failed') setStringField(projection, 'severity', 'error', typePath);
  return projection;
}

function compaction(event: KimiServerEvent): AgentRowProjection {
  const projection = make(event, 'checkpoint', 'system', stringAt(event.payload, 'result', 'summary') ?? stringAt(event.payload, 'instruction'), stringAt(event.payload, 'result', 'summary') !== undefined ? payloadPath('result', 'summary') : payloadPath('instruction'));
  statusField(projection, event.type.slice('compaction.'.length), typePath);
  for (const key of ['compactedCount', 'tokensBefore', 'tokensAfter']) field(projection, key, numberAt(event.payload, 'result', key), payloadPath('result', key));
  return projection;
}

function shell(event: KimiServerEvent): AgentRowProjection {
  const projection = make(event, 'task', 'tool', stringAt(event.payload, 'update', 'text'), payloadPath('update', 'text'));
  field(projection, 'commandId', stringAt(event.payload, 'commandId'), payloadPath('commandId'));
  if (event.type === 'shell.started') statusField(projection, 'running', typePath);
  const failed = own(event.payload, 'isError');
  if (typeof failed === 'boolean') statusField(projection, failed ? 'error' : 'completed', payloadPath('isError'));
  return projection;
}

function interaction(event: KimiServerEvent): AgentRowProjection {
  const questions = own(event.payload, 'questions');
  const question = Array.isArray(questions) ? stringAt(questions[0], 'question') : undefined;
  const detail = question ?? stringAt(event.payload, 'action') ?? stringAt(event.payload, 'feedback');
  const requested = event.type === 'event.question.requested' || event.type === 'event.approval.requested';
  const detailPath = question !== undefined ? indexedPath(['envelope', 'payload', 'questions'], 0, 'question')
    : stringAt(event.payload, 'action') !== undefined ? payloadPath('action') : payloadPath('feedback');
  const projection = make(event, 'approval', requested ? 'assistant' : 'user', detail, detailPath);
  statusField(projection, stringAt(event.payload, 'decision') ?? (requested ? 'requested' : event.type === 'event.question.dismissed' ? 'dismissed' : 'resolved'), stringAt(event.payload, 'decision') === undefined ? typePath : payloadPath('decision'));
  for (const key of ['question_id', 'approval_id', 'tool_name']) field(projection, key, stringAt(event.payload, key), payloadPath(key));
  identity(projection, 'toolCallId', stringAt(event.payload, 'tool_call_id'), payloadPath('tool_call_id'));
  const turnId = numberAt(event.payload, 'turn_id');
  if (turnId !== undefined && Number.isSafeInteger(turnId) && turnId >= 0) identity(projection, 'turnId', String(turnId), payloadPath('turn_id'));
  return projection;
}

function plan(event: KimiServerEvent): AgentRowProjection {
  const projection = make(event, 'checkpoint', 'system');
  for (const key of ['id', 'version', 'bytes']) field(projection, key, scalar(event.payload, key), payloadPath(key));
  return projection;
}

function taskNotice(event: KimiServerEvent): AgentRowProjection {
  const title = stringAt(event.payload, 'title');
  const projection = make(event, 'task', 'system', title ?? stringAt(event.payload, 'body'), payloadPath(title === undefined ? 'body' : 'title'));
  setStringField(projection, 'severity', stringAt(event.payload, 'severity')?.slice(0, 240), payloadPath('severity'));
  field(projection, 'notificationType', stringAt(event.payload, 'notificationType'), payloadPath('notificationType'));
  return projection;
}

function cron(event: KimiServerEvent): AgentRowProjection {
  const projection = make(event, 'task', 'system', stringAt(event.payload, 'prompt'), payloadPath('prompt'));
  field(projection, 'jobId', stringAt(event.payload, 'origin', 'jobId'), payloadPath('origin', 'jobId'));
  field(projection, 'origin', stringAt(event.payload, 'origin', 'kind'), payloadPath('origin', 'kind'));
  return projection;
}

const projectors = {
  'agent.status.updated': observer, 'agent.created': observer, 'agent.disposed': observer,
  'session.meta.updated': session, 'event.session.created': session, 'event.session.archived': session, 'event.session.deleted': session,
  'event.workspace.created': observer, 'event.workspace.updated': observer, 'event.workspace.deleted': observer,
  'event.session.work_changed': session, 'event.session.status_changed': session,
  'event.config.changed': observer, 'event.config.warning': configWarning, 'event.model_catalog.changed': observer,
  'event.plugin.changed': observer, 'event.capability.changed': observer, 'event.di.unit_changed': observer,
  'goal.updated': observer, 'skill.activated': observer, 'plugin_command.activated': observer,
  'error': error, 'warning': error, 'turn.started': turn, 'turn.ended': turn,
  'turn.step.started': turn, 'turn.step.completed': turn, 'turn.step.retrying': turn, 'turn.step.interrupted': turn,
  'assistant.delta': content, 'hook.result': content, 'thinking.delta': content,
  'tool.call.delta': tool, 'tool.call.started': tool, 'tool.progress': tool, 'tool.result': tool,
  'shell.output': shell, 'shell.started': shell, 'shell.completed': shell,
  'subagent.spawned': subagent, 'subagent.started': subagent, 'subagent.suspended': subagent, 'subagent.completed': subagent, 'subagent.failed': subagent, 'subagent.cancelled': subagent,
  'compaction.started': compaction, 'compaction.blocked': compaction, 'compaction.cancelled': compaction, 'compaction.completed': compaction,
  'task.started': task, 'task.terminated': task, 'background.task.started': task, 'background.task.terminated': task,
  'cron.fired': cron, 'prompt.submitted': prompt, 'prompt.completed': prompt, 'prompt.aborted': prompt, 'prompt.steered': prompt,
  'tool.list.updated': observer, 'mcp.server.status': observer, 'context.spliced': context,
  'prompt.queued': prompt, 'prompt.started': prompt, 'turn.steer': prompt,
  'task.notified': taskNotice, 'plan.revision': plan,
  'event.question.requested': interaction, 'event.question.dismissed': interaction, 'event.question.answered': interaction,
  'event.approval.requested': interaction, 'event.approval.resolved': interaction,
} satisfies Record<KimiServerEventType, Projector>;

function identity(projection: AgentRowProjection, fieldName: 'sessionId' | 'turnId' | 'messageId' | 'toolCallId' | 'subagentId', value: string | undefined, path: FieldPath): void {
  if (value !== undefined && value.length > 2048) field(projection, 'identityOmitted', true, path);
  else setStringField(projection, fieldName, value, path);
}
function field(projection: AgentRowProjection, name: string, value: string | number | boolean | undefined, path: FieldPath): void {
  setDerivedField(projection, name, typeof value === 'string' ? value.slice(0, 240) : value, path);
}
function statusField(projection: AgentRowProjection, value: string | undefined, path: FieldPath): void {
  setStringField(projection, 'status', value?.slice(0, 240), path);
}
function scalar(value: Record<string, unknown>, key: string): string | number | boolean | undefined {
  const item = own(value, key);
  return typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item)) ? item : undefined;
}
function usage(projection: AgentRowProjection, value: unknown, path: FieldPath): void {
  const tokens = kimiUsage(value);
  if (tokens) { projection.usage = tokens; projection.evidence.push(evidence('usage', path)); }
}


