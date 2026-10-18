import type {
  DatasetHeadCoverageV1,
  DatasetHeadPlanV1,
  DatasetRuntimeProvenanceV1,
  DatasetDetectionStageV1,
  DatasetDetectionTerminalStatusV1,
  DatasetDetectionTerminalV1,
  ParseState,
  RecordRef,
  RowPage,
} from '../shared/types';
import { inspectLlamaFactoryDataset, type DatasetRecordSample } from './dataset-adapter';

export const DATASET_HEAD_PLAN: Readonly<DatasetHeadPlanV1> = Object.freeze({
  strategy: 'head', maxRecords: 32, maxBytes: 262144,
});

export function pendingDatasetProvenance(): DatasetRuntimeProvenanceV1 {
  return { version: 1, status: 'pending', samplePlan: { ...DATASET_HEAD_PLAN } };
}

const TERMINALS: Readonly<Record<DatasetDetectionTerminalStatusV1, Omit<DatasetDetectionTerminalV1, 'stage'>>> = {
  failed: { code: 'detection_failed', retryable: true, action: 'reload' },
  timeout: { code: 'deadline_exceeded', retryable: true, action: 'reload' },
  cancelled: { code: 'operation_cancelled', retryable: false, action: 'none' },
  disabled: { code: 'auto_detection_disabled', retryable: false, action: 'enable-auto-detection' },
};

export function terminalDatasetProvenance(
  status: DatasetDetectionTerminalStatusV1, stage: DatasetDetectionStageV1,
): DatasetRuntimeProvenanceV1 {
  return {
    version: 1, status, samplePlan: { ...DATASET_HEAD_PLAN },
    terminal: { ...TERMINALS[status], stage: status === 'disabled' ? 'not-started' : stage },
  };
}

/** Reuses an existing hydration stream. Limits describe inspection, never I/O or RSS. */
export class DatasetHeadInspection {
  private samples: DatasetRecordSample[] = [];
  private examinedBytes = 0n;
  private invalidRecords = 0;
  private unsupportedFraming = false;
  private inspectionBoundaryFailure = false;
  private stoppedBy: DatasetHeadCoverageV1['stoppedBy'];

  public constructor(private readonly inspect = inspectLlamaFactoryDataset) {}

  public accept(record: { value?: unknown; ref: RecordRef; parseState: ParseState }): void {
    if (this.stoppedBy !== undefined) return;
    if (this.samples.length >= DATASET_HEAD_PLAN.maxRecords) {
      this.stoppedBy = 'record_limit';
      return;
    }
    if (!/^(0|[1-9]\d*)$/.test(record.ref.contentByteLength)) {
      this.inspectionBoundaryFailure = true;
      this.stoppedBy = 'uninspectable_record';
      return;
    }
    const byteLength = BigInt(record.ref.contentByteLength);
    if (record.parseState === 'oversized') {
      this.inspectionBoundaryFailure = true;
      this.stoppedBy = 'uninspectable_record';
      return;
    }
    // Budget in the source coordinate domain before the adapter's safe number conversion.
    if (this.examinedBytes + byteLength > BigInt(DATASET_HEAD_PLAN.maxBytes)) {
      this.stoppedBy = 'byte_limit';
      return;
    }
    const valid = record.parseState === 'valid'
      && record.value !== null && typeof record.value === 'object' && !Array.isArray(record.value);
    if (!valid) this.invalidRecords += 1;
    if (Array.isArray(record.value)) this.unsupportedFraming = true;
    this.samples.push({
      value: record.value, ordinal: record.ref.ordinal, parseState: record.parseState,
      byteLength: Number(byteLength),
    });
    this.examinedBytes += byteLength;
  }

  public finish(page: Pick<RowPage, 'hasAfter' | 'scan'>, indexingComplete: boolean): DatasetRuntimeProvenanceV1 {
    const stoppedBy = this.stoppedBy ?? page.scan?.truncatedReason;
    const partial = stoppedBy !== undefined || page.hasAfter || !indexingComplete;
    const coverage: DatasetHeadCoverageV1 = {
      sampledRecords: this.samples.length,
      validRecords: this.samples.length - this.invalidRecords,
      invalidRecords: this.invalidRecords,
      examinedBytes: this.examinedBytes.toString(),
      partial,
      ...(stoppedBy === undefined ? {} : { stoppedBy }),
    };
    const base = {
      version: 1 as const, framing: 'jsonl' as const,
      samplePlan: { ...DATASET_HEAD_PLAN }, adapterVersion: '1.0.0' as const, coverage,
    };
    const fallback = (code: Extract<DatasetRuntimeProvenanceV1, { status: 'fallback' }>['fallback']['code'],
      candidateShapes: Extract<DatasetRuntimeProvenanceV1, { status: 'fallback' }>['fallback']['candidateShapes'] = [],
    ): DatasetRuntimeProvenanceV1 => ({
      ...base, status: 'fallback', adapterId: 'generic-jsonl', shape: 'unknown',
      confidence: 'none', clockBasis: 'none', fallback: { code, candidateShapes: [...candidateShapes] },
    });
    try {
      if (this.unsupportedFraming) return fallback('unsupported_framing');
      if (this.inspectionBoundaryFailure || this.invalidRecords > 0) return fallback('invalid_sample');
      if (this.samples.length === 0) return fallback('sample_unavailable');
      const { detection } = this.inspect(this.samples, { samplePlan: DATASET_HEAD_PLAN });
      if (detection.fallback !== undefined) {
        return fallback(detection.fallback.code, detection.fallback.candidateShapes);
      }
      return {
        ...base, status: partial ? 'partial' : 'ready', adapterId: detection.selectedAdapterId as 'llamafactory-v1' | 'sharegpt-v1' | 'virtualhome-v1' | 'sft-master-conversation-v1' | 'sft-master-keyword-result-v1',
        shape: detection.shape, confidence: partial ? 'medium' : detection.confidence, clockBasis: 'record-order',
      };
    } catch {
      return fallback('inspection_failed');
    } finally {
      this.samples = [];
    }
  }
}
