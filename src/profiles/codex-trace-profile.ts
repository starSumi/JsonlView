import type { AgentEventKind, AgentRowProjection } from '../shared/types';
import type { AgentProfile, DetectionResult, GenericRecordSample, HydratedRecord, ProjectionContext } from './profile-contract';
import { sourceSurfaceEvidence } from './shape-discovery';
import {
  boundedSummary,
  createProjection,
  evidence,
  isObject,
  keyPath,
  objectAt,
  own,
  pushReason,
  setActor,
  setDerivedField,
  setStringField,
  stringAt,
} from './utils';

const TRACE_PAYLOAD_KIND_MAP: Record<string, AgentEventKind> = {
  rollout_started: 'session',
  rollout_ended: 'result',
  thread_started: 'session',
  thread_ended: 'result',
  codex_turn_started: 'turn',
  codex_turn_ended: 'result',
  inference_started: 'tool_call',
  inference_completed: 'result',
  inference_failed: 'error',
  inference_cancelled: 'error',
  tool_call_started: 'tool_call',
  mcp_tool_call_correlation_assigned: 'tool_call',
  tool_call_runtime_started: 'tool_call',
  tool_call_runtime_ended: 'tool_result',
  tool_call_ended: 'tool_result',
  code_cell_started: 'action',
  code_cell_initial_response: 'observation',
  code_cell_ended: 'result',
  compaction_request_started: 'checkpoint',
  compaction_request_completed: 'checkpoint',
  compaction_request_failed: 'error',
  compaction_installed: 'checkpoint',
  agent_result_observed: 'subagent',
  protocol_event_observed: 'other',
  other: 'other',
};

/** Raw trace bundle records written by Codex's rollout-trace writer. */
export class CodexTraceProfile implements AgentProfile {
  public readonly id = 'codex-trace';
  public readonly displayName = 'Codex Trace Bundle';
  public readonly version = '1';

  public detect(sample: readonly GenericRecordSample[]): DetectionResult {
    let valid = 0;
    let knownPayloadKinds = 0;
    const reasons: DetectionResult['reasons'] = [];
    const tracePathHint = sample.length > 0 && sample.every((entry) => {
      const hint = sourceSurfaceEvidence(entry.sourcePathHint);
      return hint?.kind === 'codex-trace';
    });

    for (const entry of sample) {
      if (!isCodexTraceEvent(entry.value)) continue;
      valid += 1;
      const kind = stringAt(objectAt(entry.value, 'payload'), 'type');
      if (kind && Object.prototype.hasOwnProperty.call(TRACE_PAYLOAD_KIND_MAP, kind)) {
        knownPayloadKinds += 1;
        pushReason(reasons, keyPath('payload', 'type'), `Codex trace payload: ${kind}`);
      }
      pushReason(reasons, keyPath('schema_version'), 'Codex trace envelope: schema_version/seq/wall_time_unix_ms/rollout_id/payload');
    }
    if (tracePathHint) {
      pushReason(reasons, keyPath('payload'), 'trace.jsonl basename is a weak companion hint; envelope validation remains required');
    }

    const denominator = Math.max(1, sample.length);
    const coverage = valid / denominator;
    const quorum = Math.min(1, valid / 2);
    const score = Math.min(0.99, 0.54 * coverage + 0.28 * quorum + 0.18 * Math.min(1, knownPayloadKinds / 2));
    return {
      profileId: this.id,
      profileVersion: this.version,
      score,
      reasons,
      requiredEvidenceMet: valid >= Math.min(2, denominator)
        && knownPayloadKinds >= 1
        && coverage >= 0.9,
      sampledRecords: sample.length,
    };
  }

  public project(record: HydratedRecord, _context: ProjectionContext): AgentRowProjection {
    if (!isObject(record.value) || !isCodexTraceEvent(record.value)) {
      return createProjection(this.id, 'other', boundedSummary(record.value, 'Unknown Codex trace record'), undefined, keyPath());
    }
    const value = record.value;
    const payload = objectAt(value, 'payload');
    const payloadType = stringAt(payload, 'type') ?? 'unknown';
    const eventKind = TRACE_PAYLOAD_KIND_MAP[payloadType] ?? 'other';
    const payloadPath = keyPath('payload', 'type');
    const summaryValue = own(payload ?? {}, 'summary')
      ?? own(payload ?? {}, 'message')
      ?? own(payload ?? {}, 'error')
      ?? own(payload ?? {}, 'status')
      ?? own(payload ?? {}, 'kind')
      ?? payload;
    const projection = createProjection(
      this.id,
      eventKind,
      boundedSummary(summaryValue, `Trace ${payloadType}`),
      payloadType === 'unknown' ? keyPath('payload') : payloadPath,
      keyPath('payload'),
    );

    setActor(projection, actorFor(eventKind), payloadPath);
    const wallTime = own(value, 'wall_time_unix_ms');
    const timestamp = timestampFromUnixMillis(wallTime);
    if (timestamp !== undefined) setStringField(projection, 'timestamp', timestamp, keyPath('wall_time_unix_ms'));
    const threadId = stringAt(value, 'thread_id');
    const rolloutId = stringAt(value, 'rollout_id');
    setStringField(projection, 'sessionId', threadId ?? rolloutId, threadId ? keyPath('thread_id') : keyPath('rollout_id'));
    setStringField(projection, 'turnId', stringAt(value, 'codex_turn_id'), keyPath('codex_turn_id'));
    setStringField(projection, 'status', stringAt(payload, 'status'), keyPath('payload', 'status'));
    if (eventKind === 'error') setStringField(projection, 'severity', 'error', payloadPath);
    const model = stringAt(payload, 'model') ?? stringAt(payload, 'provider_name');
    setStringField(projection, 'model', model, stringAt(payload, 'model') ? keyPath('payload', 'model') : keyPath('payload', 'provider_name'));
    setDerivedField(projection, 'seq', String(own(value, 'seq')), keyPath('seq'));
    setDerivedField(projection, 'payloadType', payloadType, payloadPath);
    return projection;
  }
}

export function isCodexTraceEvent(value: unknown): value is Record<string, unknown> {
  if (!isObject(value)) return false;
  const schemaVersion = own(value, 'schema_version');
  const seq = own(value, 'seq');
  const wallTime = own(value, 'wall_time_unix_ms');
  return Number.isSafeInteger(schemaVersion)
    && Number(schemaVersion) >= 1
    && Number.isSafeInteger(seq)
    && Number(seq) >= 1
    && Number.isSafeInteger(wallTime)
    && typeof own(value, 'rollout_id') === 'string'
    && String(own(value, 'rollout_id')).length > 0
    && isObject(own(value, 'payload'));
}

function actorFor(kind: AgentEventKind): AgentRowProjection['actor'] {
  if (kind === 'message' || kind === 'reasoning' || kind === 'tool_call') return 'assistant';
  if (kind === 'tool_result' || kind === 'observation' || kind === 'result' || kind === 'error') return 'system';
  if (kind === 'subagent') return 'agent';
  return 'system';
}

function timestampFromUnixMillis(value: unknown): string | undefined {
  if (!Number.isSafeInteger(value) || Number(value) < -8_640_000_000_000_000 || Number(value) > 8_640_000_000_000_000) return undefined;
  const date = new Date(Number(value));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
