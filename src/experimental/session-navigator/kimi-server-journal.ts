import { lstatSync, readdirSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { isMetadataRecord, type MetadataBudget, metadataText } from './provider-metadata';
import { SessionSourceChangedError } from './provider-errors';

const MAX_ENTRIES = 4_096;
const MAX_DIRECTORY_ENTRIES = 16_384;
const PREFIX_BYTES = 16 * 1_024;
const TAIL_BYTES = 48 * 1_024;
const MAX_PROMPT_PARTS = 16;
const SESSION_STATUSES = new Set(['idle', 'running', 'awaiting_approval', 'awaiting_question', 'aborted', 'completed', 'cancelled', 'failed']);

export interface KimiServerJournalEntry {
  readonly kind: 'server';
  readonly sessionKey: string;
  readonly journalSessionId: string;
  readonly agentId: 'main';
  readonly relativePath: string;
  readonly journalPath: string;
  readonly activityMs: number;
  readonly signature: string;
  readonly identity: Stats;
}

export function isKimiServerSourceRoot(path: string): boolean {
  const regular = (candidate: string): boolean => {
    try { const value = lstatSync(candidate); return value.isDirectory() && !value.isSymbolicLink(); } catch { return false; }
  };
  if (!regular(path)) return false;
  const child = join(path, 'events');
  if (regular(child) && hasSessionJournal(child)) return true;
  const parent = join(path, '..');
  return basename(path).toLowerCase() === 'events' && basename(parent).toLowerCase() === 'server' && regular(parent) && hasSessionJournal(path);
}

export async function resolveKimiServerEvents(root: string, includeHomeLayout = false): Promise<string | undefined> {
  if (await regularDirectory(join(root, 'sessions'))) {
    if (!includeHomeLayout) return undefined;
    const homeServerEvents = join(root, 'server', 'events');
    return await regularDirectory(homeServerEvents) ? homeServerEvents : undefined;
  }
  const child = join(root, 'events');
  if (await regularDirectory(child)) return child;
  return basename(root).toLowerCase() === 'events' && basename(join(root, '..')).toLowerCase() === 'server' ? root : undefined;
}

export async function inventoryKimiServerJournals(root: string, events: string, budget: MetadataBudget): Promise<{ entries: KimiServerJournalEntry[]; partial: boolean }> {
  const entries: KimiServerJournalEntry[] = [];
  let partial = false;
  let seen = 0;
  if (!budget.check()) return { entries, partial: true };
  if (!(await regularDirectory(events))) return { entries, partial: true };
  try {
    const directory = await opendir(events);
    for await (const item of directory) {
      if (!budget.check() || ++seen > MAX_DIRECTORY_ENTRIES) { partial = true; break; }
      if (!item.isFile() || item.isSymbolicLink() || !item.name.startsWith('session_') || !item.name.endsWith('.jsonl') || item.name.length <= 'session_.jsonl'.length) continue;
      if (entries.length >= MAX_ENTRIES) { partial = true; break; }
      const journalPath = join(events, item.name);
      const identity = await regularFile(journalPath);
      if (identity === undefined) { partial = true; continue; }
      const relativePath = relative(root, journalPath).replaceAll('\\', '/');
      const journalSessionId = basename(item.name, '.jsonl');
      entries.push({ kind: 'server', sessionKey: journalSessionId, journalSessionId, agentId: 'main', relativePath, journalPath, activityMs: identity.mtimeMs, identity,
        signature: 'server\0' + relativePath + '\0' + identityKey(identity) });
    }
  } catch { budget.check(); partial = true; }
  return { entries, partial: partial || budget.truncated };
}

export async function readKimiServerMetadata(entry: KimiServerJournalEntry, budget: MetadataBudget): Promise<{ state: Record<string, unknown>; partial: boolean }> {
  if (!budget.available()) return { state: {}, partial: true };
  const current = await regularFile(entry.journalPath);
  if (current === undefined || !sameIdentity(current, entry.identity)) throw new SessionSourceChangedError();
  const file = await open(entry.journalPath, 'r').catch((error: unknown) => {
    if (isMetadataRecord(error) && (error.code === 'ENOENT' || error.code === 'ELOOP')) throw new SessionSourceChangedError();
    budget.check();
    return undefined;
  });
  if (file === undefined) return { state: {}, partial: true };
  try {
    const before = await file.stat();
    if (!sameIdentity(before, entry.identity)) throw new SessionSourceChangedError();
    const remainingBytes = Math.max(0, budget.limits.maxBytes - budget.bytes);
    const total = Math.min(before.size, PREFIX_BYTES + TAIL_BYTES, remainingBytes);
    const prefix = before.size <= total ? total : Math.min(PREFIX_BYTES, Math.ceil(total / 4));
    const ranges = [{ offset: 0, length: prefix }, ...(before.size > total && total > prefix ? [{ offset: before.size - (total - prefix), length: total - prefix }] : [])];
    const lines: string[] = [];
    for (const range of ranges) {
      if (!budget.check() || range.length === 0) break;
      const buffer = Buffer.alloc(range.length);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, range.offset);
      budget.bytes += bytesRead;
      let text = buffer.subarray(0, bytesRead).toString('utf8');
      if (range.offset > 0) text = text.slice(text.indexOf('\n') < 0 ? text.length : text.indexOf('\n') + 1);
      if (range.offset + bytesRead < before.size) text = text.slice(0, Math.max(0, text.lastIndexOf('\n')));
      for (const line of text.split('\n')) if (line.trim().length > 0) lines.push(line);
    }
    const after = await file.stat();
    const pathAfter = await regularFile(entry.journalPath);
    if (!sameIdentity(before, after) || pathAfter === undefined || !sameIdentity(before, pathAfter)) throw new SessionSourceChangedError();
    const allowance = Math.max(0, budget.limits.maxRecords - budget.records);
    const selected = lines.length <= allowance ? lines : allowance === 0 ? [] : [lines[0]!, ...(allowance > 1 ? lines.slice(-(allowance - 1)) : [])];
    const state: Record<string, unknown> = {};
    const parsed: Array<Record<string, unknown> | undefined> = [];
    let latestHeaderIndex = -1;
    let partial = total < before.size || selected.length < lines.length;
    for (const line of selected) {
      if (!budget.check()) { partial = true; break; }
      budget.records += 1;
      let value: unknown;
      try { value = JSON.parse(line); } catch { partial = true; parsed.push(undefined); continue; }
      if (!isMetadataRecord(value)) { partial = true; parsed.push(undefined); continue; }
      parsed.push(value);
      if (isJournalHeader(value)) latestHeaderIndex = parsed.length - 1;
    }
    const validHeader = latestHeaderIndex >= 0;
    if (validHeader) {
      const header = parsed[latestHeaderIndex]!;
      if (validClock(header.created_at) !== undefined) state.createdAt = header.created_at;
      for (let index = latestHeaderIndex + 1; index < parsed.length; index += 1) {
        const record = parsed[index];
        if (record === undefined) continue;
        if (!applyJournalMetadata(state, record, entry.journalSessionId)) partial = true;
      }
    }
    return { state, partial: partial || !validHeader || budget.truncated };
  } finally { await file.close(); }
}

