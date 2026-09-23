// Keep the JavaScript-side probes on the same ABI contract as the Rust addon.
// The TypeScript scanner has a matching constant because it is compiled into
// the extension; changing the ABI requires updating all three surfaces.
export const NATIVE_ABI_VERSION = 2;
export const NATIVE_CAPABILITY_SCAN_LF = 1 << 0;

export function readNativeContract(binding) {
  if (
    typeof binding?.abiVersion !== 'function'
    || typeof binding?.capabilities !== 'function'
    || typeof binding?.scanLf !== 'function'
  ) {
    return undefined;
  }
  return {
    abiVersion: binding.abiVersion(),
    capabilities: binding.capabilities(),
  };
}

export function assertNativeContract(contract) {
  if (
    contract?.abiVersion !== NATIVE_ABI_VERSION
    || !Number.isSafeInteger(contract?.capabilities)
    || (contract.capabilities & NATIVE_CAPABILITY_SCAN_LF) === 0
  ) {
    throw new Error(`native ABI/capabilities mismatch: ${JSON.stringify(contract)}`);
  }
}
