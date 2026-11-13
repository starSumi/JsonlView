import type { RecordRef } from './types.js';

/** Shape/current-generation validation only. Host evidence verification proves the actual indexed location. */
export function copyGraphRecordRef(value: unknown, generation: string | undefined): RecordRef | undefined {
  if (generation === undefined || typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const ref = value as Record<string, unknown>;
  const decimal = (item: unknown): item is string => typeof item === 'string' && item.length <= 64 && /^(?:0|[1-9]\d*)$/u.test(item);
  if (ref.generation !== generation || !decimal(ref.ordinal) || !decimal(ref.byteStart)
    || !decimal(ref.byteEndExclusive) || !decimal(ref.contentByteLength)
    || (ref.delimiterByteLength !== 0 && ref.delimiterByteLength !== 1 && ref.delimiterByteLength !== 2)
    || (ref.parseState !== 'unknown' && ref.parseState !== 'valid' && ref.parseState !== 'invalid_json'
      && ref.parseState !== 'blank' && ref.parseState !== 'encoding_error' && ref.parseState !== 'oversized')) return undefined;
  // Engine byteEndExclusive ends the content; the delimiter is a separate span.
  if (BigInt(ref.byteEndExclusive) - BigInt(ref.byteStart) !== BigInt(ref.contentByteLength)) return undefined;
  return Object.freeze({ generation, ordinal: ref.ordinal, byteStart: ref.byteStart, byteEndExclusive: ref.byteEndExclusive,
    contentByteLength: ref.contentByteLength, delimiterByteLength: ref.delimiterByteLength, parseState: ref.parseState });
}
