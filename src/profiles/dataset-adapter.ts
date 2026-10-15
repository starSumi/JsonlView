import type { FieldPath, ParseState } from '../shared/types';
import { isObject, own } from './utils';

export const LLAMA_FACTORY_V1_ADAPTER_ID = 'llamafactory-v1';
export const LLAMA_FACTORY_V1_ADAPTER_VERSION = '1.0.0';
export const GENERIC_DATASET_ADAPTER_ID = 'generic-jsonl';
export const GENERIC_DATASET_ADAPTER_VERSION = '1.0.0';

const DEFAULT_SAMPLE_PLAN: DatasetSamplePlan = {
  maxRecords: 32,
  maxBytes: 256 * 1024,
  strategy: 'head',
};
const MAX_REASONS = 8;
const MAX_MESSAGES_PER_RECORD = 64;
const MAX_BLOCKS_PER_MESSAGE = 32;

export type DatasetShape = 'sft' | 'preference' | 'tool-use' | 'multimodal' | 'unknown';
export type DatasetFraming = 'jsonl';
export type DatasetClockBasis = 'none' | 'record-order';
export type DatasetConfidence = 'high' | 'medium' | 'none';
export type DatasetTruncationReason = 'record_limit' | 'byte_limit';

export interface DatasetSamplePlan {
  maxRecords: number;
  maxBytes: number;
  strategy: 'head';
}

export interface DatasetRecordSample {
  value: unknown;
  ordinal?: string;
  parseState?: ParseState;
  /** Optional encoded record size supplied by the physical scanner. */
  byteLength?: number;
}

export interface DatasetSourceIdentity {
  fingerprint?: string;
  generation?: string;
}

export interface DatasetInspectionOptions {
  samplePlan?: Partial<DatasetSamplePlan>;
  source?: DatasetSourceIdentity;
}

export interface DatasetDetectionReason {
  path: FieldPath;
  code: 'shape_evidence' | 'missing_required_field' | 'conflict' | 'unknown';
  observation: string;
}

export interface DatasetCandidate {
  shape: DatasetShape;
  matchedRecords: number;
  score: number;
  reasons: readonly DatasetDetectionReason[];
}

export type DatasetFallbackCode =
  | 'unknown_shape'
  | 'conflicting_shapes'
  | 'invalid_sample'
  | 'unsupported_framing';

export interface DatasetFallbackDiagnostic {
  visible: true;
  code: DatasetFallbackCode;
  message: string;
  fallbackAdapterId: typeof GENERIC_DATASET_ADAPTER_ID;
  candidateShapes: readonly DatasetShape[];
}

export interface DatasetSampleCoverage {
  requestedRecords: number;
  sampledRecords: number;
  validRecords: number;
  invalidRecords: number;
  examinedBytes: string;
  truncated: boolean;
  truncatedReason?: DatasetTruncationReason;
}

export interface DatasetProvenance {
  framing: DatasetFraming;
  adapterId: string;
  adapterVersion: string;
  samplePlan: DatasetSamplePlan;
  coverage: DatasetSampleCoverage;
  confidence: DatasetConfidence;
  clockBasis: DatasetClockBasis;
  reasons: readonly DatasetDetectionReason[];
  fallback?: DatasetFallbackDiagnostic;
  sourceFingerprint?: string;
  generation?: string;
}

export interface DatasetFieldProjection {
  field: string;
  path: FieldPath;
  count: number;
}

export interface DatasetRecordProjection {
  /** The projection never creates child rows; this is the source physical row. */
  physicalOrdinal: string;
  shape: DatasetShape;
  fields: readonly DatasetFieldProjection[];
  /** The generic/raw value remains available to the caller for detail rendering. */
  raw: unknown;
  rawPreserved: true;
}

export interface DatasetDetection {
  selectedAdapterId: string;
  selectedAdapterVersion: string;
  shape: DatasetShape;
  confidence: DatasetConfidence;
  candidates: readonly DatasetCandidate[];
  reasons: readonly DatasetDetectionReason[];
  fallback?: DatasetFallbackDiagnostic;
}

