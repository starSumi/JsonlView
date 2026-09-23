import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleInventoryDigest, DISTRIBUTION_FILES } from './bundle-integrity.mjs';

const require = createRequire(import.meta.url);
const yauzl = require('yauzl');
const PREFIX = 'extension/dist/';
const EXPECTED = new Set(DISTRIBUTION_FILES.map((name) => `${PREFIX}${name}`));
const MAX_FILE_BYTES = 32 * 1024 * 1024;

/** Re-hash the complete dist byte set embedded in a finished VSIX. */
export function inventoryEmbeddedVsixBundle(vsixPath) {
  return new Promise((resolveResult, reject) => {
    yauzl.open(resolve(vsixPath), { lazyEntries: true, autoClose: true }, (openError, zipfile) => {
      if (openError || !zipfile) return reject(openError ?? new Error('VSIX archive could not be opened'));
      const files = [];
      const seen = new Set();
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        zipfile.close();
        reject(error);
      };
      zipfile.on('error', fail);
      zipfile.on('end', () => {
        if (settled) return;
        const missing = [...EXPECTED].filter((name) => !seen.has(name));
        if (missing.length > 0) return fail(new Error(`VSIX is missing frozen bundle entries: ${missing.join(', ')}`));
        settled = true;
        files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
        resolveResult({
          files,
          bytes: files.reduce((sum, file) => sum + file.bytes, 0),
          sha256: bundleInventoryDigest(files),
        });
      });
      zipfile.on('entry', (entry) => {
        if (entry.fileName.startsWith(PREFIX) && !EXPECTED.has(entry.fileName)) {
          if (entry.fileName.endsWith('/')) {
            zipfile.readEntry();
            return;
          }
          return fail(new Error(`VSIX contains an unexpected production bundle entry: ${entry.fileName}`));
        }
        if (!EXPECTED.has(entry.fileName)) {
          zipfile.readEntry();
          return;
        }
        if (seen.has(entry.fileName)) return fail(new Error(`VSIX contains duplicate ${entry.fileName} entries`));
        seen.add(entry.fileName);
        if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize <= 0 || entry.uncompressedSize > MAX_FILE_BYTES) {
          return fail(new Error(`VSIX bundle entry size is outside the release boundary: ${entry.fileName}`));
        }
        zipfile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return fail(streamError ?? new Error(`VSIX bundle entry could not be read: ${entry.fileName}`));
          const digest = createHash('sha256');
          let bytes = 0;
          stream.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > MAX_FILE_BYTES) stream.destroy(new Error('VSIX bundle entry exceeded the release boundary'));
            else digest.update(chunk);
          });
          stream.on('error', fail);
          stream.on('end', () => {
            if (settled) return;
            if (bytes !== entry.uncompressedSize) return fail(new Error(`VSIX bundle byte count differs from ZIP entry: ${entry.fileName}`));
            files.push({ path: entry.fileName.slice(PREFIX.length), bytes, sha256: digest.digest('hex') });
            zipfile.readEntry();
          });
        });
      });
      zipfile.readEntry();
    });
  });
}
