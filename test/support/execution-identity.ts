import { createHash } from 'node:crypto';
import type { ExecutionIdentity } from '../../src/shared/execution-identity';

const payload: Omit<ExecutionIdentity, 'manifestSha256'> = {
  schemaVersion: 'jsonlview.execution-identity.v1',
  extensionId: 'Sumi-Sophia.jsonl-view',
  extensionVersion: '0.2.11',
  buildMode: 'test',
  compilerMode: 'disabled',
  sourceRevision: '0000000000000000000000000000000000000000',
  sourceState: 'modified',
  buildInputsSha256: '1111111111111111111111111111111111111111111111111111111111111111',
  buildInputCount: 1,
  digestAlgorithm: 'sha256',
  canonicalization: 'jsonlview.sorted-json.v1',
};
const canonical = JSON.stringify(payload, Object.keys(payload).sort());
const TEST_EXECUTION_IDENTITY: ExecutionIdentity = Object.freeze({
  ...payload, manifestSha256: createHash('sha256').update(canonical).digest('hex'),
});

export default TEST_EXECUTION_IDENTITY;
