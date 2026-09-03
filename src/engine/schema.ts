import {
  displayFieldPath,
  type FieldPath,
  type FieldStats,
  type JsonKind,
  type PathToken,
} from '../shared/types';
import { jsonKindOf } from './predicate';

interface MutableFieldStats {
  path: FieldPath;
  displayPath: string;
  seenRecords: bigint;
  kinds: Map<JsonKind, bigint>;
  nullRecords: bigint;
  examples: string[];
  firstSeenOrdinal: bigint;
  lastSeenOrdinal: bigint;
}

export interface SchemaTrackerOptions {
  maxFields: number;
  maxDepth: number;
  maxArrayEntries: number;
  maxExamples: number;
  exampleCharacters: number;
}

export class ProgressiveSchemaTracker {
  private readonly fields = new Map<string, MutableFieldStats>();
  private readonly observedSegments = new Map<number, Uint8Array>();
  private observedRecords = 0n;
  private validRecords = 0n;
  private problemRecords = 0n;

  constructor(private readonly options: SchemaTrackerOptions) {}

  get observedRecordCount(): bigint {
    return this.observedRecords;
  }

  get validRecordCount(): bigint {
    return this.validRecords;
  }

  get problemRecordCount(): bigint {
    return this.problemRecords;
  }

  observe(
    segmentId: number,
    localIndex: number,
    segmentCapacity: number,
    ordinal: bigint,
    state: 'valid' | 'problem',
    value?: unknown,
  ): boolean {
    let bits = this.observedSegments.get(segmentId);
    if (bits === undefined) {
      bits = new Uint8Array(Math.max(1, segmentCapacity));
      this.observedSegments.set(segmentId, bits);
    } else if (localIndex >= bits.length) {
      const grown = new Uint8Array(Math.max(localIndex + 1, segmentCapacity));
      grown.set(bits);
      bits = grown;
      this.observedSegments.set(segmentId, bits);
    }

    if (bits[localIndex] === 1) return false;
    bits[localIndex] = 1;
    this.observedRecords += 1n;

    if (state === 'problem') {
      this.problemRecords += 1n;
      return true;
    }

    this.validRecords += 1n;
    this.visit(value, { tokens: [] }, 0, ordinal);
    return true;
  }

  page(
    offset: number,
    limit: number,
    indexingComplete: boolean,
    totalRecords?: bigint,
  ): { fields: FieldStats[]; totalFields: number; complete: boolean } {
    const complete = indexingComplete
      && totalRecords !== undefined
      && this.observedRecords === totalRecords;
    const ordered = [...this.fields.values()]
      .sort((left, right) => left.displayPath.localeCompare(right.displayPath));
    const fields = ordered.slice(offset, offset + limit).map((field): FieldStats => ({
      path: field.path,
      displayPath: field.displayPath,
      seenRecords: field.seenRecords.toString(),
      validRecordsObserved: this.validRecords.toString(),
      kinds: Object.fromEntries(
        [...field.kinds].map(([kind, count]) => [kind, count.toString()]),
      ) as Partial<Record<JsonKind, string>>,
      missingRecords: (this.validRecords - field.seenRecords).toString(),
      nullRecords: field.nullRecords.toString(),
      examples: [...field.examples],
      firstSeenOrdinal: field.firstSeenOrdinal.toString(),
      lastSeenOrdinal: field.lastSeenOrdinal.toString(),
      confidence: complete ? 'complete' : 'sampled',
    }));

    return { fields, totalFields: ordered.length, complete };
  }

  suggestedPaths(limit: number): FieldPath[] {
    const candidates = [...this.fields.values()]
      .filter((field) => field.path.tokens.length === 1 && field.path.tokens[0]?.kind === 'key')
      .sort((left, right) => {
        if (left.seenRecords !== right.seenRecords) {
          return left.seenRecords > right.seenRecords ? -1 : 1;
        }
        return left.displayPath.localeCompare(right.displayPath);
      })
      .slice(0, limit)
      .map((field) => field.path);

    if (candidates.length > 0) return candidates;
    const root = this.fields.get('[]');
    return root === undefined ? [] : [root.path];
  }

  private visit(value: unknown, path: FieldPath, depth: number, ordinal: bigint): void {
    this.record(path, value, ordinal);
    if (depth >= this.options.maxDepth || this.fields.size >= this.options.maxFields) return;

    if (Array.isArray(value)) {
      for (let index = 0; index < Math.min(value.length, this.options.maxArrayEntries); index += 1) {
        const token: PathToken = { kind: 'index', value: index };
        this.visit(value[index], { tokens: [...path.tokens, token] }, depth + 1, ordinal);
        if (this.fields.size >= this.options.maxFields) return;
      }
      return;
    }

    if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const token: PathToken = { kind: 'key', value: key };
        this.visit(child, { tokens: [...path.tokens, token] }, depth + 1, ordinal);
        if (this.fields.size >= this.options.maxFields) return;
      }
    }
  }

  private record(path: FieldPath, value: unknown, ordinal: bigint): void {
    const key = JSON.stringify(path.tokens);
    let field = this.fields.get(key);
    if (field === undefined) {
      if (this.fields.size >= this.options.maxFields) return;
      field = {
        path,
        displayPath: displayFieldPath(path),
        seenRecords: 0n,
        kinds: new Map(),
        nullRecords: 0n,
        examples: [],
        firstSeenOrdinal: ordinal,
        lastSeenOrdinal: ordinal,
      };
      this.fields.set(key, field);
    }

    const kind = jsonKindOf(value);
    field.seenRecords += 1n;
    field.kinds.set(kind, (field.kinds.get(kind) ?? 0n) + 1n);
    if (value === null) field.nullRecords += 1n;
    field.lastSeenOrdinal = ordinal;

    if (field.examples.length < this.options.maxExamples) {
      const example = previewValue(value, this.options.exampleCharacters);
      if (!field.examples.includes(example)) field.examples.push(example);
    }
  }
}

function previewValue(value: unknown, maxCharacters: number): string {
  let rendered: string;
  if (typeof value === 'string') rendered = value;
  else if (value === undefined) rendered = 'undefined';
  else {
    try {
      rendered = JSON.stringify(value);
    } catch {
      rendered = String(value);
    }
  }
  return rendered.length <= maxCharacters
    ? rendered
    : `${rendered.slice(0, Math.max(0, maxCharacters - 1))}\u2026`;
}
