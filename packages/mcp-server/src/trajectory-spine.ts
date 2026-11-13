import { trajectoryError } from './contracts/trajectory-slice.js';
import {
  measureTrajectorySpineResult, parseTrajectorySpineRequest, serializeTrajectorySpineResult,
  TRAJECTORY_SPINE_REQUEST_SCHEMA, TRAJECTORY_SPINE_RESULT_SCHEMA,
  type TrajectorySpineRequest, type TrajectorySpineResult,
} from './contracts/trajectory-spine.js';
import type { TrajectorySliceQuery, TrajectoryScanPage } from './trajectory-slice-query.js';

export {
  measureTrajectorySpineResult, parseTrajectorySpineRequest, serializeTrajectorySpineResult,
  TRAJECTORY_SPINE_REQUEST_SCHEMA, TRAJECTORY_SPINE_RESULT_SCHEMA,
  type TrajectorySpineRequest, type TrajectorySpineResult,
} from './contracts/trajectory-spine.js';

/** Same independent byte/time/count caps; no public slice predicate is fabricated. */
export async function queryTrajectorySpine(query: TrajectorySliceQuery, request: TrajectorySpineRequest, signal?: AbortSignal): Promise<TrajectorySpineResult> {
  const page = await query.scan(request, { predicate: null, measure: (candidate) => measureTrajectorySpineResult(spineResult(candidate)).byteLength }, signal);
  if (page.status === 'error') {
    const error = trajectoryError(request.requestId, page.code);
    if (error.status !== 'error') throw new Error('Expected trajectory error.');
    return { ...error, schema: TRAJECTORY_SPINE_RESULT_SCHEMA };
  }
  return measureTrajectorySpineResult(spineResult(page)).result;
}

function spineResult(page: TrajectoryScanPage): TrajectorySpineResult {
  return { schema: TRAJECTORY_SPINE_RESULT_SCHEMA, requestId: page.requestId, sourceId: page.sourceId, status: page.status,
    profile: page.profile, snapshot: page.snapshot, entries: page.records, omitted: page.omitted, usage: page.usage,
    ...(page.status === 'partial' ? { reason: page.reason, cursor: page.cursor } : {}) };
}
