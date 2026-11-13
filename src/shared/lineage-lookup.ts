import type { RowProjection } from './types';
import { LINEAGE_LOOKUP_MAX_RECORDS, type LineageLookupRelation } from './contracts/lineage';

export {
  LINEAGE_LOOKUP_DEADLINE_MS,
  LINEAGE_LOOKUP_MAX_BYTES,
  LINEAGE_LOOKUP_MAX_RECORDS,
  LINEAGE_LOOKUP_RETAINED_ROWS,
} from './contracts/lineage';
export type { LineageLookupRelation, LineageLookupReply, LineageLookupRequest } from './contracts/lineage';

export function lineageLookupWindow(source: RowProjection, relation: LineageLookupRelation): {
  startOrdinal: string; endOrdinalExclusive: string; recordLimit: number;
} {
  const ordinal = BigInt(source.ref.ordinal);
  const forward = relation === 'tool-partner' && source.profile?.eventKind === 'tool_call';
  const recordLimit = forward ? LINEAGE_LOOKUP_MAX_RECORDS : Number(ordinal < BigInt(LINEAGE_LOOKUP_MAX_RECORDS) ? ordinal : BigInt(LINEAGE_LOOKUP_MAX_RECORDS));
  const start = forward ? ordinal + 1n : ordinal - BigInt(recordLimit);
  return { startOrdinal: String(start), endOrdinalExclusive: String(start + BigInt(recordLimit)), recordLimit };
}
