import type { AgentProfile, DetectionResult, GenericRecordSample, HydratedRecord, ProjectionContext } from './profile-contract';
import { boundedSummary, createProjection, keyPath } from './utils';

export const GENERIC_PROFILE_ID = 'generic' as const;

export class GenericProfile implements AgentProfile {
  public readonly id = GENERIC_PROFILE_ID;
  public readonly displayName = 'Generic JSONL';
  public readonly version = '1';

  public detect(sample: readonly GenericRecordSample[]): DetectionResult {
    return {
      profileId: this.id,
      profileVersion: this.version,
      score: 0,
      reasons: [],
      requiredEvidenceMet: true,
      sampledRecords: sample.length,
    };
  }

  public project(record: HydratedRecord, _context: ProjectionContext) {
    return createProjection(this.id, 'other', boundedSummary(record.value), undefined, keyPath());
  }
}
