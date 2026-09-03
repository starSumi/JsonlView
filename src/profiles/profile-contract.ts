import type {
  AgentEvidence,
  AgentRowProjection,
  FieldPath,
  ProfileSuggestion,
  RecordRef,
} from '../shared/types';

export interface GenericRecordSample {
  value: unknown;
  ordinal?: string;
}

export interface HydratedRecord {
  value: unknown;
  ref?: RecordRef;
}

export interface ProjectionContext {
  generation: string;
}

export interface DetectionReason {
  path: FieldPath;
  observation: string;
}

export interface DetectionResult {
  profileId: string;
  profileVersion: string;
  score: number;
  reasons: DetectionReason[];
  requiredEvidenceMet: boolean;
  sampledRecords: number;
}

export interface ProfileDetectionDecision {
  selectedProfileId: string;
  selectedProfileVersion: string;
  fallbackProfileId: 'generic';
  ambiguous: boolean;
  suggestions: ProfileSuggestion[];
  detections: DetectionResult[];
}

export interface AgentProfile {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;

  detect(sample: readonly GenericRecordSample[]): DetectionResult;
  project(record: HydratedRecord, context: ProjectionContext): AgentRowProjection;
}

export interface CorrelationInput {
  recordKey: string;
  projection: AgentRowProjection;
}

export type CorrelationKind =
  | 'session_member'
  | 'turn_member'
  | 'tool_pair'
  | 'parent_child'
  | 'subagent_parent';

export interface CorrelationEvidence {
  recordKey: string;
  field: string;
  path: FieldPath;
}

export interface CorrelationRelation {
  kind: CorrelationKind;
  stableId: string;
  sourceRecordKey: string;
  targetRecordKey: string;
  confidence: 'correlated';
  evidence: CorrelationEvidence[];
}

export interface CorrelationState {
  key: string;
  profileId: string;
  profileVersion: string;
  generation: string;
  records: Record<string, CorrelationStateRecord>;
  messages: Record<string, string>;
  sessions: Record<string, string[]>;
  turns: Record<string, string[]>;
  tools: Record<string, { calls: string[]; results: string[] }>;
  subagents: Record<string, string>;
  pendingParents: Record<string, string[]>;
  relationKeys: Record<string, true>;
}

export interface CorrelationStateRecord {
  eventKind: AgentRowProjection['eventKind'];
  evidence: AgentEvidence[];
}

export interface CorrelationResult {
  records: CorrelationInput[];
  relations: CorrelationRelation[];
  state: CorrelationState;
}
