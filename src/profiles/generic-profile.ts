import type { AgentProfile, DetectionResult, GenericRecordSample, HydratedRecord, ProjectionContext } from './profile-contract';
import { inferRecordSignals } from './shape-discovery';
import { actorFromRole, boundedSummary, createProjection, keyPath, setActor, setDerivedField, setStringField } from './utils';

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
    const signals = inferRecordSignals(record.value);
    const projection = createProjection(
      this.id,
      'other',
      boundedSummary(signals.summary?.value ?? record.value, signals.discriminator?.value),
      signals.discriminator?.path,
      signals.summary?.path ?? keyPath(),
    );
    if (signals.timestamp) setStringField(projection, 'timestamp', signals.timestamp.value, signals.timestamp.path);
    if (signals.actor) setActor(projection, actorFromRole(signals.actor.value), signals.actor.path);
    const identity = signals.identities[0];
    if (identity) {
      setDerivedField(projection, 'detectedIdentity', identity.value, identity.path);
    }
    if (signals.discriminator) {
      setDerivedField(projection, 'detectedType', signals.discriminator.value, signals.discriminator.path);
    }
    return projection;
  }
}
