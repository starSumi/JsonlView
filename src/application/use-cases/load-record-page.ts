import { assertRecordPageRequest, type RecordPageReader, type RecordPageRequest } from '../ports/record-page-reader';
import type { RowPage } from '../../shared/types';

/** Application boundary for loading one bounded record page. */
export class LoadRecordPage {
  public constructor(private readonly reader: RecordPageReader) {}

  public async execute(request: RecordPageRequest, signal: AbortSignal): Promise<RowPage> {
    assertRecordPageRequest(request);
    return this.reader.getRows(request, signal);
  }
}
