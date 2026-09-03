import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const addonPath = resolve('native/jsonl-core/jsonl_core.win32-x64-msvc.node');
const require = createRequire(import.meta.url);
const addon = require(addonPath);

if (
  typeof addon.abiVersion !== 'function'
  || typeof addon.capabilities !== 'function'
  || typeof addon.scanLf !== 'function'
) {
  throw new Error(`Native addon does not expose the required ABI: ${addonPath}`);
}
if (addon.abiVersion() !== 2 || (addon.capabilities() & 1) !== 1) {
  throw new Error(`Native addon ABI/capabilities mismatch: ${addonPath}`);
}

const input = Buffer.from('one\ntwo\r\nthree', 'utf8');
const offsets = [...addon.scanLf(input, 0, 8)];
if (offsets.length !== 2 || offsets[0] !== 3 || offsets[1] !== 8) {
  throw new Error(`Native addon newline smoke failed: ${JSON.stringify(offsets)}`);
}

console.log(JSON.stringify({ addonPath, abiVersion: 2, capabilities: 1, offsets }));
