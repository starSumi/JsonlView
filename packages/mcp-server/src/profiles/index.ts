export { ClaudeCodeProfile } from './claude-profile.js';
export {
  GENERIC_DATASET_ADAPTER_ID,
  GENERIC_DATASET_ADAPTER_VERSION,
  LLAMA_FACTORY_V1_ADAPTER_ID,
  LLAMA_FACTORY_V1_ADAPTER_VERSION,
  SHAREGPT_V1_ADAPTER_ID,
  SHAREGPT_V1_ADAPTER_VERSION,
  VIRTUALHOME_V1_ADAPTER_ID,
  VIRTUALHOME_V1_ADAPTER_VERSION,
  SFT_MASTER_CONVERSATION_V1_ADAPTER_ID,
  SFT_MASTER_CONVERSATION_V1_ADAPTER_VERSION,
  SFT_MASTER_KEYWORD_RESULT_V1_ADAPTER_ID,
  SFT_MASTER_KEYWORD_RESULT_V1_ADAPTER_VERSION,
  LlamaFactoryV1DatasetAdapter,
  inspectLlamaFactoryDataset,
} from './dataset-adapter.js';
export { DATASET_HEAD_PLAN, DatasetHeadInspection, pendingDatasetProvenance } from './dataset-runtime.js';
export {
  aggregateBfclV3Summaries,
  isBfclV3Candidate,
  summarizeBfclV3Record,
} from './datasets/bfcl-v3.js';
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
} from './dataset-adapter.js';
export {
  CodexHistoryProfile,
  CodexSessionIndexProfile,
  isHistoryEntry,
  isRfc3339Timestamp,
  isSessionIndexEntry,
  isUnixSeconds,
} from './codex-auxiliary-profile.js';
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
} from './claude-record-strategy.js';
export { CodexRolloutProfile } from './codex-profile.js';
export { CodexExecProfile, CODEX_EXEC_EVENT_TYPES } from './codex-exec-profile.js';
export { CodexTraceProfile, isCodexTraceEvent } from './codex-trace-profile.js';
export {
  discoverShape,
  inferRecordSignals,
  CODEX_SOURCE_REVISION,
  SOURCE_SURFACE_CATALOG,
  sourceSurfaceEvidence,
  sourceSurfaceHint,
  valueAtPath,
} from './shape-discovery.js';
export { createCorrelationState, correlationStateKey } from './correlation.js';
export { GenericAgentEventsProfile } from './generic-agent-profile.js';
export { GENERIC_PROFILE_ID, GenericProfile } from './generic-profile.js';
export { OpenTelemetryProfile } from './opentelemetry-profile.js';
export { PiCodingAgentProfile, isPiMessageEntry, isPiSessionHeader } from './pi-profile.js';
export { KimiCodeProfile } from './kimi-profile.js';
export { KIMI_SOURCE_REVISION, isKimiAgentCoreRecord, isKimiContextRecord, isKimiMetadata } from './kimi-record.js';
export { AgentProfileRegistry } from './profile-registry.js';
export { SoftwareEngineeringAgentProfile } from './software-engineering-agent-profile.js';
export { StructuredApplicationLogProfile } from './structured-application-log-profile.js';
export type { ProfileRegistryOptions } from './profile-registry.js';
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
} from './profile-contract.js';
export type {
  SourceSurfaceDescriptor,
  SourceSurfaceDisposition,
  SourceSurfaceEvidence,
  SourceSurfaceKind,
  SourceSurfaceLocator,
} from './shape-discovery.js';

import { AgentProfileRegistry } from './profile-registry.js';

export function createProfileRegistry(options?: import('./profile-registry').ProfileRegistryOptions): AgentProfileRegistry {
  return new AgentProfileRegistry(options);
}