function applyJournalMetadata(state: Record<string, unknown>, record: Record<string, unknown>, sessionKey: string): boolean {
  const envelope = isMetadataRecord(record.envelope) ? record.envelope : undefined;
  if (record.kind !== 'event' || typeof record.seq !== 'number' || !Number.isSafeInteger(record.seq) || record.seq <= 0 || envelope === undefined
      || typeof envelope.seq !== 'number' || !Number.isSafeInteger(envelope.seq) || envelope.seq <= 0 || envelope.seq !== record.seq || typeof envelope.type !== 'string') return false;
  if (envelope.volatile !== undefined && typeof envelope.volatile !== 'boolean') return false;
  if (envelope.offset !== undefined && (typeof envelope.offset !== 'number' || !Number.isSafeInteger(envelope.offset) || envelope.offset < 0)) return false;
  if (envelope.session_id !== undefined && envelope.session_id !== sessionKey) return false;
  const clock = validClock(envelope.timestamp);
  if (clock !== undefined) state.updatedAt = clock;
  const payload = isMetadataRecord(envelope.payload) ? envelope.payload : undefined;
  if (payload === undefined) return true;
  switch (envelope.type) {
    case 'event.session.created': {
      const session = isMetadataRecord(payload.session) ? payload.session : undefined;
      if (session === undefined) return false;
      copyText(state, 'title', session.title, 160);
      copyText(state, 'lastPrompt', session.last_prompt, 240);
      if (validClock(session.created_at) !== undefined) state.createdAt = session.created_at;
      if (clock === undefined && validClock(session.updated_at) !== undefined) state.updatedAt = session.updated_at;
      setStatus(state, session.status);
      setStatus(state, session.last_turn_reason);
      if (typeof session.busy === 'boolean') state.status = session.busy ? 'running' : 'idle';
      break;
    }
    case 'session.meta.updated': {
      const patch = isMetadataRecord(payload.patch) ? payload.patch : {};
      copyText(state, 'title', patch.title ?? payload.title, 160);
      copyText(state, 'lastPrompt', patch.lastPrompt, 240);
      if (typeof patch.isCustomTitle === 'boolean') state.isCustomTitle = patch.isCustomTitle;
      break;
    }
    case 'prompt.submitted':
      if (payload.agentId === undefined || payload.agentId === 'main') copyText(state, 'lastPrompt', promptPreview(payload.content), 240);
      break;
    case 'event.session.status_changed': setStatus(state, payload.status); break;
    case 'event.session.work_changed':
      if (typeof payload.busy === 'boolean') state.status = payload.busy ? 'running' : 'idle';
      setStatus(state, payload.last_turn_reason);
      if (payload.pending_interaction === 'approval') state.status = 'awaiting_approval';
      else if (payload.pending_interaction === 'question') state.status = 'awaiting_question';
      break;
    case 'turn.ended': setStatus(state, payload.reason); break;
  }
  return true;
}

