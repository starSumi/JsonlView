import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { assertNativeContract, NATIVE_ABI_VERSION, NATIVE_CAPABILITY_SCAN_LF, readNativeContract } from './native-contract.mjs';

const addonPath = resolve(parseAddonPath(process.argv.slice(2)) ?? 'native/jsonl-core/jsonl_core.win32-x64-msvc.node');
if (process.platform !== 'win32' || process.arch !== 'x64') {
  console.log(JSON.stringify({
    addonPath,
    skipped: true,
    reason: 'The committed addon targets win32-x64-msvc; portable CI uses the TypeScript fallback.',
  }));
  process.exit(0);
}
const require = createRequire(import.meta.url);
const addon = require(addonPath);

const contract = readNativeContract(addon);
if (contract === undefined) {
  throw new Error(`Native addon does not expose the required ABI: ${addonPath}`);
}
assertNativeContract(contract);

const input = Buffer.from('one\ntwo\r\nthree', 'utf8');
const offsets = [...addon.scanLf(input, 0, 8)];
if (offsets.length !== 2 || offsets[0] !== 3 || offsets[1] !== 8) {
  throw new Error(`Native addon newline smoke failed: ${JSON.stringify(offsets)}`);
}

console.log(JSON.stringify({ addonPath, abiVersion: NATIVE_ABI_VERSION, capabilities: NATIVE_CAPABILITY_SCAN_LF, offsets }));

function parseAddonPath(args) {
  let addon;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument !== '--addon') throw new Error(`unknown argument: ${argument}`);
    addon = args[++index];
    if (addon === undefined || addon.startsWith('--')) throw new Error('--addon requires a path');
  }
  return addon;
}
