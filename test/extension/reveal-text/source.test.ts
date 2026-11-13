import { describe, expect, it, vi } from 'vitest';
import { createRevealTextReadPort, type RevealTextSource } from '../../../src/extension/reveal-text/source';
import type { RevealTextReferenceInput } from '../../../src/extension/reveal-text/provider';
import type { RecordRef } from '../../../src/shared/types';
vi.mock('vscode', () => ({}));

const ref: RecordRef = { generation: 'g1', ordinal: '2', byteStart: '10', byteEndExclusive: '20', contentByteLength: '9', delimiterByteLength: 1, parseState: 'valid' };
const reference: RevealTextReferenceInput = { sourceId: 'document', generation: 'g1', ordinal: '2', ref };
function source() {
  const value: RevealTextSource = {
    isAuthorized: () => true,
    session: {
      getSummary: () => ({ snapshot: { documentId: 'document', generation: 'g1' } }),
      validateObservedSource: async () => true,
      getRecordText: vi.fn(async () => ({ sourceGeneration: 'g1', text: 'exact', complete: true })),
    },
  };
  return value;
}
describe('production record-text source port', () => {
  it('binds host document identity and uses a bounded read with the exact record coordinates', async () => {
    const current = source();
    const port = createRevealTextReadPort((id) => id === 'document' ? current : undefined);
    await expect(port.authorize(reference)).resolves.toEqual({ authorized: true, generation: 'g1' });
    await expect(port.read(reference, 100)).resolves.toMatchObject({ text: 'exact' });
    expect(current.session.getRecordText).toHaveBeenCalledWith(ref, 100);
  });
  it('refuses unknown documents, revoked sources, absent refs and ref identity substitution', async () => {
    const current = source();
    const port = createRevealTextReadPort(() => current);
    for (const input of [{ ...reference, sourceId: 'other' }, { sourceId: 'document', generation: 'g1', ordinal: '2' }, { ...reference, ref: { ...ref, generation: 'g2' } }]) {
      await expect(port.authorize(input)).resolves.toMatchObject({ authorized: false });
    }
    current.isAuthorized = () => false;
    await expect(port.read(reference, 100)).rejects.toMatchObject({ code: 'unauthorized' });
    expect(current.session.getRecordText).not.toHaveBeenCalled();
  });
  it('checks current source bytes before reading rather than trusting a cached generation', async () => {
    const current = source();
    current.session.validateObservedSource = async () => false;
    const port = createRevealTextReadPort(() => current);
    await expect(port.authorize(reference)).resolves.toMatchObject({ authorized: false });
    await expect(port.read(reference, 100)).rejects.toMatchObject({ code: 'unauthorized' });
    expect(current.session.getRecordText).not.toHaveBeenCalled();
  });
  it('rechecks lifecycle after an async probe and after a source read', async () => {
    const current = source();
    let authorized = true;
    current.isAuthorized = () => authorized;
    current.session.getRecordText = vi.fn(async () => { authorized = false; return { sourceGeneration: 'g1', text: 'private', complete: true }; });
    const port = createRevealTextReadPort(() => current);
    await expect(port.read(reference, 100)).rejects.toMatchObject({ code: 'unauthorized' });
  });
});
