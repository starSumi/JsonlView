import { describe, expect, it } from 'vitest';
import type {
  InternalRecordRef,
  SegmentIndexDiagnostics,
  SegmentIndexOptions,
  SegmentLocation,
} from '../../src/engine/segment-index-types';
import type {
  InternalRecordRef as LegacyInternalRecordRef,
  SegmentIndexDiagnostics as LegacySegmentIndexDiagnostics,
  SegmentIndexOptions as LegacySegmentIndexOptions,
  SegmentLocation as LegacySegmentLocation,
} from '../../src/engine/segment-index';

function acceptsLegacyContracts(
  ref: LegacyInternalRecordRef,
  diagnostics: LegacySegmentIndexDiagnostics,
  options: LegacySegmentIndexOptions,
  location: LegacySegmentLocation,
): [InternalRecordRef, SegmentIndexDiagnostics, SegmentIndexOptions, SegmentLocation] {
  return [ref, diagnostics, options, location];
}

describe('segment index contract extraction', () => {
  it('keeps the facade exports structurally identical to the extracted contracts', () => {
    const ref = {
      ordinal: 0n,
      byteStart: 0n,
      byteEndExclusive: 1n,
      contentByteLength: 1n,
      delimiterByteLength: 1 as const,
      parseState: 'unknown' as const,
    } satisfies InternalRecordRef;
    const diagnostics = {
      segmentCount: 1,
      exactCachedSegments: 1,
      pendingExactRecords: 0,
      indexedBytes: '1',
      indexedRecords: '1',
      complete: true,
      newlineScanner: {
        requestedMode: 'node' as const,
        activeMode: 'node' as const,
        maxScanBytes: 256 * 1024,
      },
    } satisfies SegmentIndexDiagnostics;
    const options = {
      readChunkBytes: 256,
      segmentTargetBytes: 1024,
      segmentTargetRecords: 16,
      exactCacheSegments: 1,
      maxRecordBytes: 1024,
      newlineScanner: { scan: () => ({ count: 0, forEach: () => undefined }), diagnostics: () => diagnostics.newlineScanner },
      validateSnapshot: async () => undefined,
    } satisfies SegmentIndexOptions;
    const location = { segmentId: 0, localIndex: 0, segmentCapacity: 16 } satisfies SegmentLocation;

    const [legacyRef, legacyDiagnostics, legacyOptions, legacyLocation] = acceptsLegacyContracts(
      ref,
      diagnostics,
      options,
      location,
    );
    expect(legacyRef.byteStart).toBe(0n);
    expect(legacyDiagnostics.indexedRecords).toBe('1');
    expect(legacyOptions.segmentTargetRecords).toBe(16);
    expect(legacyLocation.segmentCapacity).toBe(16);
  });
});
