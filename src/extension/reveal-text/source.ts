import type { RecordRef } from '@shared/types';
import { RevealTextRefusal, type RevealTextReadPort, type RevealTextReadResult, type RevealTextReferenceInput } from './provider';

/** Only an already-open host document can grant this adapter read access. */
export interface RevealTextSource {
  isAuthorized: () => boolean;
  session: {
    getSummary(): { snapshot: { documentId: string; generation: string } };
    validateObservedSource(): Promise<boolean>;
    getRecordText(ref: RecordRef, maxBytes: number): Promise<RevealTextReadResult>;
  };
}

export function createRevealTextReadPort(resolve: (sourceId: string) => RevealTextSource | undefined): RevealTextReadPort {
  const current = (input: RevealTextReferenceInput): RevealTextSource | undefined => {
    const source = resolve(input.sourceId);
    if (source === undefined || !source.isAuthorized() || input.ref === undefined
      || input.ref.generation !== input.generation || input.ref.ordinal !== input.ordinal) return undefined;
    const snapshot = source.session.getSummary().snapshot;
    return snapshot.documentId === input.sourceId && snapshot.generation === input.generation ? source : undefined;
  };
  const authorize: RevealTextReadPort['authorize'] = async (input) => {
    const source = current(input);
    if (source === undefined) return { authorized: false, generation: '' };
    const unchanged = await source.session.validateObservedSource();
    const latest = current(input);
    return { authorized: latest?.session === source.session && unchanged,
      generation: source.session.getSummary().snapshot.generation };
  };
  return {
    authorize,
    async read(input, maxBytes) {
      const before = await authorize(input);
      const source = current(input);
      if (!before.authorized || source === undefined || input.ref === undefined) throw new RevealTextRefusal('unauthorized');
      const result = await source.session.getRecordText(input.ref, maxBytes);
      if (current(input)?.session !== source.session) throw new RevealTextRefusal('unauthorized');
      return result;
    },
  };
}
