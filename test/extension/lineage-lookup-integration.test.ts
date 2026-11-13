import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { IntegratedJsonlSession } from '../../src/extension/integrated-session/integrated-session';

const directories: string[] = []; const sessions: IntegratedJsonlSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.dispose()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
function message(id: string, parent?: string, sessionId = 'synthetic-session') {
  return { type: 'assistant', uuid: id, ...(parent === undefined ? {} : { parentUuid: parent }), sessionId,
    timestamp: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: [{ type: 'text', text: `Synthetic ${id}` }] } };
}
async function fixture(records: readonly unknown[]) {
  const directory = await mkdtemp(join(tmpdir(), 'jsonl-lineage-integration-')); directories.push(directory);
  const path = join(directory, 'synthetic.jsonl');
  // The target field deliberately has legal whitespace that defeats a compact JSON substring needle.
  const text = records.map((record) => JSON.stringify(record).replaceAll(':', ': ')).join('\r\n');
  await writeFile(path, text);
  const session = await IntegratedJsonlSession.open(path, { uri: pathToFileURL(path).href, backgroundIndexing: false, autoDetectProfiles: false, newlineScanner: 'off' });
  sessions.push(session); await session.setProfile('claude-code-session', new AbortController().signal);
  const page = await session.getRows({ limit: 500 }, new AbortController().signal);
  return { path, text, session, page };
}
describe('portable bounded lookup through the real indexed session', () => {
  it('finds a preceding out-of-page parent using parsed identity, preserves the full physical ref and source bytes', async () => {
    const f = await fixture([message('target'), ...Array.from({ length: 25 }, (_, n) => message(`noise-${n}`)), message('selected', 'target')]);
    const source = f.page.rows.at(-1)!;
    const before = createHash('sha256').update(await readFile(f.path)).digest('hex');
    const reply = await f.session.lookupLineage(source, 'parent', new AbortController().signal);
    expect(reply.status).toBe('found'); expect(reply.match?.ref).toEqual(f.page.rows[0]!.ref);
    expect(reply.scope.examinedRecords).toBe(26); expect(reply.scope.requestedBytes).toBeGreaterThan(0);
    expect(reply.scope.requestedBytes).toBeLessThanOrEqual(1_048_576);
    expect(createHash('sha256').update(await readFile(f.path)).digest('hex')).toBe(before);
  });
  it('reports duplicate same-context identities as ambiguous and a different session as unobserved', async () => {
    const duplicate = await fixture([message('target'), message('target'), message('selected', 'target')]);
    expect((await duplicate.session.lookupLineage(duplicate.page.rows.at(-1)!, 'parent', new AbortController().signal)).status).toBe('ambiguous');
    const other = await fixture([message('target', undefined, 'other-session'), message('selected', 'target')]);
    expect((await other.session.lookupLineage(other.page.rows.at(-1)!, 'parent', new AbortController().signal)).status).toBe('not-observed');
  });
  it('stops before hydrating an over-quota record and never claims a completed empty search', async () => {
    const f = await fixture([{ type: 'attachment', uuid: 'large', sessionId: 'synthetic-session', attachment: { type: 'text', text: 'x'.repeat(1_100_000) } }, message('selected', 'missing')]);
    const source = f.page.rows.find((row) => row.profile?.messageId === 'selected')!;
    const reply = await f.session.lookupLineage(source, 'parent', new AbortController().signal);
    expect(reply.status).toBe('budget-exceeded'); expect(reply.scope.complete).toBe(false); expect(reply.match).toBeUndefined();
    expect(reply.scope.requestedBytes).toBeLessThanOrEqual(1_048_576);
  });
  it('treats uninspectable JSON and an edited source as incomplete, and keeps cancellation distinct', async () => {
    const f = await fixture([message('target'), message('selected', 'target')]);
    const source = f.page.rows.at(-1)!;
    const abort = new AbortController(); abort.abort();
    await expect(f.session.lookupLineage(source, 'parent', abort.signal)).rejects.toThrow('cancelled');
    await writeFile(f.path, f.text + '\r\n{}');
    expect((await f.session.lookupLineage(source, 'parent', new AbortController().signal)).status).toBe('stale');
  });
});
