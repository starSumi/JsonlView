export { ClaudeCodeProfile } from './claude-profile';
export {
  GENERIC_DATASET_ADAPTER_ID,
  GENERIC_DATASET_ADAPTER_VERSION,
  LLAMA_FACTORY_V1_ADAPTER_ID,
  LLAMA_FACTORY_V1_ADAPTER_VERSION,
  LlamaFactoryV1DatasetAdapter,
  inspectLlamaFactoryDataset,
} from './dataset-adapter';
export { DATASET_HEAD_PLAN, DatasetHeadInspection, pendingDatasetProvenance } from './dataset-runtime';
export type {
  DatasetAdapter,
  DatasetCandidate,
  DatasetClockBasis,
  DatasetConfidence,
  DatasetDetection,
  DatasetDetectionReason,
  DatasetFallbackCode,
  DatasetFallbackDiagnostic,
  DatasetFieldProjection,
  DatasetFraming,
  DatasetInspection,
  DatasetInspectionOptions,
  DatasetProvenance,
  DatasetRecordProjection,
  DatasetRecordSample,
  DatasetSampleCoverage,
  DatasetSamplePlan,
  DatasetShape,
  DatasetSourceIdentity,
  DatasetTruncationReason,
} from './dataset-adapter';
export {
  CodexHistoryProfile,
  CodexSessionIndexProfile,
  isHistoryEntry,
  isRfc3339Timestamp,
  isSessionIndexEntry,
  isUnixSeconds,
} from './codex-auxiliary-profile';
export {
  CLAUDE_CONTROL_TYPES,
  CLAUDE_TRANSCRIPT_TYPES,
  claudeHistoryTimestamp,
  classifyClaudeRecord,
  hasClaudeIdentityEnvelope,
  isClaudeJobTimelinePathHint,
  isClaudeJobTimelineState,
  isClaudeHistoryRecord,
  isClaudeJobTimelineRecord,
} from './claude-record-strategy';
export { CodexRolloutProfile } from './codex-profile';
export { CodexExecProfile, CODEX_EXEC_EVENT_TYPES } from './codex-exec-profile';
export { CodexTraceProfile, isCodexTraceEvent } from './codex-trace-profile';
export {
  discoverShape,
  inferRecordSignals,
  CODEX_SOURCE_REVISION,
  SOURCE_SURFACE_CATALOG,
  sourceSurfaceEvidence,
  sourceSurfaceHint,
  valueAtPath,
} from './shape-discovery';
export { createCorrelationState, correlationStateKey } from './correlation';
export { GenericAgentEventsProfile } from './generic-agent-profile';
export { GENERIC_PROFILE_ID, GenericProfile } from './generic-profile';
export { OpenTelemetryProfile } from './opentelemetry-profile';
export { PiCodingAgentProfile, isPiMessageEntry, isPiSessionHeader } from './pi-profile';
export { KimiCodeProfile } from './kimi-profile';
export { KIMI_SOURCE_REVISION, isKimiContextRecord, isKimiMetadata } from './kimi-record';
export { AgentProfileRegistry } from './profile-registry';
export { SoftwareEngineeringAgentProfile } from './software-engineering-agent-profile';
export { StructuredApplicationLogProfile } from './structured-application-log-profile';
export type { ProfileRegistryOptions } from './profile-registry';
export type {
  AgentProfile,
  CorrelationEvidence,
  CorrelationInput,
  CorrelationKind,
  CorrelationRelation,
  CorrelationResult,
  CorrelationState,
  DetectionReason,
  DetectionResult,
  GenericRecordSample,
  HydratedRecord,
  ProfileDetectionDecision,
  ProjectionContext,
} from './profile-contract';
export type {
  SourceSurfaceDescriptor,
  SourceSurfaceDisposition,
  SourceSurfaceEvidence,
  SourceSurfaceKind,
  SourceSurfaceLocator,
} from './shape-discovery';

import { AgentProfileRegistry } from './profile-registry';

export function createProfileRegistry(options?: import('./profile-registry').ProfileRegistryOptions): AgentProfileRegistry {
  return new AgentProfileRegistry(options);
}
