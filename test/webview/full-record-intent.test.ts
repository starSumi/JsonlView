import { describe, expect, it } from 'vitest';
import type { RecordDetail } from '../../src/shared/types';
import {
  AUTOMATIC_FULL_RECORD_LIMIT_BYTES,
  shouldAutomaticallyHydrateSelectedRecord,
} from '../../src/webview/full-record-intent';

function oversizedDetail(contentByteLength: string, rawComplete = false): RecordDetail {
  return {
    ref: {
      generation: 'generation-1',
      ordinal: '7',
      byteStart: '0',
      byteEndExclusive: contentByteLength,
      contentByteLength,
      delimiterByteLength: 1,
      parseState: 'oversized',
    },
    rawPreview: '{"payload":"preview"}',
    rawComplete,
    problems: [],
  };
}

describe('selected-record full hydration intent', () => {
  it('automatically hydrates only the selected oversized record within the automatic byte ceiling', () => {
    const detail = oversizedDetail(String(AUTOMATIC_FULL_RECORD_LIMIT_BYTES));

    expect(shouldAutomaticallyHydrateSelectedRecord(detail, '7', true, false)).toBe(true);
    expect(shouldAutomaticallyHydrateSelectedRecord(
      oversizedDetail(String(AUTOMATIC_FULL_RECORD_LIMIT_BYTES + 1)),
      '7',
      true,
      false,
    )).toBe(false);
  });

  it('does not infer full intent without an open, idle, matching detail selection', () => {
    const detail = oversizedDetail('128');

    expect(shouldAutomaticallyHydrateSelectedRecord(detail, undefined, true, false)).toBe(false);
    expect(shouldAutomaticallyHydrateSelectedRecord(detail, '8', true, false)).toBe(false);
    expect(shouldAutomaticallyHydrateSelectedRecord(detail, '7', false, false)).toBe(false);
    expect(shouldAutomaticallyHydrateSelectedRecord(detail, '7', true, true)).toBe(false);
  });

  it('does not repeat automatic hydration for complete, non-oversized, or malformed details', () => {
    const detail = oversizedDetail('128');

    expect(shouldAutomaticallyHydrateSelectedRecord(oversizedDetail('128', true), '7', true, false)).toBe(false);
    expect(shouldAutomaticallyHydrateSelectedRecord({
      ...detail,
      ref: { ...detail.ref, parseState: 'valid' },
    }, '7', true, false)).toBe(false);
    expect(shouldAutomaticallyHydrateSelectedRecord(oversizedDetail('not-a-byte-count'), '7', true, false)).toBe(false);
  });
});
