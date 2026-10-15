import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatasetDetectionReceipt } from '../../src/extension/integrated-session';

vi.mock('vscode', () => ({}));
import { JsonlViewDocument, JsonlViewProvider } from '../../src/extension/extension';

afterEach(() => { vi.restoreAllMocks(); });

describe('dataset detection output receipt', () => {
  it('correlates bounded detection metadata with the document trace and omits source identity', async () => {
    const output: string[] = [];
    const document = { session: { getSummary: () => ({ indexedBytes: '0', indexedRecords: '0', indexingComplete: true }) } };
    let emit: ((receipt: DatasetDetectionReceipt) => void) | undefined;
    vi.spyOn(JsonlViewDocument, 'create').mockImplementation(async (_uri, _token, _indexFailure, onDatasetDetection) => {
      emit = onDatasetDetection;
      return document as never;
    });
    const provider = new JsonlViewProvider(
      { extensionUri: {} } as never, {} as never, async () => undefined,
      { appendLine: (line: string) => { output.push(line); } },
    );
    await provider.openCustomDocument({ fsPath: '/private-source.jsonl' } as never, {} as never, {
      isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }),
    } as never);
    emit?.({ operationId: 2, generation: 'private-generation', sourceEpoch: 3, profileEpoch: 4,
      stage: 'head-hydration', status: 'timeout', code: 'deadline_exceeded', elapsedMs: 5000 });
    const receipt = output.find((line) => line.includes('[dataset-detection]'));
    expect(receipt).toContain('trace=1 operation=2 status=timeout stage=head-hydration sourceEpoch=3 profileEpoch=4 elapsedMs=5000 code=deadline_exceeded');
    expect(output.join(' ')).not.toMatch(/private-source|private-generation/);
    expect(output.filter((line) => line.includes('[dataset-detection]'))).toHaveLength(1);
  });
});
