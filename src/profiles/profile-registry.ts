import type { AgentRowProjection, ProfileSuggestion } from '../shared/types';
import { ClaudeCodeProfile } from './claude-profile';
import { CodexRolloutProfile } from './codex-profile';
import { correlateBatch } from './correlation';
import { GenericAgentEventsProfile } from './generic-agent-profile';
import { GENERIC_PROFILE_ID, GenericProfile } from './generic-profile';
import { OpenTelemetryProfile } from './opentelemetry-profile';
import { SoftwareEngineeringAgentProfile } from './software-engineering-agent-profile';
import { StructuredApplicationLogProfile } from './structured-application-log-profile';
import type {
  AgentProfile,
  CorrelationInput,
  CorrelationResult,
  CorrelationState,
  GenericRecordSample,
  HydratedRecord,
  ProfileDetectionDecision,
  ProjectionContext,
} from './profile-contract';

export interface ProfileRegistryOptions {
  detectionThreshold?: number;
  ambiguityDelta?: number;
  maxDetectionSamples?: number;
  includeBuiltins?: boolean;
}

export class AgentProfileRegistry {
  private readonly profiles = new Map<string, AgentProfile>();
  private readonly detectionThreshold: number;
  private readonly ambiguityDelta: number;
  private readonly maxDetectionSamples: number;

  public constructor(options: ProfileRegistryOptions = {}) {
    this.detectionThreshold = options.detectionThreshold ?? 0.65;
    this.ambiguityDelta = options.ambiguityDelta ?? 0.08;
    this.maxDetectionSamples = options.maxDetectionSamples ?? 64;
    this.register(new GenericProfile());
    if (options.includeBuiltins !== false) {
      this.register(new CodexRolloutProfile());
      this.register(new ClaudeCodeProfile());
      this.register(new GenericAgentEventsProfile());
      this.register(new OpenTelemetryProfile());
      this.register(new SoftwareEngineeringAgentProfile());
      this.register(new StructuredApplicationLogProfile());
    }
  }

  public register(profile: AgentProfile): void {
    if (!profile.id || !profile.version || profile.id.includes('@')) {
      throw new Error('Profile id and version must be non-empty; id cannot contain "@".');
    }
    if (this.profiles.has(profile.id)) {
      throw new Error(`Profile already registered: ${profile.id}`);
    }
    this.profiles.set(profile.id, profile);
  }

  public list(): readonly AgentProfile[] {
    return [...this.profiles.values()];
  }

  public detect(samples: readonly GenericRecordSample[]): ProfileDetectionDecision {
    const boundedSamples = samples.slice(0, this.maxDetectionSamples);
    const detections = [...this.profiles.values()]
      .filter((profile) => profile.id !== GENERIC_PROFILE_ID)
      .map((profile) => {
        try {
          const result = profile.detect(boundedSamples);
          return {
            ...result,
            profileId: profile.id,
            profileVersion: profile.version,
            score: normalizeScore(result.score),
            reasons: result.reasons.slice(0, 8),
            sampledRecords: boundedSamples.length,
          };
        } catch {
          return {
            profileId: profile.id,
            profileVersion: profile.version,
            score: 0,
            reasons: [],
            requiredEvidenceMet: false,
            sampledRecords: boundedSamples.length,
          };
        }
      })
      .sort((left, right) => right.score - left.score || left.profileId.localeCompare(right.profileId));

    const eligible = detections.filter((result) => result.requiredEvidenceMet && result.score >= this.detectionThreshold);
    const top = eligible[0];
    const second = eligible[1];
    const ambiguous = Boolean(top && second && top.score - second.score < this.ambiguityDelta);
    const selected = !top || ambiguous ? this.requireProfile(GENERIC_PROFILE_ID) : this.requireProfile(top.profileId);
    const suggestions: ProfileSuggestion[] = eligible.map((result) => ({
      id: result.profileId,
      displayName: this.requireProfile(result.profileId).displayName,
      score: result.score,
      reasons: result.reasons.map((reason) => reason.observation),
    }));
    return {
      selectedProfileId: selected.id,
      selectedProfileVersion: selected.version,
      fallbackProfileId: GENERIC_PROFILE_ID,
      ambiguous,
      suggestions,
      detections,
    };
  }

  public project(profileId: string, record: HydratedRecord, context: ProjectionContext): AgentRowProjection {
    const profile = this.requireProfile(profileId);
    try {
      return profile.project(record, context);
    } catch {
      return this.requireProfile(GENERIC_PROFILE_ID).project(record, context);
    }
  }

  public correlate(
    profileId: string,
    generation: string,
    batch: readonly CorrelationInput[],
    state?: CorrelationState,
  ): CorrelationResult {
    const profile = this.requireProfile(profileId);
    if (batch.some((item) => item.projection.profileId !== profile.id)) {
      const unchanged = correlateBatch(profile, generation, [], state);
      return { ...unchanged, records: [...batch] };
    }
    return correlateBatch(profile, generation, batch, state);
  }

  private requireProfile(profileId: string): AgentProfile {
    const profile = this.profiles.get(profileId);
    if (!profile) {
      throw new Error(`Unknown Agent profile: ${profileId}`);
    }
    return profile;
  }
}

function normalizeScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.min(1, Math.max(0, score));
}
