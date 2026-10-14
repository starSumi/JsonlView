import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JsonlFileEngine } from '../../src/engine';
import { profileColumns, profilePredicateFields } from '../../src/extension/integrated-session-profile';
import { createProfileRegistry } from '../../src/profiles';
import { keyPath, type RowFilter } from '../../src/shared/types';
import { buildRecordQueryRequest } from '../../src/webview/features/record-query';

describe('table filters through the real engine and profile projection', () => {
  it('matches either Event category, then search and every field condition within the source scan', async () => {
    const records = [
      { type: 'response_item', stage: 'prod', allowed: true,
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'needle message' }] } },
      { type: 'response_item', stage: 'prod', allowed: true,
        payload: { type: 'function_call', name: 'needle_tool', call_id: 'synthetic-call', arguments: '{}' } },
      { type: 'response_item', stage: 'prod', allowed: true,
        payload: { type: 'function_call_output', call_id: 'synthetic-call', output: 'needle result' } },
      { type: 'response_item', stage: 'dev', allowed: true,
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'needle excluded stage' }] } },
      { type: 'response_item', stage: 'prod', allowed: true,
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'different message' }] } },
      { type: 'response_item', stage: 'prod', allowed: false,
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'needle excluded permission' }] } },
    ];
    const directory = await mkdtemp(join(tmpdir(), 'jsonl-view-table-composition-'));
    let engine: JsonlFileEngine | undefined;
    try {
      const path = join(directory, 'synthetic.jsonl');
      await writeFile(path, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
      engine = await JsonlFileEngine.open(path, { newlineScanner: 'off' });
      await engine.finishIndexing();
      const registry = createProfileRegistry();
      const profileId = 'codex-rollout';
      const columns = [...profileColumns(profileId)];
      const event = columns.find((column) => column.id === 'eventKind')!;
      const filters: RowFilter[] = [
        { columnId: JSON.stringify(keyPath('stage').tokens), source: 'record', path: keyPath('stage'), operator: 'eq', value: 'prod' },
        { columnId: JSON.stringify(keyPath('allowed').tokens), source: 'record', path: keyPath('allowed'), operator: 'eq', value: true },
      ];
      const request = buildRecordQueryRequest({ limit: 100, query: 'needle', filters, filterColumns: columns,
        rowTypes: { column: event, values: ['message', 'tool_call'] } });
      expect(request.predicate).toMatchObject({ op: 'and', args: expect.arrayContaining([
        { op: 'or', args: [{ op: 'profile_field', field: 'eventKind', cmp: 'eq', value: 'message' },
          { op: 'profile_field', field: 'eventKind', cmp: 'eq', value: 'tool_call' }] },
      ]) });
      const enricher = { profileId, columns,
        project: (value: unknown, ref: Parameters<typeof registry.project>[1]['ref']) =>
          registry.project(profileId, { value, ...(ref === undefined ? {} : { ref }) }, { generation: 'synthetic' }),
        predicateFields: (projection: ReturnType<typeof registry.project> | undefined) =>
          projection === undefined ? {} : profilePredicateFields(projection),
      };
      const result = await engine.getRows({ ...request, enricher });
      expect(result.rows.map((row) => row.ref.ordinal)).toEqual(['0', '1']);
      expect(result.rows.map((row) => row.profile?.eventKind)).toEqual(['message', 'tool_call']);
      expect(result.scan?.truncatedReason).toBeUndefined();
      const limited = await engine.getRows({ ...request, enricher,
        scanBudget: { ...request.scanBudget!, maxExaminedRecords: 1 } });
      expect(limited.rows.map((row) => row.ref.ordinal)).toEqual(['0']);
      expect(limited.scan).toMatchObject({ truncatedReason: 'record_limit' });
    } finally {
      await engine?.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
