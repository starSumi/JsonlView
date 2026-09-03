import type {
  AgentEventKind,
  AgentEvidence,
  AgentRowProjection,
  FieldPath,
} from '../shared/types';

const MAX_SUMMARY_LENGTH = 240;
const MAX_DETECTION_REASONS = 8;

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function own(object: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined;
}

export function stringAt(value: unknown, ...keys: string[]): string | undefined {
  let current = value;
  for (const key of keys) {
    if (!isObject(current)) {
      return undefined;
    }
    current = own(current, key);
  }
  return typeof current === 'string' && current.length > 0 ? current : undefined;
}

export function numberAt(value: unknown, ...keys: string[]): number | undefined {
  let current = value;
  for (const key of keys) {
    if (!isObject(current)) {
      return undefined;
    }
    current = own(current, key);
  }
  return typeof current === 'number' && Number.isFinite(current) ? current : undefined;
}

export function objectAt(value: unknown, ...keys: string[]): Record<string, unknown> | undefined {
  let current = value;
  for (const key of keys) {
    if (!isObject(current)) {
      return undefined;
    }
    current = own(current, key);
  }
  return isObject(current) ? current : undefined;
}

export function arrayAt(value: unknown, ...keys: string[]): unknown[] | undefined {
  let current = value;
  for (const key of keys) {
    if (!isObject(current)) {
      return undefined;
    }
    current = own(current, key);
  }
  return Array.isArray(current) ? current : undefined;
}

export function keyPath(...keys: string[]): FieldPath {
  return { tokens: keys.map((value) => ({ kind: 'key' as const, value })) };
}

export function indexedPath(keys: string[], index: number, ...tail: string[]): FieldPath {
  return {
    tokens: [
      ...keys.map((value) => ({ kind: 'key' as const, value })),
      { kind: 'index' as const, value: index },
      ...tail.map((value) => ({ kind: 'key' as const, value })),
    ],
  };
}

export function evidence(field: string, path: FieldPath): AgentEvidence {
  return { field, path };
}

export function boundedSummary(value: unknown, prefix?: string): string {
  const rendered = renderSummaryValue(value);
  const combined = prefix && rendered ? `${prefix}: ${rendered}` : (prefix ?? rendered ?? 'Record');
  const normalized = combined.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (normalized.length <= MAX_SUMMARY_LENGTH) {
    return normalized || 'Record';
  }
  return `${normalized.slice(0, MAX_SUMMARY_LENGTH - 3)}...`;
}

function renderSummaryValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return String(value);
  }
  if (Array.isArray(value)) {
    const text = extractText(value);
    return text ?? `[${value.length} items]`;
  }
  if (isObject(value)) {
    for (const key of ['message', 'text', 'content', 'summary', 'description', 'name', 'type']) {
      const candidate = own(value, key);
      const rendered = renderSummaryValue(candidate);
      if (rendered) {
        return rendered;
      }
    }
    const keys: string[] = [];
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      keys.push(key);
      if (keys.length >= 5) break;
    }
    return keys.length > 0 ? `{${keys.join(', ')}}` : '{}';
  }
  return undefined;
}

export function extractText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const item of value.slice(0, 16)) {
    if (typeof item === 'string') {
      parts.push(item);
    } else if (isObject(item)) {
      const text = stringAt(item, 'text') ?? stringAt(item, 'content');
      if (text) {
        parts.push(text);
      }
    }
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}

export function addEvidenceOnce(target: AgentEvidence[], item: AgentEvidence): void {
  const encoded = JSON.stringify(item.path.tokens);
  if (!target.some((existing) => existing.field === item.field && JSON.stringify(existing.path.tokens) === encoded)) {
    target.push(item);
  }
}

export function pushReason(
  target: { path: FieldPath; observation: string }[],
  path: FieldPath,
  observation: string,
): void {
  if (target.length >= MAX_DETECTION_REASONS) {
    return;
  }
  const encoded = JSON.stringify(path.tokens);
  if (!target.some((reason) => reason.observation === observation && JSON.stringify(reason.path.tokens) === encoded)) {
    target.push({ path, observation });
  }
}

export function createProjection(
  profileId: string,
  eventKind: AgentEventKind,
  summary: string,
  eventPath?: FieldPath,
  summaryPath?: FieldPath,
): AgentRowProjection {
  const projection: AgentRowProjection = {
    profileId,
    eventKind,
    summary: boundedSummary(summary),
    evidence: [],
    confidence: eventPath ? 'source' : 'inferred',
  };
  if (eventPath) {
    projection.evidence.push(evidence('eventKind', eventPath));
  }
  if (summaryPath ?? eventPath) {
    projection.evidence.push(evidence('summary', summaryPath ?? eventPath!));
  }
  return projection;
}

export function setStringField<K extends keyof AgentRowProjection>(
  projection: AgentRowProjection,
  field: K,
  value: string | undefined,
  path: FieldPath,
): void {
  if (value === undefined) {
    return;
  }
  (projection as unknown as Record<string, unknown>)[field] = value;
  addEvidenceOnce(projection.evidence, evidence(String(field), path));
}

export function setDerivedField(
  projection: AgentRowProjection,
  field: string,
  value: string | number | boolean | undefined,
  path: FieldPath,
): void {
  if (value === undefined) {
    return;
  }
  projection.derivedFields ??= {};
  projection.derivedFields[field] = typeof value === 'string' ? boundedSummary(value) : value;
  addEvidenceOnce(projection.evidence, evidence(field, path));
}

export function setActor(
  projection: AgentRowProjection,
  actor: AgentRowProjection['actor'] | undefined,
  path: FieldPath,
): void {
  if (actor === undefined) {
    return;
  }
  projection.actor = actor;
  addEvidenceOnce(projection.evidence, evidence('actor', path));
}

export function actorFromRole(role: string | undefined): AgentRowProjection['actor'] | undefined {
  switch (role?.toLowerCase()) {
    case 'user':
    case 'assistant':
    case 'tool':
    case 'system':
    case 'developer':
    case 'agent':
      return role.toLowerCase() as NonNullable<AgentRowProjection['actor']>;
    default:
      return role ? 'unknown' : undefined;
  }
}

export function usageFromObject(value: unknown): AgentRowProjection['usage'] | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const input = firstNumber(value, ['input', 'input_tokens', 'inputTokens']);
  const output = firstNumber(value, ['output', 'output_tokens', 'outputTokens']);
  const cached = firstNumber(value, ['cached', 'cached_tokens', 'cache_read_input_tokens']);
  const total = firstNumber(value, ['total', 'total_tokens', 'totalTokens']);
  if (input === undefined && output === undefined && cached === undefined && total === undefined) {
    return undefined;
  }
  const usage: NonNullable<AgentRowProjection['usage']> = {};
  if (input !== undefined) usage.input = input;
  if (output !== undefined) usage.output = output;
  if (cached !== undefined) usage.cached = cached;
  if (total !== undefined) usage.total = total;
  return usage;
}

function firstNumber(object: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = own(object, key);
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}
