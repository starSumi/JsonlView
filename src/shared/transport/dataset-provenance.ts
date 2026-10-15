import type { DatasetRuntimeProvenanceV1 } from '../types';

const SHAPES = new Set(['sft', 'preference', 'tool-use', 'multimodal', 'unknown']);
const STOPS = new Set(['record_limit', 'byte_limit', 'time_limit', 'hydration_limit', 'uninspectable_record']);
const FALLBACKS = new Set(['unknown_shape', 'conflicting_shapes', 'invalid_sample', 'sample_unavailable', 'inspection_failed']);
const STAGES = new Set(['not-started', 'head-hydration', 'head-inspection', 'profile-sampling', 'profile-classification']);
const TERMINALS = {
  failed: { code: 'detection_failed', retryable: true, action: 'reload' },
  timeout: { code: 'deadline_exceeded', retryable: true, action: 'reload' },
  cancelled: { code: 'operation_cancelled', retryable: false, action: 'none' },
  disabled: { code: 'auto_detection_disabled', retryable: false, action: 'enable-auto-detection' },
} as const;

/** Deliberately closed: metadata must never grow a raw/value/source payload by accident. */
export function isDatasetRuntimeProvenance(value: unknown): value is DatasetRuntimeProvenanceV1 {
  if (!object(value) || value.version !== 1 || !object(value.samplePlan)
    || !keys(value.samplePlan, ['strategy', 'maxRecords', 'maxBytes'])
    || value.samplePlan.strategy !== 'head' || value.samplePlan.maxRecords !== 32 || value.samplePlan.maxBytes !== 262144) return false;
  if (value.status === 'pending') return keys(value, ['version', 'status', 'samplePlan']);
  if (typeof value.status === 'string' && Object.hasOwn(TERMINALS, value.status)) {
    const expected = TERMINALS[value.status as keyof typeof TERMINALS];
    return keys(value, ['version', 'status', 'samplePlan', 'terminal'])
      && object(value.terminal) && keys(value.terminal, ['stage', 'code', 'retryable', 'action'])
      && typeof value.terminal.stage === 'string' && STAGES.has(value.terminal.stage)
      && (value.status !== 'disabled' || value.terminal.stage === 'not-started')
      && value.terminal.code === expected.code && value.terminal.retryable === expected.retryable
      && value.terminal.action === expected.action;
  }
  if (!keys(value, ['version', 'status', 'samplePlan', 'framing', 'adapterId', 'adapterVersion', 'shape', 'confidence', 'clockBasis', 'coverage', 'fallback'])
    || value.framing !== 'jsonl' || value.adapterVersion !== '1.0.0'
    || typeof value.shape !== 'string' || !SHAPES.has(value.shape)
    || !object(value.coverage)) return false;
  const coverage = value.coverage;
  if (!keys(coverage, ['sampledRecords', 'validRecords', 'invalidRecords', 'examinedBytes', 'partial', 'stoppedBy'])
    || !count(coverage.sampledRecords) || !count(coverage.validRecords) || !count(coverage.invalidRecords)
    || coverage.validRecords + coverage.invalidRecords !== coverage.sampledRecords
    || typeof coverage.examinedBytes !== 'string' || !/^(0|[1-9]\d{0,5})$/.test(coverage.examinedBytes)
    || BigInt(coverage.examinedBytes) > 262144n
    || typeof coverage.partial !== 'boolean'
    || (coverage.stoppedBy !== undefined && (typeof coverage.stoppedBy !== 'string' || !STOPS.has(coverage.stoppedBy) || !coverage.partial))) return false;
  if (value.status === 'fallback') {
    if (value.adapterId !== 'generic-jsonl' || value.shape !== 'unknown' || value.confidence !== 'none'
      || value.clockBasis !== 'none' || !object(value.fallback)
      || !keys(value.fallback, ['code', 'candidateShapes'])
      || typeof value.fallback.code !== 'string' || !FALLBACKS.has(value.fallback.code)
      || !Array.isArray(value.fallback.candidateShapes) || value.fallback.candidateShapes.length > SHAPES.size) return false;
    return value.fallback.candidateShapes.every((shape) => typeof shape === 'string' && SHAPES.has(shape))
      && new Set(value.fallback.candidateShapes).size === value.fallback.candidateShapes.length;
  }
  return (value.status === 'ready' || value.status === 'partial')
    && value.fallback === undefined && value.adapterId === 'llamafactory-v1'
    && value.shape !== 'unknown' && value.clockBasis === 'record-order'
    && coverage.sampledRecords > 0 && coverage.invalidRecords === 0
    && coverage.partial === (value.status === 'partial')
    && value.confidence === (value.status === 'partial' ? 'medium' : 'high');
}

function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0 && value <= 32;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
