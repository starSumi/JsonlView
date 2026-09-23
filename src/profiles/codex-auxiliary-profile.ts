import type { AgentRowProjection } from '../shared/types';
import type { AgentProfile, DetectionResult, GenericRecordSample, HydratedRecord, ProjectionContext } from './profile-contract';
import { sourceSurfaceEvidence } from './shape-discovery';
import {
  boundedSummary,
  createProjection,
  isObject,
  keyPath,
  own,
  pushReason,
  setActor,
  setDerivedField,
  setStringField,
} from './utils';

/**
 * Codex keeps several append-only JSONL surfaces beside rollout transcripts.
 * They share the physical JSONL contract but have different record semantics.
 */
export class CodexHistoryProfile implements AgentProfile {
  public readonly id = 'codex-history';
  public readonly displayName = 'Codex Message History';
  public readonly version = '1';

  public detect(sample: readonly GenericRecordSample[]): DetectionResult {
    const hasStrongPath = hasUniformStrongSurface(sample, 'codex-history');
    const strongPathEvidence = hasStrongPath ? sample.length : 0;
    const valid = sample.filter((entry) => isHistoryDetectionEntry(entry.value, hasStrongPath)).length;
    const coverage = valid / Math.max(1, sample.length);
    // The three names are deliberately common. Without a producer locator we
    // require four consistent records; a path hint can lower that quorum but
    // never bypasses validation of the actual values.
    const requiredEvidenceMet = meetsSurfaceEvidence(valid, coverage, hasStrongPath);
    const reasons: DetectionResult['reasons'] = [];
    if (valid > 0) pushReason(reasons, keyPath('text'), 'Codex message-history record shape: session_id, ts, text');
    if (strongPathEvidence > 0) pushReason(reasons, keyPath('session_id'), 'Codex .codex/history.jsonl source hint (content still required)');
    return {
      profileId: this.id,
      profileVersion: this.version,
      score: surfaceScore(valid, coverage, hasStrongPath),
      reasons,
      requiredEvidenceMet,
      sampledRecords: sample.length,
    };
  }

  public project(record: HydratedRecord, _context: ProjectionContext): AgentRowProjection {
    if (!isObject(record.value) || !isHistoryEntry(record.value)) {
      return createProjection(this.id, 'other', boundedSummary(record.value, 'Unknown Codex history record'), keyPath(), keyPath());
    }
    const value = record.value;
    const text = own(value, 'text') as string;
    const sessionId = own(value, 'session_id') as string;
    const timestamp = historyTimestamp(own(value, 'ts'));
    const projection = createProjection(this.id, 'message', boundedSummary(text), keyPath('session_id'), keyPath('text'));
    setActor(projection, 'user', keyPath('text'));
    setStringField(projection, 'sessionId', sessionId, keyPath('session_id'));
    if (timestamp !== undefined) setStringField(projection, 'timestamp', timestamp, keyPath('ts'));
    else setDerivedField(projection, 'timestampRaw', String(own(value, 'ts')), keyPath('ts'));
    setDerivedField(projection, 'sourceKind', 'history', keyPath('session_id'));
    return projection;
  }
}

export class CodexSessionIndexProfile implements AgentProfile {
  public readonly id = 'codex-session-index';
  public readonly displayName = 'Codex Session Index';
  public readonly version = '1';

  public detect(sample: readonly GenericRecordSample[]): DetectionResult {
    const hasStrongPath = hasUniformStrongSurface(sample, 'codex-session-index');
    const strongPathEvidence = hasStrongPath ? sample.length : 0;
    const valid = sample.filter((entry) => isSessionIndexDetectionEntry(entry.value, hasStrongPath)).length;
    const coverage = valid / Math.max(1, sample.length);
    const requiredEvidenceMet = meetsSurfaceEvidence(valid, coverage, hasStrongPath);
    const reasons: DetectionResult['reasons'] = [];
    if (valid > 0) pushReason(reasons, keyPath('thread_name'), 'Codex session-index record shape: id, thread_name, updated_at');
    if (strongPathEvidence > 0) pushReason(reasons, keyPath('id'), 'Codex .codex/session_index.jsonl source hint (content still required)');
    return {
      profileId: this.id,
      profileVersion: this.version,
      score: surfaceScore(valid, coverage, hasStrongPath),
      reasons,
      requiredEvidenceMet,
      sampledRecords: sample.length,
    };
  }

