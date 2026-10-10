import { open } from 'node:fs/promises';
import type { SessionNavigatorBudget } from './types';

/** Shared scan accounting: only bytes actually read and records inspected consume it. */
export class MetadataBudget {
  public bytes = 0;
  public records = 0;
  public truncated = false;
  public constructor(public readonly limits: SessionNavigatorBudget, public readonly signal: AbortSignal, private readonly started = Date.now()) {}
  public check(): boolean {
    if (this.signal.aborted) throw new Error('Session navigator scan cancelled.');
    if (Date.now() - this.started >= this.limits.maxMilliseconds) this.truncated = true;
    return !this.truncated;
  }
  public available(): boolean {
    if (this.bytes >= this.limits.maxBytes || this.records >= this.limits.maxRecords) this.truncated = true;
    return this.check();
  }
}

/** Sample complete JSONL records at both ends; never load a transcript wholesale. */
export async function readMetadataRecords(path: string, budget: MetadataBudget, prefixBytes = 96 * 1024, tailBytes = 64 * 1024): Promise<{ values: Record<string, unknown>[]; sampled: boolean }> {
  const values: Record<string, unknown>[] = [];
  let recordSampling = false;
  if (!budget.available()) return { values, sampled: true };
  const file = await open(path, 'r');
  try {
    const size = (await file.stat()).size;
    const remaining = Math.max(0, budget.limits.maxBytes - budget.bytes);
    const total = Math.min(size, prefixBytes + tailBytes, remaining);
    const prefix = size <= total ? total : Math.min(prefixBytes, Math.ceil(total * prefixBytes / (prefixBytes + tailBytes)));
    const tail = size <= total ? 0 : total - prefix;
    const ranges = [{ offset: 0, length: prefix }, ...(tail > 0 ? [{ offset: size - tail, length: tail }] : [])].filter((range) => range.length > 0);
    for (const range of ranges) {
      if (!budget.check()) break;
      const buffer = Buffer.alloc(range.length);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, range.offset);
      budget.bytes += bytesRead;
      let text = buffer.subarray(0, bytesRead).toString('utf8');
      // The first/last fragments can be part of a giant record or an active append.
      if (range.offset > 0) text = text.slice(text.indexOf('\n') < 0 ? text.length : text.indexOf('\n') + 1);
      if (range.offset + bytesRead < size) text = text.slice(0, Math.max(0, text.lastIndexOf('\n')));
      const lines = text.split(/\r?\n/u).filter((line) => line.trim().length > 0);
      const remainingRecords = Math.max(0, budget.limits.maxRecords - budget.records);
      // Preserve space for late provider title records when the prefix has many
      // tiny records, and prefer the newest entries when sampling a title index.
      const allowance = range.offset === 0 && ranges.length > 1 ? Math.ceil(remainingRecords / 2) : remainingRecords;
      recordSampling ||= lines.length > allowance;
      const selected = allowance === 0 ? [] : range.offset > 0 ? lines.slice(-allowance) : lines.slice(0, allowance);
      for (const line of selected) {
        if (!budget.check() || budget.records >= budget.limits.maxRecords) { budget.truncated = true; break; }
        budget.records += 1;
        try { const value: unknown = JSON.parse(line); if (isMetadataRecord(value)) values.push(value); } catch { /* Ignore partial/malformed metadata without consuming transcript bodies. */ }
      }
    }
    if (recordSampling && budget.records >= budget.limits.maxRecords) budget.truncated = true;
    return { values, sampled: total < size || recordSampling };
  } finally { await file.close(); }
}

export function isMetadataRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
export function firstMetadataString(...values: unknown[]): string | undefined { return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0); }
export function metadataText(value: string | undefined, limit = 160): string | undefined {
  const text = value?.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
  return text ? text.slice(0, limit) : undefined;
}
export function userMessagePreview(value: Record<string, unknown>): string | undefined {
  if (value.isMeta === true || value.isCompactSummary === true) return undefined;
  const payload = isMetadataRecord(value.payload) ? value.payload : value;
  const message = isMetadataRecord(payload.message) ? payload.message : payload;
  if (message.role !== 'user' && payload.type !== 'user' && payload.type !== 'user_message') return undefined;
  const content = message.content ?? payload.message;
  const text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter(isMetadataRecord).filter((part) => part.type === 'text' || part.type === 'input_text').map((part) => firstMetadataString(part.text) ?? '').join(' ')
    : undefined;
  if (text === undefined || /^\s*(?:# AGENTS\.md instructions|<environment_context>|<permissions instructions>|<local-command|<command-name>|<system-reminder>)/u.test(text)) return undefined;
  return metadataText(text, 240);
}
