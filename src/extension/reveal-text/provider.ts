import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { RecordRef } from '@shared/types';

export const REVEAL_TEXT_SCHEME = 'jsonlview-reveal-text';

/** Whole-string VS Code documents are bounded to 1 MiB each and 4 MiB total. */
export const REVEAL_TEXT_LIMITS = Object.freeze({
  maxReferences: 20,
  maxRecordBytes: 1_048_576,
  maxTotalOutputBytes: 4_194_304,
});

export type RevealTextRefusalCode =
  | 'invalid-reference'
  | 'reference-limit'
  | 'invalid-uri'
  | 'reference-unavailable'
  | 'unauthorized'
  | 'stale-generation'
  | 'source-changed'
  | 'content-incomplete'
  | 'record-limit'
  | 'output-limit'
  | 'cancelled'
  | 'read-failed'
  | 'disposed';

const REFUSAL_MESSAGES: Readonly<Record<RevealTextRefusalCode, string>> = Object.freeze({
  'invalid-reference': 'The read-only text reference is invalid.',
  'reference-limit': 'The read-only text reference limit has been reached.',
  'invalid-uri': 'The read-only text document URI is invalid.',
  'reference-unavailable': 'The read-only text reference has been released or is unavailable.',
  unauthorized: 'The source is no longer authorized for reading.',
  'stale-generation': 'The source generation changed before the text could be read.',
  'source-changed': 'The source changed while the text was being read.',
  'content-incomplete': 'The complete record is unavailable; partial text was not opened.',
  'record-limit': 'The record exceeds the 1 MiB read-only document limit.',
  'output-limit': 'The 4 MiB read-only text output budget has been reached.',
  cancelled: 'The read-only text request was cancelled.',
  'read-failed': 'The complete read-only text could not be verified.',
  disposed: 'The read-only text provider has been disposed.',
});

export class RevealTextRefusal extends Error {
  public readonly code: RevealTextRefusalCode;

  public constructor(code: RevealTextRefusalCode) {
    super(REFUSAL_MESSAGES[code]);
    this.name = 'RevealTextRefusal';
    this.code = code;
  }
}

export interface RevealTextReferenceInput {
  readonly sourceId: string;
  readonly generation: string;
  readonly ordinal: string;
  /** Production adapters require exact host-validated coordinates; never encoded in the URI. */
  readonly ref?: RecordRef;
}

export interface RevealTextAuthorization {
  readonly authorized: boolean;
  readonly generation: string;
}

export interface RevealTextReadResult {
  /** Generation observed by the bounded source reader for this exact read. */
  readonly sourceGeneration: string;
  /** Complete record text only; partial results are rejected by the provider. */
  readonly text: string;
  readonly complete: boolean;
}

export interface RevealTextReadPort {
  /** Re-checks both authorization and the current source generation. */
  authorize(reference: RevealTextReferenceInput): Promise<RevealTextAuthorization>;
  /** Must stop at maxBytes and report incomplete content rather than truncate silently. */
  read(reference: RevealTextReferenceInput, maxBytes: number): Promise<RevealTextReadResult>;
}

interface StoredReference {
  readonly id: string;
  readonly uriGeneration: string;
  readonly source: RevealTextReferenceInput;
}

interface ParsedUri {
  readonly id: string;
  readonly uriGeneration: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const ORDINAL_PATTERN = /^(?:0|[1-9][0-9]{0,63})$/u;

/**
 * Extension-host-local, read-only text documents addressed only by a random
 * reference ID and random URI-generation token. The source identity and record
 * locator stay in memory. Closing a matching VS Code document releases it; the
 * explicit release method is available to other lifecycle owners as well.
 */
export class RevealTextDocumentContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  readonly #references = new Map<string, StoredReference>();
  readonly #source: RevealTextReadPort;
  readonly #closeRegistration: vscode.Disposable;
  #outputBytes = 0;
  #disposed = false;
  #readQueue: Promise<void> = Promise.resolve();

