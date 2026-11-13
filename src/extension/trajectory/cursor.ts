import { createHash } from 'node:crypto';
import type { TrajectoryPredicate } from '@shared/contracts/trajectory-slice';

export const TRAJECTORY_CURSOR_TTL_MS = 300_000;
export interface TrajectoryCursor {
  readonly v: 1;
  readonly sourceId: string;
  readonly snapshotId: string;
  readonly queryHash: string;
  readonly nextOrdinal: string;
  readonly expiresAtMs: number;
}

/** RFC 8785 for the bounded JSON values used by identity and cursor v1. */
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 8) throw new Error('Canonical JSON depth exceeded.');
  if (value === null) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value === 'string') {
    if (!wellFormed(value)) throw new Error('Invalid canonical JSON Unicode.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.length > 512) throw new Error('Canonical JSON array exceeded.');
    return `[${value.map((item) => canonicalJson(item, depth + 1)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    const keys = Object.keys(value).sort();
    if (keys.length > 128) throw new Error('Canonical JSON object exceeded.');
    return `{${keys.map((key) => `${canonicalJson(key, depth + 1)}:${canonicalJson((value as Record<string, unknown>)[key], depth + 1)}`).join(',')}}`;
  }
  throw new Error('Unsupported canonical JSON value.');
}

export function trajectoryQueryHash(predicate: TrajectoryPredicate, profileId: string, profileVersion: string): string {
  return createHash('sha256').update(canonicalJson({ predicate, profileId, profileVersion }), 'utf8').digest('hex');
}

export function createTrajectoryCursor(value: Omit<TrajectoryCursor, 'v'>): string {
  const payload: TrajectoryCursor = { v: 1, ...value };
  if (!validPayload(payload)) throw new Error('Invalid trajectory cursor.');
  const cursor = Buffer.from(canonicalJson(payload), 'utf8').toString('base64url');
  if (cursor.length > 4096) throw new Error('Trajectory cursor exceeded.');
  return cursor;
}

/** Canonical round trip rejects duplicate keys, alternate numbers and base64 aliases. */
export function parseTrajectoryCursor(value: string): TrajectoryCursor | undefined {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,4096}$/u.test(value)) return undefined;
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) return undefined;
    const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const payload: unknown = JSON.parse(json);
    return validPayload(payload) && canonicalJson(payload) === json ? payload : undefined;
  } catch { return undefined; }
}

function validPayload(value: unknown): value is TrajectoryCursor {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).length === 6 && ['v', 'sourceId', 'snapshotId', 'queryHash', 'nextOrdinal', 'expiresAtMs'].every((key) => Object.hasOwn(v, key))
    && v.v === 1 && text(v.sourceId, 256) && text(v.snapshotId, 256)
    && typeof v.queryHash === 'string' && /^[a-f0-9]{64}$/u.test(v.queryHash)
    && typeof v.nextOrdinal === 'string' && /^(0|[1-9][0-9]{0,19})$/u.test(v.nextOrdinal)
    && typeof v.expiresAtMs === 'number' && Number.isSafeInteger(v.expiresAtMs) && v.expiresAtMs >= 0;
}
function text(value: unknown, max: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max && wellFormed(value); }
function wellFormed(value: string): boolean { return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value); }
