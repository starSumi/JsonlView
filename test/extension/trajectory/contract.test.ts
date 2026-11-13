import { describe, expect, it } from 'vitest';
import { matchesTrajectory, measureTrajectoryResult, parseTrajectoryRequest, TRAJECTORY_REQUEST_SCHEMA, TRAJECTORY_RESULT_SCHEMA, trajectoryError, type TrajectorySliceResult } from '../../../src/shared/contracts/trajectory-slice';
import { canonicalJson, createTrajectoryCursor, parseTrajectoryCursor, trajectoryQueryHash } from '../../../src/extension/trajectory/cursor';

const request = { schema: TRAJECTORY_REQUEST_SCHEMA, requestId: 'req', sourceId: 'source', predicate: { actor: 'tool', hasError: false } };
describe('trajectory slice v1 contract', () => {
  it('normalizes documented defaults and retains false', () => {
    expect(parseTrajectoryRequest(request)).toEqual({ ...request, limit: 50, maxOutputBytes: 262144, maxExaminedBytes: 8388608, deadlineMs: 5000 });
  });
  it.each([{ ...request, path: '/private' }, { ...request, predicate: {} }, { ...request, predicate: { actor: 'developer' } },
    { ...request, predicate: { hasError: null } }, { ...request, predicate: { actor: undefined } }, { ...request, limit: 129 },
    { ...request, maxExaminedBytes: 1023 }, { ...request, deadlineMs: Infinity }, { ...request, cursor: 'padded=' },
    { ...request, requestId: '\ud800' }])('rejects unsupported input (%#)', (input) => { expect(parseTrajectoryRequest(input)).toBeUndefined(); });
  it('keeps AND and unknown semantics independent', () => {
    const predicate = { actor: 'tool' as const, hasError: false };
    expect(matchesTrajectory({ actor: 'tool', hasError: false }, predicate)).toBe(true);
    expect(matchesTrajectory({ actor: 'tool', hasError: null }, predicate)).toBe(false);
    expect(matchesTrajectory({ actor: 'unknown', hasError: false }, predicate)).toBe(false);
    expect(matchesTrajectory({ actor: 'assistant', hasError: false }, predicate)).toBe(false);
  });
  it('measures compact UTF8 with zero slot and also reports actual bytes', () => {
    const value: TrajectorySliceResult = { schema: TRAJECTORY_RESULT_SCHEMA, requestId: 'req', status: 'partial', sourceId: 'source',
      profile: { id: 'generic-agent-events', version: '1' }, snapshot: { id: 'hash', guarantee: 'observed-metadata' },
      records: [{ ordinal: '0', byteStart: '0', byteEnd: '17', actor: 'tool', hasError: false, text: '中文🧪' }],
      usage: { examinedBytes: '17', examinedRecords: 1, returnedBytes: 0 }, reason: 'record_limit', cursor: 'abc' };
    const measured = measureTrajectoryResult(value);
    const wire = JSON.parse(measured.json);
    expect(measured.byteLength).toBe(Buffer.byteLength(measured.json));
    const bytes = wire.usage.returnedBytes;
    wire.usage.returnedBytes = 0;
    expect(bytes).toBe(Buffer.byteLength(JSON.stringify(wire)));
    expect(measured.byteLength).toBeGreaterThan(bytes);
  });
  it('separates safe error branch and fixed recoverability', () => {
    expect(trajectoryError('req', 'SOURCE_NOT_AUTHORIZED')).toEqual({ schema: TRAJECTORY_RESULT_SCHEMA, requestId: 'req', status: 'error', error: { code: 'SOURCE_NOT_AUTHORIZED', recoverable: false } });
    expect(trajectoryError('req', 'BUDGET_TOO_SMALL')).toMatchObject({ error: { recoverable: true } });
  });
});

describe('trajectory cursor canonicalization', () => {
  const data = { sourceId: 'source', snapshotId: 'snapshot', queryHash: trajectoryQueryHash({ actor: 'tool', hasError: false }, 'profile', '1'), nextOrdinal: '18446744073709551615', expiresAtMs: 123456 };
  it('roundtrips all fields and rejects unknown/duplicate/noncanonical inputs', () => {
    const token = createTrajectoryCursor(data);
    const json = Buffer.from(token, 'base64url').toString('utf8');
    expect(parseTrajectoryCursor(token)).toEqual({ v: 1, ...data });
    for (const invalid of [token + '=', Buffer.from(` ${json}`).toString('base64url'),
      Buffer.from(json.replace('"v":1', '"v":1,"v":1')).toString('base64url'),
      Buffer.from(json.replace('"v":1', '"v":1,"byteOffset":"0"')).toString('base64url'),
      Buffer.from(json.replace('123456', '1.23456e5')).toString('base64url')]) expect(parseTrajectoryCursor(invalid)).toBeUndefined();
  });
  it('uses query/profile semantics rather than predicate insertion order', () => {
    expect(trajectoryQueryHash({ actor: 'tool', hasError: false }, 'p', '1')).toBe(trajectoryQueryHash({ hasError: false, actor: 'tool' }, 'p', '1'));
    expect(trajectoryQueryHash({ actor: 'tool' }, 'p', '1')).not.toBe(trajectoryQueryHash({ actor: 'tool' }, 'p', '2'));
  });
  it('follows UTF16 property ordering, ECMAScript numbers and I-JSON Unicode', () => {
    expect(canonicalJson({ '\u20ac': 1, '\r': 2, '😀': 3, '1': 4 })).toBe('{"\\r":2,"1":4,"€":1,"😀":3}');
    expect(canonicalJson({ n: -0, values: [1e30, 0.000001] })).toBe('{"n":0,"values":[1e+30,0.000001]}');
    expect(() => canonicalJson({ s: '\ud800' })).toThrow();
    expect(() => canonicalJson(NaN)).toThrow();
  });
});
