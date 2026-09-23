import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const yauzl = require('yauzl');

export const VSIX_NATIVE_ENTRY = 'extension/native/jsonl-core/jsonl_core.win32-x64-msvc.node';
const MAX_NATIVE_BYTES = 64 * 1024 * 1024;

/** Hash the exact native addon bytes embedded in a finished VSIX archive. */
export function hashEmbeddedVsixNative(vsixPath) {
  return new Promise((resolveResult, reject) => {
    yauzl.open(resolve(vsixPath), { lazyEntries: true, autoClose: true }, (openError, zipfile) => {
      if (openError || !zipfile) {
        reject(openError ?? new Error('VSIX archive could not be opened'));
        return;
      }
      let matched = false;
      let matchedResult;
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
        if (!matched || matchedResult === undefined) {
          fail(new Error(`VSIX is missing ${VSIX_NATIVE_ENTRY}`));
          return;
        }
        settled = true;
        resolveResult(matchedResult);
      });
      zipfile.on('entry', (entry) => {
        if (entry.fileName !== VSIX_NATIVE_ENTRY) {
          zipfile.readEntry();
          return;
        }
        if (matched) {
          fail(new Error(`VSIX contains duplicate ${VSIX_NATIVE_ENTRY} entries`));
          return;
        }
        matched = true;
        if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize <= 0 || entry.uncompressedSize > MAX_NATIVE_BYTES) {
          fail(new Error('VSIX native addon size is outside the release boundary'));
          return;
        }
        zipfile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            fail(streamError ?? new Error('VSIX native addon could not be read'));
            return;
          }
          const digest = createHash('sha256');
          let bytes = 0;
          stream.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > MAX_NATIVE_BYTES) {
              stream.destroy(new Error('VSIX native addon exceeded the release boundary'));
              return;
            }
            digest.update(chunk);
          });
          stream.on('error', fail);
          stream.on('end', () => {
            if (settled) return;
            if (bytes !== entry.uncompressedSize) {
              fail(new Error('VSIX native addon byte count differs from its ZIP entry'));
              return;
            }
            matchedResult = { bytes, sha256: digest.digest('hex'), entry: VSIX_NATIVE_ENTRY };
            // Keep walking the central directory after hashing the expected
            // payload. A later entry with the same path must be rejected;
            // resolving here would silently accept ZIP duplicate ambiguity.
            zipfile.readEntry();
          });
        });
      });
      zipfile.readEntry();
    });
  });
}