  public project(record: HydratedRecord, _context: ProjectionContext): AgentRowProjection {
    if (!isObject(record.value) || !isSessionIndexEntry(record.value)) {
      return createProjection(this.id, 'other', boundedSummary(record.value, 'Unknown Codex index record'), keyPath(), keyPath());
    }
    const value = record.value;
    const id = own(value, 'id') as string;
    const threadName = own(value, 'thread_name') as string;
    const updatedAt = own(value, 'updated_at') as string;
    const projection = createProjection(this.id, 'session', boundedSummary(threadName), keyPath('id'), keyPath('thread_name'));
    setActor(projection, 'system', keyPath('thread_name'));
    setStringField(projection, 'sessionId', id, keyPath('id'));
    if (isRfc3339Timestamp(updatedAt)) {
      setStringField(projection, 'timestamp', updatedAt, keyPath('updated_at'));
    } else {
      // The producer uses a literal `unknown` when it cannot recover the
      // update time. Preserve that fact instead of exposing it as a timestamp.
      setDerivedField(projection, 'timestampRaw', updatedAt, keyPath('updated_at'));
    }
    setDerivedField(projection, 'threadName', threadName, keyPath('thread_name'));
    setDerivedField(projection, 'sourceKind', 'session-index', keyPath('id'));
    return projection;
  }
}

export function isHistoryEntry(value: unknown): value is Record<string, unknown> & {
  session_id: string;
  ts: number;
  text: string;
} {
  if (!isObject(value)) return false;
  const sessionId = own(value, 'session_id');
  const timestamp = own(value, 'ts');
  const text = own(value, 'text');
  return typeof sessionId === 'string'
    && sessionId.length > 0
    && typeof timestamp === 'number'
    && isUnixSeconds(timestamp)
    && typeof text === 'string';
}

export function isSessionIndexEntry(value: unknown): value is Record<string, unknown> & {
  id: string;
  thread_name: string;
  updated_at: string;
} {
  if (!isObject(value)) return false;
  const id = own(value, 'id');
  const name = own(value, 'thread_name');
  const updatedAt = own(value, 'updated_at');
  return typeof id === 'string'
    && id.length > 0
    && typeof name === 'string'
    && typeof updatedAt === 'string'
    && (updatedAt === 'unknown' || isRfc3339Timestamp(updatedAt));
}

/** Unix seconds are intentionally distinguished from millisecond timestamps. */
export function isUnixSeconds(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0;
}

/** Codex emits RFC3339 strings; locale-dependent Date.parse forms are rejected. */
export function isRfc3339Timestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offset = match[7] === 'Z' ? undefined : Number(match[7]!.slice(1, 3));
  const offsetMinute = match[7] === 'Z' ? undefined : Number(match[7]!.slice(4, 6));
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (offset !== undefined && (offset > 23 || offsetMinute! > 59)) return false;
  return !Number.isNaN(Date.parse(value));
}

function historyTimestamp(value: unknown): string | undefined {
  if (!isUnixSeconds(value)) return undefined;
  const milliseconds = value * 1_000;
  if (!Number.isSafeInteger(milliseconds) || milliseconds > 8_640_000_000_000_000) return undefined;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function isStrongSurface(path: string | undefined, kind: 'codex-history' | 'codex-session-index'): boolean {
  const evidence = sourceSurfaceEvidence(path);
  return evidence?.kind === kind && evidence.strength === 'strong';
}

function isHistoryDetectionEntry(value: unknown, hasStrongPath: boolean): boolean {
  return isHistoryEntry(value)
    && (hasStrongPath || isCanonicalUuid(own(value, 'session_id')));
}

function isSessionIndexDetectionEntry(value: unknown, hasStrongPath: boolean): boolean {
  if (!isObject(value)) return false;
  const updatedAt = own(value, 'updated_at');
  return isSessionIndexEntry(value)
    && (isRfc3339Timestamp(updatedAt) || hasStrongPath && updatedAt === 'unknown')
    && (hasStrongPath || isCanonicalUuid(own(value, 'id')));
}

function isCanonicalUuid(value: unknown): value is string {
  // Current ThreadId values are UUID-shaped. Keep this as a corroborating
  // signal, not a parser contract: a trusted .codex path still accepts a
  // future identifier encoding after validating the required fields.
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function hasUniformStrongSurface(
  sample: readonly GenericRecordSample[],
  kind: 'codex-history' | 'codex-session-index',
): boolean {
  return sample.length > 0 && sample.every((entry) => isStrongSurface(entry.sourcePathHint, kind));
}

function meetsSurfaceEvidence(valid: number, coverage: number, hasStrongPath: boolean): boolean {
  if (hasStrongPath) return valid >= 1 && coverage >= 0.9;
  return valid >= 4 && coverage >= 0.9;
}

function surfaceScore(valid: number, coverage: number, hasStrongPath: boolean): number {
  const quorum = Math.min(1, valid / 4);
  // Keep weak/copy-renamed files below the automatic threshold until a
  // genuinely consistent corpus corroborates the source-derived shape.
  return Math.min(0.98, 0.45 * coverage + 0.25 * quorum + (hasStrongPath ? 0.3 : 0));
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
