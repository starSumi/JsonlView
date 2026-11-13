import { isObject, numberAt, objectAt, own, stringAt } from './utils';

// Kimi kap-server sessionEventJournal and events-zod; distinct from persisted wire.
export const KIMI_SERVER_SOURCE_REVISION = '4a82a07f08d0b135c4349c20aae53a2d51e5c3fa';
export const KIMI_SERVER_EVENT_TYPES = [
  'agent.status.updated', 'agent.created', 'agent.disposed', 'session.meta.updated',
  'event.session.created', 'event.session.archived', 'event.session.deleted',
  'event.workspace.created', 'event.workspace.updated', 'event.workspace.deleted',
  'event.session.work_changed', 'event.session.status_changed', 'event.config.changed',
  'event.config.warning', 'event.model_catalog.changed', 'event.plugin.changed',
  'event.capability.changed', 'event.di.unit_changed', 'goal.updated', 'skill.activated',
  'plugin_command.activated', 'error', 'warning', 'turn.started', 'turn.ended',
  'turn.step.started', 'turn.step.completed', 'turn.step.retrying', 'turn.step.interrupted',
  'assistant.delta', 'hook.result', 'thinking.delta', 'tool.call.delta', 'tool.call.started',
  'tool.progress', 'shell.output', 'shell.started', 'shell.completed', 'tool.result',
  'subagent.spawned', 'subagent.started', 'subagent.suspended', 'subagent.completed',
  'subagent.failed', 'subagent.cancelled', 'compaction.started', 'compaction.blocked',
  'compaction.cancelled', 'compaction.completed', 'task.started', 'task.terminated',
  'background.task.started', 'background.task.terminated', 'cron.fired',
  'prompt.submitted', 'prompt.completed', 'prompt.aborted', 'prompt.steered',
  'tool.list.updated', 'mcp.server.status',
  // Core context events are forwarded by sessionEventBroadcaster outside events-zod.
  'context.spliced', 'prompt.queued', 'prompt.started', 'turn.steer', 'task.notified',
  'plan.revision', 'event.question.requested', 'event.question.dismissed',
  'event.question.answered', 'event.approval.requested', 'event.approval.resolved',
] as const;
export type KimiServerEventType = (typeof KIMI_SERVER_EVENT_TYPES)[number];
const EVENT_TYPES: ReadonlySet<string> = new Set(KIMI_SERVER_EVENT_TYPES);

export interface KimiServerEvent {
  envelope: Record<string, unknown>;
  payload: Record<string, unknown>;
  type: string;
}

/** The persisted v1 header is not the agent-core wire protocol header. */
export function isKimiServerHeader(value: unknown): boolean {
  return stringAt(value, 'kind') === 'journal_header' && numberAt(value, 'version') === 1
    && stringAt(value, 'epoch') !== undefined && validSequence(numberAt(value, 'created_at'), 0);
}

/** Decode only the journal boundary; unknown event bodies remain available in Raw. */
export function decodeKimiServerEvent(value: unknown): KimiServerEvent | undefined {
  if (!isObject(value) || own(value, 'kind') !== 'event') return undefined;
  const journalSequence = numberAt(value, 'seq');
  if (!validSequence(journalSequence, 1)) return undefined;
  const envelope = objectAt(value, 'envelope');
  const payload = objectAt(envelope, 'payload');
  const type = stringAt(envelope, 'type');
  const envelopeSequence = numberAt(envelope, 'seq');
  if (!envelope || !payload || !type || !validSequence(envelopeSequence, 1)
    || envelopeSequence !== journalSequence
    || stringAt(envelope, 'timestamp') === undefined) return undefined;
  const payloadType = own(payload, 'type');
  if (payloadType !== undefined && payloadType !== type) return undefined;
  const epoch = own(envelope, 'epoch');
  if (epoch !== undefined && (typeof epoch !== 'string' || epoch.length === 0)) return undefined;
  if (own(envelope, 'session_id') !== undefined && typeof own(envelope, 'session_id') !== 'string') return undefined;
  if (own(envelope, 'volatile') !== undefined && typeof own(envelope, 'volatile') !== 'boolean') return undefined;
  const offset = own(envelope, 'offset');
  if (offset !== undefined && (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0)) return undefined;
  return { envelope, payload, type };
}

export function isKimiServerEventType(type: string): type is KimiServerEventType {
  return EVENT_TYPES.has(type);
}

/** Corroboration uses the emitted Event identity contract, not public type names alone. */
export function isKimiServerDetectionEvent(event: KimiServerEvent): boolean {
  if (!isKimiServerEventType(event.type) || stringAt(event.payload, 'agentId') === undefined
    || stringAt(event.payload, 'sessionId') === undefined) return false;
  if (event.type === 'error') return stringAt(event.payload, 'code') !== undefined
    && stringAt(event.payload, 'message') !== undefined && typeof own(event.payload, 'retryable') === 'boolean';
  if (event.type === 'warning') return stringAt(event.payload, 'message') !== undefined;
  return true;
}

/** Fixed schema content inspection; never follow media, tool arguments or arbitrary keys. */
export function kimiServerContentPreview(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 240);
  if (!Array.isArray(value)) return '';
  let preview = '';
  for (let index = 0; index < Math.min(value.length, 16) && preview.length < 240; index += 1) {
    const part = value[index];
    const type = stringAt(part, 'type');
    let text: string | undefined;
    switch (type) {
      case 'text': text = stringAt(part, 'text'); break;
      case 'thinking':
      case 'think':
        text = isObject(part) && (own(part, 'hidden') === true || own(part, 'encrypted') !== undefined || own(part, 'signature') !== undefined)
          ? '[hidden reasoning]' : stringAt(part, type === 'thinking' ? 'thinking' : 'think');
        break;
      case 'image':
      case 'video':
      case 'file': text = '[' + type + ' reference]'; break;
      case 'image_url':
      case 'audio_url':
      case 'video_url': text = '[' + type.slice(0, -4) + ' reference]'; break;
      case 'tool_use': text = '[tool ' + (stringAt(part, 'tool_name')?.slice(0, 64) ?? 'call') + ']'; break;
      case 'tool_result': {
        const output = isObject(part) ? own(part, 'output') : undefined;
        text = typeof output === 'string' ? output.slice(0, 240) : '[tool output]';
        break;
      }
      default: if (type) text = '[' + type.slice(0, 48) + ']';
    }
    if (text) preview += (preview ? ' ' : '') + text.slice(0, 240 - preview.length);
  }
  return preview.slice(0, 240);
}

function validSequence(value: number | undefined, minimum: number): boolean {
  return value !== undefined && Number.isSafeInteger(value) && value >= minimum;
}