export interface DatasetInspection {
  provenance: DatasetProvenance;
  detection: DatasetDetection;
  records: readonly DatasetRecordProjection[];
}

export interface DatasetAdapter {
  readonly id: string;
  readonly version: string;
  readonly framing: DatasetFraming;
  inspect(samples: readonly DatasetRecordSample[], options?: DatasetInspectionOptions): DatasetInspection;
  project(sample: DatasetRecordSample, shape: DatasetShape): DatasetRecordProjection;
}

/**
 * Read-only semantic adapter for the pinned LLaMA-Factory v1 JSONL shapes.
 * Framing and byte coordinates remain owned by the JSONL engine; this module
 * only classifies bounded parsed samples and returns a loss-aware projection.
 */
export class LlamaFactoryV1DatasetAdapter implements DatasetAdapter {
  public readonly id = LLAMA_FACTORY_V1_ADAPTER_ID;
  public readonly version = LLAMA_FACTORY_V1_ADAPTER_VERSION;
  public readonly framing: DatasetFraming = 'jsonl';

  public inspect(
    samples: readonly DatasetRecordSample[],
    options: DatasetInspectionOptions = {},
  ): DatasetInspection {
    const samplePlan = normalizeSamplePlan(options.samplePlan);
    const bounded = boundSamples(samples, samplePlan);
    const detection = detectLlamaFactory(bounded.samples, bounded.coverage);
    const selectedAdapterId = detection.fallback ? GENERIC_DATASET_ADAPTER_ID : this.id;
    const selectedAdapterVersion = detection.fallback ? GENERIC_DATASET_ADAPTER_VERSION : this.version;
    const provenance: DatasetProvenance = {
      framing: this.framing,
      adapterId: selectedAdapterId,
      adapterVersion: selectedAdapterVersion,
      samplePlan,
      coverage: bounded.coverage,
      confidence: detection.confidence,
      clockBasis: 'record-order',
      reasons: detection.reasons,
      ...(detection.fallback ? { fallback: detection.fallback } : {}),
      ...(options.source?.fingerprint ? { sourceFingerprint: options.source.fingerprint } : {}),
      ...(options.source?.generation ? { generation: options.source.generation } : {}),
    };
    const records = bounded.samples.map((sample) => this.project(
      sample,
      detection.fallback ? 'unknown' : detection.shape,
    ));
    return { provenance, detection, records };
  }

  public project(sample: DatasetRecordSample, shape: DatasetShape): DatasetRecordProjection {
    const value = sample.value;
    const physicalOrdinal = sample.ordinal ?? 'unknown';
    return {
      physicalOrdinal,
      shape,
      fields: shape === 'unknown' ? [] : projectFields(value, shape),
      raw: value,
      rawPreserved: true,
    };
  }
}

export function inspectLlamaFactoryDataset(
  samples: readonly DatasetRecordSample[],
  options?: DatasetInspectionOptions,
): DatasetInspection {
  return new LlamaFactoryV1DatasetAdapter().inspect(samples, options);
}

function normalizeSamplePlan(input: Partial<DatasetSamplePlan> | undefined): DatasetSamplePlan {
  const maxRecords = Number.isSafeInteger(input?.maxRecords) && (input?.maxRecords ?? 0) > 0
    ? Math.min(input!.maxRecords!, 256)
    : DEFAULT_SAMPLE_PLAN.maxRecords;
  const maxBytes = Number.isSafeInteger(input?.maxBytes) && (input?.maxBytes ?? 0) > 0
    ? Math.min(input!.maxBytes!, 4 * 1024 * 1024)
    : DEFAULT_SAMPLE_PLAN.maxBytes;
  return { maxRecords, maxBytes, strategy: 'head' };
}

