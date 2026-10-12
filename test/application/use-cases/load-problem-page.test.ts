import { describe, expect, it, vi } from 'vitest';
import { LoadProblemPage, ProblemPageRequestError, type ProblemPageRequest } from '../../../src/application';
import type { ProblemPage } from '../../../src/shared/types';

const request: ProblemPageRequest = {
  limit: 25,
  anchorOrdinal: '12',
  direction: 'forward',
  scanBudget: { maxExaminedRecords: 100 },
};

const page = {
  items: [],
  anchorOrdinal: '12',
  hasBefore: true,
  hasAfter: false,
  indexedRecords: '100',
  observedProblemRecords: '1',
  complete: true,
  scan: { examinedRecords: '25', examinedBytes: '4096' },
} as ProblemPage;

describe('LoadProblemPage', () => {
  it('delegates the bounded request and cancellation signal to the reader port', async () => {
    const signal = new AbortController().signal;
    const getProblems = vi.fn<(request: ProblemPageRequest, signal: AbortSignal) => Promise<ProblemPage>>()
      .mockResolvedValue(page);
    const useCase = new LoadProblemPage({ getProblems });

    await expect(useCase.execute(request, signal)).resolves.toBe(page);
    expect(getProblems).toHaveBeenCalledOnce();
    expect(getProblems).toHaveBeenCalledWith(request, signal);
  });

  it('rejects invalid bounds before invoking the reader', async () => {
    const getProblems = vi.fn().mockResolvedValue(page);
    const useCase = new LoadProblemPage({ getProblems });
    const invalid: ProblemPageRequest[] = [
      { ...request, limit: 0 },
      { ...request, limit: 201 },
      { ...request, anchorOrdinal: '01' },
      { ...request, direction: 'sideways' } as unknown as ProblemPageRequest,
      { ...request, scanBudget: { maxExaminedRecords: 0 } },
      { ...request, scanBudget: { maxExaminedBytes: 'not-a-number' } },
    ];

    for (const value of invalid) {
      await expect(useCase.execute(value, new AbortController().signal))
        .rejects.toBeInstanceOf(ProblemPageRequestError);
    }
    expect(getProblems).not.toHaveBeenCalled();
  });

  it('preserves reader failures for the transport boundary to classify', async () => {
    const failure = new Error('source changed');
    const useCase = new LoadProblemPage({
      getProblems: vi.fn().mockRejectedValue(failure),
    });

    await expect(useCase.execute(request, new AbortController().signal)).rejects.toBe(failure);
  });
});
