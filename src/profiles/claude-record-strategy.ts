import { isObject, own, stringAt } from './utils';

/**
 * These are the record kinds currently observed in Claude's JSONL surfaces.
 * The sets are intentionally kept local to the adapter; they are not a
 * promise that Claude's on-disk schema is stable or public.
 */
export const CLAUDE_TRANSCRIPT_TYPES: ReadonlySet<string> = new Set([
  'user',
  'assistant',
  'system',
  'summary',
  'progress',
  'file-history-snapshot',
  'file-history-delta',
  'mode',
  'permission-mode',
  'last-prompt',
  'attachment',
  'queue-operation',
  'atis-latch',
  'ai-title',
]);

export const CLAUDE_CONTROL_TYPES: ReadonlySet<string> = new Set([
  'mode',
  'permission-mode',
  'last-prompt',
  'attachment',
  'queue-operation',
  'atis-latch',
  'ai-title',
  'file-history-snapshot',
  'file-history-delta',
]);

const CLAUDE_JOB_STATES: ReadonlySet<string> = new Set([
  'observed',
  'working',
  'needs_input',
  'idle',
  'completed',
  'done',
  'failed',
  'stopped',
  'blocked',
]);

export type ClaudeRecordStrategy = 'job-timeline' | 'history' | 'transcript' | 'unknown';

/**
 * Claude job timelines are a separate, compact lifecycle surface. Requiring
 * all four fields keeps an arbitrary application record with a `text` field
 * from being promoted to an agent message.
 */
export function isClaudeJobTimelineRecord(value: unknown): value is Record<string, unknown> {
  if (!isObject(value)) return false;
  const at = stringAt(value, 'at');
  const state = stringAt(value, 'state');
  const detail = own(value, 'detail');
  const text = own(value, 'text');
  return isIsoTimestamp(at)
    && isClaudeJobTimelineState(state)
    && typeof detail === 'string'
    && typeof text === 'string';
}

/**
 * A content-only timeline shape is deliberately not enough for automatic
 * profile selection: it is common in ordinary workflow logs. The path hint
 * is supplied by the extension host and is used only as an additional,
 * ephemeral discriminator.
 */
export function isClaudeJobTimelinePathHint(path: string | undefined): boolean {
  if (!path) return false;
  return /(?:^|\/)\.claude\/jobs\/[^/]+\/timeline\.jsonl$/i.test(path.replaceAll('\\', '/'));
}

export function isClaudeJobTimelineState(value: unknown): boolean {
  return typeof value === 'string' && CLAUDE_JOB_STATES.has(value.toLowerCase());
}

/** Transcript/control records need a session and a record identity together. */
export function hasClaudeIdentityEnvelope(value: unknown): value is Record<string, unknown> {
  if (!isObject(value)) return false;
  const sessionId = stringAt(value, 'sessionId');
  const recordId = stringAt(value, 'uuid') ?? stringAt(value, 'leafUuid');
  return Boolean(sessionId && recordId);
}

/**
 * `history.jsonl` is a command/prompt index rather than a transcript. Its
 * numeric millisecond timestamp and project/session identity are required so
 * ordinary records with a `display` field do not match accidentally.
 */
export function isClaudeHistoryRecord(value: unknown): value is Record<string, unknown> {
  if (!isObject(value)) return false;
  const timestamp = own(value, 'timestamp');
  return typeof own(value, 'display') === 'string'
    && typeof timestamp === 'number'
    && Number.isSafeInteger(timestamp)
    && typeof stringAt(value, 'project') === 'string'
    && typeof stringAt(value, 'sessionId') === 'string'
    && isObject(own(value, 'pastedContents'));
}

export function classifyClaudeRecord(value: unknown): ClaudeRecordStrategy {
  if (isClaudeJobTimelineRecord(value)) return 'job-timeline';
  if (isClaudeHistoryRecord(value)) return 'history';
  if (isObject(value) && CLAUDE_TRANSCRIPT_TYPES.has(stringAt(value, 'type') ?? '')) return 'transcript';
  return 'unknown';
}

export function claudeHistoryTimestamp(value: Record<string, unknown>): string | undefined {
  const timestamp = own(value, 'timestamp');
  if (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp)) return undefined;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function isIsoTimestamp(value: string | undefined): value is string {
  return value !== undefined
    && /^\d{4}-\d{2}-\d{2}T/.test(value)
    && Number.isFinite(Date.parse(value));
}