function isJournalHeader(value: Record<string, unknown>): boolean {
  return value.kind === 'journal_header' && value.version === 1 && typeof value.epoch === 'string' && value.epoch.length > 0;
}

function promptPreview(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  let text = '';
  for (let index = 0; index < Math.min(content.length, MAX_PROMPT_PARTS) && text.length < 240; index += 1) {
    const part = content[index];
    if (isMetadataRecord(part) && part.type === 'text' && typeof part.text === 'string') text += (text ? ' ' : '') + part.text.slice(0, 240 - text.length);
  }
  return text || undefined;
}

function setStatus(state: Record<string, unknown>, value: unknown): void { if (typeof value === 'string' && SESSION_STATUSES.has(value)) state.status = value; }
function copyText(state: Record<string, unknown>, key: string, value: unknown, limit: number): void { if (typeof value === 'string') state[key] = metadataText(value.slice(0, limit * 4), limit) ?? ''; }
function validClock(value: unknown): string | undefined {
  const milliseconds = typeof value === 'number' ? value : typeof value === 'string' && value.length <= 64 ? Date.parse(value) : Number.NaN;
  return Number.isFinite(milliseconds) && Math.abs(milliseconds) <= 8.64e15 ? new Date(milliseconds).toISOString() : undefined;
}
function identityKey(value: Stats): string { return [value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs].join('\0'); }
function sameIdentity(left: Stats, right: Stats): boolean { return identityKey(left) === identityKey(right); }
function hasSessionJournal(events: string): boolean {
  try {
    return readdirSync(events, { withFileTypes: true }).some((entry) => entry.isFile() && !entry.isSymbolicLink()
      && entry.name.startsWith('session_') && entry.name.endsWith('.jsonl') && entry.name.length > 'session_.jsonl'.length);
  } catch { return false; }
}
async function regularDirectory(path: string): Promise<boolean> { const value = await lstat(path).catch(() => undefined); return value?.isDirectory() === true && !value.isSymbolicLink(); }
async function regularFile(path: string): Promise<Stats | undefined> { const value = await lstat(path).catch(() => undefined); return value?.isFile() === true && !value.isSymbolicLink() ? value : undefined; }