function boundSamples(
  samples: readonly DatasetRecordSample[],
  plan: DatasetSamplePlan,
): { samples: DatasetRecordSample[]; coverage: DatasetSampleCoverage } {
  const bounded: DatasetRecordSample[] = [];
  let examinedBytes = 0;
  let truncatedReason: DatasetTruncationReason | undefined;
  for (const sample of samples) {
    if (bounded.length >= plan.maxRecords) {
      truncatedReason = 'record_limit';
      break;
    }
    const byteLength = encodedByteLength(sample);
    if (examinedBytes + byteLength > plan.maxBytes) {
      truncatedReason = 'byte_limit';
      break;
    }
    bounded.push(sample);
    examinedBytes += byteLength;
  }
  const invalidRecords = bounded.filter((sample) => !isValidSample(sample)).length;
  return {
    samples: bounded,
    coverage: {
      requestedRecords: samples.length,
      sampledRecords: bounded.length,
      validRecords: bounded.length - invalidRecords,
      invalidRecords,
      examinedBytes: String(examinedBytes),
      truncated: truncatedReason !== undefined,
      ...(truncatedReason ? { truncatedReason } : {}),
    },
  };
}

function encodedByteLength(sample: DatasetRecordSample): number {
  if (Number.isSafeInteger(sample.byteLength) && (sample.byteLength ?? 0) >= 0) return sample.byteLength!;
  try {
    return new TextEncoder().encode(JSON.stringify(sample.value) ?? '').byteLength;
  } catch {
    return 0;
  }
}

function isValidSample(sample: DatasetRecordSample): boolean {
  if (sample.parseState !== undefined && !['unknown', 'valid'].includes(sample.parseState)) return false;
  return isObject(sample.value);
}

function detectLlamaFactory(
  samples: readonly DatasetRecordSample[],
  coverage: DatasetSampleCoverage,
): DatasetDetection {
  const candidates = new Map<DatasetShape, DatasetCandidate>();
  const reasons: DatasetDetectionReason[] = [];
  const sampleShapes: DatasetShape[] = [];
  const conflictingShapes = new Set<DatasetShape>();
  let invalidSample = false;
  let shapeConflict = false;
  for (const sample of samples) {
    if (!isValidSample(sample)) {
      invalidSample = true;
      continue;
    }
    const classified = classifyRecord(sample.value);
    if (classified.shapes.length !== 1) {
      sampleShapes.push('unknown');
      for (const shape of classified.shapes) conflictingShapes.add(shape);
      for (const reason of classified.reasons) {
        pushReason(reasons, reason.path, reason.code, reason.observation);
      }
      if (classified.shapes.length > 1) {
        shapeConflict = true;
        pushReason(reasons, { tokens: [] }, 'conflict', 'A physical row matches multiple dataset shapes.');
      } else {
        pushReason(reasons, { tokens: [] }, 'unknown', 'No reviewed LLaMA-Factory v1 shape matched this row.');
      }
      continue;
    }
    const shape = classified.shapes[0]!;
    sampleShapes.push(shape);
    const current = candidates.get(shape);
    const nextReasons = [...(current?.reasons ?? []), ...classified.reasons];
    candidates.set(shape, {
      shape,
      matchedRecords: (current?.matchedRecords ?? 0) + 1,
      score: 1,
      reasons: nextReasons.slice(0, MAX_REASONS),
    });
  }

  const candidateList = [...candidates.values()].sort((left, right) => right.matchedRecords - left.matchedRecords || left.shape.localeCompare(right.shape));
  const distinctShapes = [...new Set(sampleShapes.filter((shape) => shape !== 'unknown'))];
  const hasUnknown = sampleShapes.some((shape) => shape === 'unknown');
  const fallbackCode: DatasetFallbackCode | undefined = invalidSample || coverage.invalidRecords > 0
    ? 'invalid_sample'
    : shapeConflict || distinctShapes.length > 1
      ? 'conflicting_shapes'
    : candidateList.length === 0 || hasUnknown
      ? 'unknown_shape'
        : undefined;
  if (fallbackCode) {
    const candidateShapes = [...new Set([
      ...candidateList.map((candidate) => candidate.shape),
      ...conflictingShapes,
    ])];
    const message = fallbackCode === 'conflicting_shapes'
      ? 'Dataset shapes conflict within the bounded sample; using visible Generic JSONL fallback.'
      : fallbackCode === 'invalid_sample'
        ? 'The bounded sample contains invalid or non-object rows; using visible Generic JSONL fallback.'
        : 'The bounded sample does not match a reviewed LLaMA-Factory v1 shape; using visible Generic JSONL fallback.';
    const fallback: DatasetFallbackDiagnostic = {
      visible: true,
      code: fallbackCode,
      message,
      fallbackAdapterId: GENERIC_DATASET_ADAPTER_ID,
      candidateShapes,
    };
    return {
      selectedAdapterId: GENERIC_DATASET_ADAPTER_ID,
      selectedAdapterVersion: GENERIC_DATASET_ADAPTER_VERSION,
      shape: 'unknown',
      confidence: 'none',
      candidates: candidateList,
      reasons: reasons.slice(0, MAX_REASONS),
      fallback,
    };
  }
  const selected = candidateList[0]!;
  const confidence: DatasetConfidence = coverage.truncated ? 'medium' : 'high';
  return {
    selectedAdapterId: LLAMA_FACTORY_V1_ADAPTER_ID,
    selectedAdapterVersion: LLAMA_FACTORY_V1_ADAPTER_VERSION,
    shape: selected.shape,
    confidence,
    candidates: candidateList,
    reasons: selected.reasons.slice(0, MAX_REASONS),
  };
}

