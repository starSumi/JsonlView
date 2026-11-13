import type { TrajectoryRecord } from '@shared/contracts/trajectory-slice';
import type { AgentRowProjection } from '@shared/types';
import { projectConversation } from './conversation-projection';
import type { AgentProfileRegistry } from './profile-registry';
import { isObject, objectAt, own, stringAt } from './utils';

export interface TrajectoryProjection extends Pick<TrajectoryRecord, 'actor' | 'hasError' | 'text'> { readonly textTruncated: boolean }

/** Additive projection: existing Profile eventKind/status are not boolean error evidence. */
export function projectTrajectory(registry: AgentProfileRegistry, profile: { id: string; version: string }, value: unknown,
  snapshotId: string): TrajectoryProjection {
  if (profile.id === 'generic' || registry.version(profile.id) !== profile.version) return unknown();
  const projection = registry.project(profile.id, { value }, { generation: snapshotId });
  if (projection.profileId !== profile.id) return unknown();
  const actor = projection.evidence.some((item) => item.field === 'actor')
    && (projection.actor === 'user' || projection.actor === 'assistant' || projection.actor === 'tool' || projection.actor === 'system')
    ? projection.actor : 'unknown';
  const conversation = projectConversation(value, projection);
  const text = conversation.parts.length === 0 ? null : conversation.parts.map((part) => part.text).join('\n');
  return { actor, hasError: explicitError(profile, value, projection), text, textTruncated: conversation.truncated };
}

function unknown(): TrajectoryProjection { return { actor: 'unknown', hasError: null, text: null, textTruncated: false }; }
function boolean(value: unknown): boolean | null { return typeof value === 'boolean' ? value : null; }
function explicitError(profile: { id: string; version: string }, value: unknown, projection: AgentRowProjection): boolean | null {
  if (!isObject(value)) return null;
  switch (`${profile.id}@${profile.version}`) {
    case 'claude-code-session@3': {
      const content = own(objectAt(value, 'message') ?? {}, 'content');
      const results = Array.isArray(content) ? content.filter((item) => isObject(item) && item.type === 'tool_result') : [];
      if (results.length === 0) return null;
      const errors = results.map((item) => boolean(isObject(item) ? own(item, 'is_error') : undefined));
      return errors.includes(true) ? true : errors.every((error) => error === false) ? false : null;
    }
    case 'pi-coding-agent@1': {
      const message = objectAt(value, 'message');
      return stringAt(message, 'role') === 'toolResult' ? boolean(own(message ?? {}, 'isError')) : null;
    }
    case 'kimi-code-session@5': {
      // Only paths the selected Profile actually interpreted as error/status evidence qualify.
      const errorEvidence = projection.evidence.filter((item) => item.field === 'status' || item.field === 'severity');
      const values = errorEvidence.filter((item) => item.path.tokens.at(-1)?.value === 'isError')
        .map((item) => boolean(atPath(value, item.path.tokens)));
      return values.includes(true) ? true : values.length > 0 && values.every((error) => error === false) ? false : null;
    }
    case 'generic-agent-events@1':
      return boolean(projection.derivedFields?.toolError);
    case 'codex-exec-jsonl@1': {
      if ((value.type === 'error' && typeof value.message === 'string')
        || (value.type === 'turn.failed' && typeof objectAt(value, 'error')?.message === 'string')) return true;
      const item = objectAt(value, 'item');
      if (value.type !== 'item.completed' || item?.type !== 'command_execution'
        || (item.status !== 'completed' && item.status !== 'failed') || !Number.isSafeInteger(item.exit_code)) return null;
      return item.exit_code !== 0;
    }
    case 'codex-rollout@1': {
      const payload = objectAt(value, 'payload');
      if (value.type === 'event_msg' && payload?.type === 'error') return true;
      return null; // warning, turn_aborted, completed and missing error are not success/failure evidence.
    }
    default: return null;
  }
}
function atPath(value: unknown, tokens: readonly { kind: string; value: string | number }[]): unknown {
  let current = value;
  for (const token of tokens) {
    if (token.kind === 'key' && isObject(current) && typeof token.value === 'string') current = own(current, token.value);
    else if (token.kind === 'index' && Array.isArray(current) && typeof token.value === 'number') current = current[token.value];
    else return undefined;
  }
  return current;
}