  public constructor(source: RevealTextReadPort) {
    this.#source = source;
    this.#closeRegistration = vscode.workspace.onDidCloseTextDocument((document) => {
      if (document.uri.scheme === REVEAL_TEXT_SCHEME) this.release(document.uri);
    });
  }

  public get referenceCount(): number { return this.#references.size; }
  public get outputBytes(): number { return this.#outputBytes; }

  /** Register one source record without putting source data into the URI. */
  public register(input: RevealTextReferenceInput): vscode.Uri {
    if (this.#disposed) throw new RevealTextRefusal('disposed');
    if (!this.isValidReference(input)) throw new RevealTextRefusal('invalid-reference');
    if (this.#references.size >= REVEAL_TEXT_LIMITS.maxReferences) throw new RevealTextRefusal('reference-limit');

    const id = randomUUID();
    const uriGeneration = randomUUID();
    const reference: StoredReference = Object.freeze({
      id,
      uriGeneration,
      source: Object.freeze({ sourceId: input.sourceId, generation: input.generation, ordinal: input.ordinal,
        ...(input.ref === undefined ? {} : { ref: Object.freeze({ ...input.ref }) }) }),
    });
    this.#references.set(id, reference);
    try {
      return vscode.Uri.from({
        scheme: REVEAL_TEXT_SCHEME,
        authority: '',
        path: `/${id}`,
        query: `g=${uriGeneration}`,
        fragment: '',
      });
    } catch {
      this.#references.delete(id);
      throw new RevealTextRefusal('read-failed');
    }
  }

  /** Release the exact ID and generation pair; forged or stale URIs release nothing. */
  public release(uri: vscode.Uri): boolean {
    const parsed = this.parseUri(uri);
    if (parsed === undefined) return false;
    const reference = this.#references.get(parsed.id);
    if (reference === undefined || reference.uriGeneration !== parsed.uriGeneration) return false;
    return this.#references.delete(parsed.id);
  }

  public provideTextDocumentContent(uri: vscode.Uri, token: vscode.CancellationToken): Promise<string> {
    const parsed = this.parseUri(uri);
    if (parsed === undefined) return Promise.reject(new RevealTextRefusal('invalid-uri'));

    const read = this.#readQueue.then(() => this.readCompleteRecord(parsed, token));
    this.#readQueue = read.then(() => undefined, () => undefined);
    return read;
  }

  public dispose(): void {
    this.#disposed = true;
    this.#closeRegistration.dispose();
    this.#references.clear();
    this.#outputBytes = 0;
  }

  private isValidReference(input: RevealTextReferenceInput): boolean {
    return typeof input.sourceId === 'string' && input.sourceId.length > 0 && input.sourceId.length <= 256
      && typeof input.generation === 'string' && input.generation.length > 0 && input.generation.length <= 128
      && typeof input.ordinal === 'string' && ORDINAL_PATTERN.test(input.ordinal);
  }

  private parseUri(uri: vscode.Uri): ParsedUri | undefined {
    if (uri.scheme !== REVEAL_TEXT_SCHEME || uri.authority !== '' || uri.fragment !== '') return undefined;
    const path = /^\/([0-9a-f-]{36})$/u.exec(uri.path);
    const query = /^g=([0-9a-f-]{36})$/u.exec(uri.query);
    const id = path?.[1];
    const uriGeneration = query?.[1];
    if (id === undefined || !UUID_PATTERN.test(id) || uriGeneration === undefined || !UUID_PATTERN.test(uriGeneration)) return undefined;
    return { id, uriGeneration };
  }

  private isCurrent(reference: StoredReference): boolean {
    return !this.#disposed && this.#references.get(reference.id) === reference;
  }

  private ensureCurrent(reference: StoredReference, token: vscode.CancellationToken): void {
    if (this.#disposed) throw new RevealTextRefusal('disposed');
    if (!this.isCurrent(reference)) throw new RevealTextRefusal('reference-unavailable');
    if (token.isCancellationRequested) throw new RevealTextRefusal('cancelled');
  }

  private async readCompleteRecord(parsed: ParsedUri, token: vscode.CancellationToken): Promise<string> {
    if (this.#disposed) throw new RevealTextRefusal('disposed');
    const reference = this.#references.get(parsed.id);
    if (reference === undefined || reference.uriGeneration !== parsed.uriGeneration) {
      throw new RevealTextRefusal('reference-unavailable');
    }
    this.ensureCurrent(reference, token);

    try {
      const before = await this.#source.authorize(reference.source);
      this.ensureCurrent(reference, token);
      if (!before.authorized) throw new RevealTextRefusal('unauthorized');
      if (before.generation !== reference.source.generation) throw new RevealTextRefusal('stale-generation');

      const result = await this.#source.read(reference.source, REVEAL_TEXT_LIMITS.maxRecordBytes);
      this.ensureCurrent(reference, token);
      if (result.sourceGeneration !== reference.source.generation) throw new RevealTextRefusal('source-changed');
      if (result.complete !== true || typeof result.text !== 'string') throw new RevealTextRefusal('content-incomplete');

      // Check UTF-16 code units first so a huge string is refused without a full UTF-8 scan.
      if (result.text.length > REVEAL_TEXT_LIMITS.maxRecordBytes) throw new RevealTextRefusal('record-limit');
      const bytes = Buffer.byteLength(result.text, 'utf8');
      if (bytes > REVEAL_TEXT_LIMITS.maxRecordBytes) throw new RevealTextRefusal('record-limit');

      const after = await this.#source.authorize(reference.source);
      this.ensureCurrent(reference, token);
      if (!after.authorized) throw new RevealTextRefusal('unauthorized');
      if (after.generation !== reference.source.generation) throw new RevealTextRefusal('source-changed');
      if (this.#outputBytes + bytes > REVEAL_TEXT_LIMITS.maxTotalOutputBytes) throw new RevealTextRefusal('output-limit');

      this.#outputBytes += bytes;
      return result.text;
    } catch (error) {
      if (error instanceof RevealTextRefusal) throw error;
      throw new RevealTextRefusal('read-failed');
    }
  }
}
