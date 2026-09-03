import type { AgentRowProjection, JsonScalar, RowProjection } from '../shared/types';
import type { CommonDimension, FieldSelector, SelectedValue } from './types';

const UNKNOWN_LITERALS = new Set(['unknown', '<unknown>', '(unknown)']);

export function selectValue(row: RowProjection, selector: FieldSelector): SelectedValue {
  switch (selector.kind) {
    case 'cell': {
      const cell = row.cells.find((candidate) => candidate.columnId === selector.columnId);
      if (!cell) return { state: 'missing' };
      if (cell.value !== undefined) return classifyScalar(cell.value);
      return cell.preview !== undefined || cell.truncated === true ? { state: 'unknown' } : { state: 'missing' };
    }
    case 'common':
      return selectCommon(row.profile, selector.dimension);
    case 'profile':
      return selectProfileField(row.profile, selector.field);
    case 'derived':
      return classifyUnknown(row.profile?.derivedFields?.[selector.field]);
  }
}

function selectCommon(profile: AgentRowProjection | undefined, dimension: CommonDimension): SelectedValue {
  if (!profile) return { state: 'missing' };
  switch (dimension) {
    case 'severity': return classifyUnknown(profile.severity);
    case 'eventKind': return profile.eventKind === 'other' ? { state: 'unknown' } : classifyScalar(profile.eventKind);
    case 'service': return classifyUnknown(profile.derivedFields?.service);
    case 'status': return classifyUnknown(profile.status);
  }
}

function selectProfileField(profile: AgentRowProjection | undefined, field: string): SelectedValue {
  if (!profile) return { state: 'missing' };
  const value = (profile as AgentRowProjection & Record<string, unknown>)[field];
  return classifyUnknown(value);
}

function classifyUnknown(value: unknown): SelectedValue {
  if (value === undefined || value === null) return { state: 'missing' };
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return { state: 'unknown' };
  return classifyScalar(value);
}

function classifyScalar(value: JsonScalar): SelectedValue {
  if (value === null) return { state: 'missing' };
  if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
    return { state: 'unknown' };
  }
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (normalized.length === 0 || UNKNOWN_LITERALS.has(normalized.toLowerCase())) return { state: 'unknown' };
  }
  return { state: 'value', value };
}
