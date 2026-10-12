import { assertProblemPageRequest, type ProblemPageReader, type ProblemPageRequest } from '../ports/problem-page-reader';
import type { ProblemPage } from '../../shared/types';

/** Application boundary for loading one bounded problem page. */
export class LoadProblemPage {
  public constructor(private readonly reader: ProblemPageReader) {}

  public async execute(request: ProblemPageRequest, signal: AbortSignal): Promise<ProblemPage> {
    assertProblemPageRequest(request);
    return this.reader.getProblems(request, signal);
  }
}
