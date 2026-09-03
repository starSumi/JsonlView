export { ClaudeCodeProfile } from './claude-profile';
export { CodexRolloutProfile } from './codex-profile';
export { createCorrelationState, correlationStateKey } from './correlation';
export { GenericAgentEventsProfile } from './generic-agent-profile';
export { GENERIC_PROFILE_ID, GenericProfile } from './generic-profile';
export { OpenTelemetryProfile } from './opentelemetry-profile';
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

import { AgentProfileRegistry } from './profile-registry';

export function createProfileRegistry(options?: import('./profile-registry').ProfileRegistryOptions): AgentProfileRegistry {
  return new AgentProfileRegistry(options);
}
