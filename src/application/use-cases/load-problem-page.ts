import { assertProblemPageRequest, type ProblemPageReader, type ProblemPageRequest } from '../ports/problem-page-reader';
import type { ProblemPage } from '../../shared/types';

/** Application boundary for loading one bounded problem page. */
export class LoadProblemPage {
  private readonly reader: ProblemPageReader;

  public constructor(reader: ProblemPageReader) {
    this.reader = reader;
  }

  public async execute(request: ProblemPageRequest, signal: AbortSignal): Promise<ProblemPage> {
    assertProblemPageRequest(request);
    return this.reader.getProblems(request, signal);
  }
}
