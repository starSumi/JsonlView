import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import {
  CAPABILITY_SCAN_LF,
  NATIVE_ABI_VERSION,
  type NativeLoadResult,
  type NativeNewlineBinding,
} from './newline-scanner-types';

let cachedNativeLoad: NativeLoadResult | undefined;

export function loadNativeBinding(candidatesOverride?: readonly string[]): NativeLoadResult {
  if (candidatesOverride === undefined && cachedNativeLoad !== undefined) return cachedNativeLoad;
  const candidates = candidatesOverride ?? nativeCandidates();
  const attempted: string[] = [];
  const loadErrors: string[] = [];
  const runtimeFilename = typeof __filename === 'string'
    ? __filename
    : join(process.cwd(), 'package.json');
  const runtimeRequire = createRequire(runtimeFilename);

  for (const candidate of candidates) {
    const absolute = resolve(candidate);
    if (!existsSync(absolute)) continue;
    attempted.push(absolute);
    try {
      const loaded = runtimeRequire(absolute) as Partial<NativeNewlineBinding>;
      if (
        typeof loaded.abiVersion !== 'function'
        || typeof loaded.capabilities !== 'function'
        || typeof loaded.scanLf !== 'function'
      ) {
        continue;
      }
      const result = { binding: loaded as NativeNewlineBinding, path: absolute };
      if (candidatesOverride === undefined) cachedNativeLoad = result;
      return result;
    } catch (error) {
      loadErrors.push(`${absolute}: ${errorMessage(error)}`);
    }
  }

  const result: NativeLoadResult = {
    reason: loadErrors.length > 0
      ? `unable to load native addon candidates: ${loadErrors.join('; ')}`
      : attempted.length > 0
      ? `native addon did not expose the required ABI: ${attempted.join(', ')}`
      : 'native addon was not found; using the adaptive Node scanner',
  };
  if (candidatesOverride === undefined) cachedNativeLoad = result;
  return result;
}

export function validateNativeContract(binding: NativeNewlineBinding): void {
  const abiVersion = binding.abiVersion();
  if (abiVersion !== NATIVE_ABI_VERSION) {
    throw new Error(`unsupported native ABI ${String(abiVersion)}, expected ${String(NATIVE_ABI_VERSION)}`);
  }
  const capabilities = binding.capabilities();
  if (!Number.isSafeInteger(capabilities) || (capabilities & CAPABILITY_SCAN_LF) === 0) {
    throw new Error(`native capabilities ${String(capabilities)} do not include scanLf`);
  }
}

function nativeCandidates(): string[] {
  const runtimeDirectory = typeof __filename === 'string'
    ? dirname(__filename)
    : undefined;
  if (runtimeDirectory === undefined) return [];
  const roots = [
    resolve(runtimeDirectory, '..', 'native', 'jsonl-core'),
  ];
  const names = [
    'jsonl_core.win32-x64-msvc.node',
    'jsonl-core.win32-x64-msvc.node',
    'jsonl_core.node',
    'jsonl-core.node',
    'index.node',
  ];
  return [...new Set(roots.flatMap((root) => names.map((name) => join(root, name))))];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
