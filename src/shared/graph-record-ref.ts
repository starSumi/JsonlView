import { isCurrentRecordRef, type RecordRef } from './contracts/record';

/** Shape/current-generation validation only. Host evidence verification proves the actual indexed location. */
export function copyGraphRecordRef(value: unknown, generation: string | undefined): RecordRef | undefined {
  if (generation === undefined || !isCurrentRecordRef(value, generation)) return undefined;
  return Object.freeze({ ...value });
}