function classifyRecord(value: unknown): { shapes: DatasetShape[]; reasons: DatasetDetectionReason[] } {
  if (!isObject(value)) return { shapes: [], reasons: [] };
  const chosen = own(value, 'chosen_messages');
  const rejected = own(value, 'rejected_messages');
  if (Array.isArray(chosen) || Array.isArray(rejected)) {
    if (Array.isArray(chosen) && Array.isArray(rejected) && chosen.length > 0 && rejected.length > 0) {
      return {
        shapes: ['preference'],
        reasons: [{ path: { tokens: [{ kind: 'key', value: 'chosen_messages' }] }, code: 'shape_evidence', observation: 'Chosen and rejected message branches are present.' }],
      };
    }
    return { shapes: [], reasons: [{ path: { tokens: [] }, code: 'missing_required_field', observation: 'A preference row is missing one message branch.' }] };
  }
  const messages = own(value, 'messages');
  if (!Array.isArray(messages) || messages.length === 0) return { shapes: [], reasons: [] };
  const boundedMessages = messages.slice(0, MAX_MESSAGES_PER_RECORD);
  if (boundedMessages.some(messageHasUnknownContentBlock)) {
    return {
      shapes: [],
      reasons: [{ path: { tokens: [{ kind: 'key', value: 'messages' }] }, code: 'unknown', observation: 'Messages contain an unknown content block type.' }],
    };
  }
  const hasTool = boundedMessages.some(messageHasToolSignal);
  const hasMedia = boundedMessages.some(messageHasMediaSignal);
  if (hasTool && hasMedia) {
    return {
      shapes: ['tool-use', 'multimodal'],
      reasons: [{ path: { tokens: [{ kind: 'key', value: 'messages' }] }, code: 'conflict', observation: 'Tool and multimodal message signals coexist.' }],
    };
  }
  if (hasTool) {
    return {
      shapes: ['tool-use'],
      reasons: [{ path: { tokens: [{ kind: 'key', value: 'messages' }] }, code: 'shape_evidence', observation: 'Messages contain a bounded tool-call or tool-result signal.' }],
    };
  }
  if (hasMedia) {
    return {
      shapes: ['multimodal'],
      reasons: [{ path: { tokens: [{ kind: 'key', value: 'messages' }] }, code: 'shape_evidence', observation: 'Messages contain a bounded multimodal content signal.' }],
    };
  }
  if (boundedMessages.every(isMessageShape)) {
    return {
      shapes: ['sft'],
      reasons: [{ path: { tokens: [{ kind: 'key', value: 'messages' }] }, code: 'shape_evidence', observation: 'Messages contain ordered role/content entries.' }],
    };
  }
  return { shapes: [], reasons: [] };
}

function isMessageShape(value: unknown): boolean {
  if (!isObject(value) || typeof own(value, 'role') !== 'string' || !Object.prototype.hasOwnProperty.call(value, 'content')) return false;
  const lossWeight = own(value, 'loss_weight');
  return lossWeight === undefined || typeof lossWeight === 'number' || Array.isArray(lossWeight);
}

