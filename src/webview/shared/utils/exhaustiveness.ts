/**
 * Compile-time exhaustiveness sentinel for already-decoded discriminated
 * unions. External JSON must be decoded before this function is reachable.
 */
export function assertNever(value: never, message = 'Unhandled discriminated union member'): never {
  void value;
  throw new Error(message);
}
