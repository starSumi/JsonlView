import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const environmentDirectory = process.env.JSONLVIEW_ARTIFACT_DIR?.trim();
const defaultDirectory = resolve(tmpdir(), 'jsonlview-artifacts');

/**
 * Keeps generated benchmark and acceptance evidence outside a source workspace.
 * Callers may provide JSONLVIEW_ARTIFACT_DIR when a persistent location is needed.
 */
export function artifactDirectory(...segments) {
  return resolve(environmentDirectory || defaultDirectory, ...segments);
}