function messageHasToolSignal(value: unknown): boolean {
  if (!isObject(value)) return false;
  const role = own(value, 'role');
  if (role === 'tool') return true;
  const calls = own(value, 'tool_calls');
  if (Array.isArray(calls) && calls.length > 0) return true;
  return contentBlocks(value).some((block) => {
    const type = typeof own(block, 'type') === 'string' ? String(own(block, 'type')).toLowerCase() : '';
    return ['tool_call', 'tool_use', 'tool_result', 'function_call', 'function'].includes(type);
  });
}

function messageHasMediaSignal(value: unknown): boolean {
  if (!isObject(value)) return false;
  return contentBlocks(value).some((block) => {
    const type = typeof own(block, 'type') === 'string' ? String(own(block, 'type')).toLowerCase() : '';
    return ['image', 'image_url', 'input_image', 'audio', 'audio_url', 'video', 'video_url'].includes(type)
      || ['image_url', 'input_image', 'audio_url', 'video_url'].some((key) => own(block, key) !== undefined);
  });
}

function contentBlocks(value: Record<string, unknown>): Record<string, unknown>[] {
  const content = own(value, 'content');
  if (!Array.isArray(content)) return [];
  return content.slice(0, MAX_BLOCKS_PER_MESSAGE).filter(isObject);
}

function messageHasUnknownContentBlock(value: unknown): boolean {
  if (!isObject(value)) return false;
  const content = own(value, 'content');
  if (!Array.isArray(content)) return false;
  return content.slice(0, MAX_BLOCKS_PER_MESSAGE).some((block) => {
    if (!isObject(block)) return true;
    const type = own(block, 'type');
    if (typeof type !== 'string') return true;
    return ![
      'text', 'input_text', 'output_text', 'thinking', 'reasoning',
      'tool_call', 'tool_use', 'tool_result', 'function_call', 'function',
      'image', 'image_url', 'input_image', 'audio', 'audio_url', 'video', 'video_url',
    ].includes(type.toLowerCase());
  });
}

function projectFields(value: unknown, shape: DatasetShape): DatasetFieldProjection[] {
  if (!isObject(value)) return [];
  if (shape === 'preference') {
    return [
      { field: 'chosen_messages', path: { tokens: [{ kind: 'key', value: 'chosen_messages' }] }, count: arrayLength(value, 'chosen_messages') },
      { field: 'rejected_messages', path: { tokens: [{ kind: 'key', value: 'rejected_messages' }] }, count: arrayLength(value, 'rejected_messages') },
    ];
  }
  const messages = arrayLength(value, 'messages');
  const fields: DatasetFieldProjection[] = [
    { field: 'messages', path: { tokens: [{ kind: 'key', value: 'messages' }] }, count: messages },
  ];
  if (shape === 'tool-use') fields.push({ field: 'tool_calls', path: { tokens: [{ kind: 'key', value: 'messages' }] }, count: countToolSignals(value) });
  if (shape === 'multimodal') fields.push({ field: 'media_references', path: { tokens: [{ kind: 'key', value: 'messages' }] }, count: countMediaSignals(value) });
  return fields;
}

function arrayLength(value: Record<string, unknown>, key: string): number {
  const candidate = own(value, key);
  return Array.isArray(candidate) ? candidate.length : 0;
}

function countToolSignals(value: Record<string, unknown>): number {
  const messages = own(value, 'messages');
  return Array.isArray(messages) ? messages.slice(0, MAX_MESSAGES_PER_RECORD).filter(messageHasToolSignal).length : 0;
}

function countMediaSignals(value: Record<string, unknown>): number {
  const messages = own(value, 'messages');
  return Array.isArray(messages) ? messages.slice(0, MAX_MESSAGES_PER_RECORD).filter(messageHasMediaSignal).length : 0;
}

function pushReason(
  target: DatasetDetectionReason[],
  path: FieldPath,
  code: DatasetDetectionReason['code'],
  observation: string,
): void {
  if (target.length >= MAX_REASONS) return;
  if (target.some((reason) => reason.code === code && reason.observation === observation)) return;
  target.push({ path, code, observation });
}
