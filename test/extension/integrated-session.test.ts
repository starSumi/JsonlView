import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  IntegratedJsonlSession,
  type IntegratedSessionOptions,
} from '../../src/extension/integrated-session';
import {
  otelFixture,
  softwareEngineeringAgentFixture,
  structuredApplicationLogFixture,
} from '../profiles/fixtures';

const directories: string[] = [];
const sessions: IntegratedJsonlSession[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map(async (session) => session.dispose()));
  await Promise.all(directories.splice(0).map(async (directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

async function openFixture(
  records: readonly unknown[],
  options: Partial<Omit<IntegratedSessionOptions, 'uri'>> = {},
): Promise<{
  path: string;
  session: IntegratedJsonlSession;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'jsonl-view-session-'));
  directories.push(directory);
  const path = join(directory, 'rollout.jsonl');
  await writeFile(path, records.map((record) => JSON.stringify(record)).join('\n'));
  const session = await IntegratedJsonlSession.open(path, {
    uri: new URL(`file:///${path.replaceAll('\\', '/')}`).toString(),
    backgroundIndexing: false,
    ...options,
  });
  sessions.push(session);
  return { path, session };
}

const codexRecords = [
  { timestamp: '2026-08-30T00:00:00Z', type: 'session_meta', payload: { id: 'session-1' } },
  { timestamp: '2026-08-30T00:00:01Z', type: 'turn_context', payload: { turn_id: 'turn-1' } },
  { timestamp: '2026-08-30T00:00:02Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'hello' } },
  { timestamp: '2026-08-30T00:00:03Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 4, output_tokens: 2 } } } },
];

describe('IntegratedJsonlSession', () => {
  it('returns a generic shell before deferred profile detection publishes the semantic profile', async () => {
    const { session } = await openFixture(codexRecords, { deferProfileDetection: true });
    expect(session.getSummary().profileId).toBe('generic');

    const updates: string[] = [];
    const removeListener = session.onProgress((summary) => updates.push(summary.profileId));
    const firstPage = await session.getRows({ limit: 20 }, new AbortController().signal);
    expect(firstPage.rows).toHaveLength(codexRecords.length);
    expect(firstPage.rows.every((row) => row.profile?.profileId === 'generic')).toBe(true);

    await waitFor(() => session.getSummary().profileId === 'codex-rollout');
    removeListener();
    expect(updates).toContain('codex-rollout');
    expect(session.getProfileColumns().map((column) => column.id)).toEqual([
      'eventKind', 'timestamp', 'actor', 'summary', 'status', 'model',
    ]);
  });

  it('does not let deferred detection override an explicit profile selection', async () => {
    const { session } = await openFixture(codexRecords, { deferProfileDetection: true });
    await session.setProfile('generic-agent-events', new AbortController().signal);
    await session.getRows({ limit: 20 }, new AbortController().signal);

    await waitFor(() => session.getSummary().profileSuggestions.some((suggestion) => suggestion.score > 0));
    expect(session.getSummary().profileId).toBe('generic-agent-events');
  });

  it('detects Codex content and enriches rows without replacing raw projections', async () => {
    const { session } = await openFixture(codexRecords);
    expect(session.getSummary().profileId).toBe('codex-rollout');

    const page = await session.getRows({ limit: 20 }, new AbortController().signal);
    expect(page.rows).toHaveLength(codexRecords.length);
    expect(page.columns.slice(0, 6).map((column) => column.id)).toEqual([
      'eventKind', 'timestamp', 'actor', 'summary', 'status', 'model',
    ]);
    expect(page.columns.some((column) => column.id === '$ordinal')).toBe(false);
    expect(page.rows.map((row) => row.profile?.profileId)).toEqual([
      'codex-rollout', 'codex-rollout', 'codex-rollout', 'codex-rollout',
    ]);
    expect(page.rows[2]?.cells.find((cell) => cell.columnId === 'summary')?.value).toBe('assistant message: hello');
    expect(page.rows.every((row) => row.genericSummary.length > 0)).toBe(true);
  });

  it.each([
    {
      profileId: 'opentelemetry',
      records: otelFixture,
      row: 0,
      expectedColumns: ['eventKind', 'timestamp', 'severity', 'summary', 'service'],
      columnId: 'service',
      value: 'checkout-service',
    },
    {
      profileId: 'software-engineering-agent',
      records: softwareEngineeringAgentFixture,
      row: 1,
      expectedColumns: ['eventKind', 'summary', 'task', 'step', 'tool', 'status'],
      columnId: 'tool',
      value: 'shell',
    },
    {
      profileId: 'structured-application-log',
      records: structuredApplicationLogFixture,
      row: 0,
      expectedColumns: ['timestamp', 'severity', 'summary', 'service', 'logger'],
      columnId: 'logger',
      value: 'api',
    },
  ])('projects bounded $profileId semantic columns into RowPage cells', async ({
    profileId,
    records,
    row,
    expectedColumns,
    columnId,
    value,
  }) => {
    const { session } = await openFixture(records);
    await session.setProfile(profileId, new AbortController().signal);

    const page = await session.getRows({ limit: 20 }, new AbortController().signal);

    expect(page.columns.map((column) => column.id)).toEqual(expectedColumns);
    expect(page.rows[row]?.cells.find((cell) => cell.columnId === columnId)?.value).toBe(value);
  });

  it('preserves an explicit profile across a new source generation', async () => {
    const { path, session } = await openFixture(codexRecords);
    await session.setProfile('generic', new AbortController().signal);
    const previousGeneration = session.getSummary().snapshot.generation;
    await appendFile(path, '\n' + JSON.stringify({ type: 'future_record', payload: { value: 1 } }));

    expect(await session.classifyRefresh()).toMatchObject({ kind: 'append' });
    const rebuilt = await session.rebuild(new AbortController().signal);

    expect(rebuilt.snapshot.generation).not.toBe(previousGeneration);
    expect(rebuilt.profileId).toBe('generic');
    const page = await session.getRows({ limit: 20 }, new AbortController().signal);
    expect(page.rows).toHaveLength(codexRecords.length + 1);
  });

  it('computes bounded insights only when explicitly requested', async () => {
    const { session } = await openFixture(codexRecords);

    const insights = await session.getInsights('eventKind', undefined, new AbortController().signal);

    expect(insights.processedRecords).toBe('4');
    expect(insights.examinedRecords).toBe('4');
    expect(Number(insights.examinedBytes)).toBeGreaterThan(0);
    expect(insights.categories).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'session', count: 1 }),
      expect.objectContaining({ label: 'message', count: 1 }),
      expect.objectContaining({ label: 'usage', count: 1 }),
    ]));
    expect(insights.timeBuckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(4);
    expect(insights.truncated).toBe(false);
  });

  it('stops zero-match insights at the physical record budget', async () => {
    const records = Array.from({ length: 20 }, (_, id) => ({ id, message: `record-${String(id)}` }));
    const { session } = await openFixture(records, {
      insightsMaxExaminedRecords: 3,
      insightsMaxExaminedBytes: 1_048_576,
      insightsMaxMilliseconds: 60_000,
    });

    const insights = await session.getInsights('eventKind', {
      op: 'text_search',
      value: 'never-present',
      caseSensitive: false,
    }, new AbortController().signal);

    expect(insights).toMatchObject({
      processedRecords: '0',
      examinedRecords: '3',
      truncated: true,
      truncatedReason: 'record_limit',
    });
    expect(Number(insights.examinedBytes)).toBeGreaterThan(0);
  });

  it('rejects unknown profile ids and supports disabling auto-detection', async () => {
    const { path, session } = await openFixture(codexRecords);
    await expect(session.setProfile('missing', new AbortController().signal)).rejects.toThrow(/Unknown Agent profile/);

    const generic = await IntegratedJsonlSession.open(path, {
      uri: 'file:///rollout.jsonl',
      autoDetectProfiles: false,
      backgroundIndexing: false,
    });
    sessions.push(generic);
    expect(generic.getSummary().profileId).toBe('generic');
    expect(generic.getSummary().profileSuggestions.map((profile) => profile.id)).toEqual([
      'codex-rollout',
      'claude-code-session',
      'generic-agent-events',
      'opentelemetry',
      'software-engineering-agent',
      'structured-application-log',
    ]);
  });

  it('keeps the old engine and profile state when a rebuild is already cancelled', async () => {
    const { path, session } = await openFixture(codexRecords);
    await session.setProfile('generic-agent-events', new AbortController().signal);
    const before = session.getSummary();
    await appendFile(path, '\n' + JSON.stringify({ event: 'message', role: 'assistant', message: 'new' }));
    const controller = new AbortController();
    controller.abort();

    await expect(session.rebuild(controller.signal)).rejects.toThrow(/cancel/i);

    const after = session.getSummary();
    expect(after.snapshot.generation).toBe(before.snapshot.generation);
    expect(after.profileId).toBe(before.profileId);
    expect(after.profileSuggestions).toEqual(before.profileSuggestions);
  });

  it('does not let one caller cancel a shared rebuild for another caller', async () => {
    const { path, session } = await openFixture(codexRecords);
    await appendFile(path, '\n' + JSON.stringify({ type: 'future_record', payload: {} }));
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = session.rebuild(firstController.signal);
    const second = session.rebuild(secondController.signal);
    secondController.abort();

    await expect(second).rejects.toThrow(/cancel/i);
    await expect(first).resolves.toMatchObject({ indexedRecords: expect.any(String) });
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for deferred profile detection.');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
