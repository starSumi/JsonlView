export const INTAKE_PROTOCOL_VERSION = 1 as const;
export const SOURCE_INTAKE_MAX_BYTES = 1_048_576 as const;
export const SOURCE_INTAKE_MAX_RECORDS = 10_000 as const;
export const SOURCE_INTAKE_MAX_SOURCES = 32 as const;
export const SOURCE_INTAKE_MAX_URI_LENGTH = 8_192 as const;
export const SOURCE_INTAKE_MAX_URI_LIST_CHARS = 65_536 as const;
export const INTAKE_STATUS_MAX_TEXT_LENGTH = 4_096 as const;

/** Shared filename guard for Host authorization and generated intake views. */
export const JSONL_EXTENSION_PATTERN: RegExp = /\.(jsonl|ndjson)$/iu;
export const JSONL_EXTENSION_PATTERN_SOURCE: string = String.raw`\.(jsonl|ndjson)$`;

export function hasJsonlExtension(value: string): boolean {
  return JSONL_EXTENSION_PATTERN.test(value.split(/[?#]/u, 1)[0] ?? '');
}

export type IntakeMessage =
  | { readonly intakeProtocolVersion: typeof INTAKE_PROTOCOL_VERSION; readonly type: 'import-jsonl'; readonly text: string }
  | { readonly intakeProtocolVersion: typeof INTAKE_PROTOCOL_VERSION; readonly type: 'preview-uris'; readonly uris: readonly [string] }
  | { readonly intakeProtocolVersion: typeof INTAKE_PROTOCOL_VERSION; readonly type: 'webview-diagnostic'; readonly name: string; readonly message: string };

export type IntakeMessageValidation =
  | { readonly ok: true; readonly message: IntakeMessage }
  | { readonly ok: false; readonly error: 'unsupported-version' | 'oversized' | 'invalid' };

export type SourceDropMessage =
  | { readonly intakeProtocolVersion: typeof INTAKE_PROTOCOL_VERSION; readonly type: 'pick-files' | 'pick-folder' }
  | { readonly intakeProtocolVersion: typeof INTAKE_PROTOCOL_VERSION; readonly type: 'preview-uris'; readonly uris: readonly [string] }
  | { readonly intakeProtocolVersion: typeof INTAKE_PROTOCOL_VERSION; readonly type: 'import-jsonl'; readonly text: string };

export type IntakeStatusState = 'busy' | 'idle' | 'success' | 'error';

/** Host-to-Webview terminal or progress status for the two source-intake panels. */
export interface IntakeStatusReply {
  readonly intakeProtocolVersion: typeof INTAKE_PROTOCOL_VERSION;
  readonly type: 'status';
  readonly state: IntakeStatusState;
  readonly text: string;
  readonly clearText?: boolean;
}

/** Host-to-Webview focus command for the reusable Paste panel. */
export interface IntakeFocusMessage {
  readonly intakeProtocolVersion: typeof INTAKE_PROTOCOL_VERSION;
  readonly type: 'focus';
}

export function createIntakeFocusMessage(): IntakeFocusMessage {
  return { intakeProtocolVersion: INTAKE_PROTOCOL_VERSION, type: 'focus' };
}

export function isIntakeFocusMessage(value: unknown): value is IntakeFocusMessage {
  return isRecord(value)
    && value.intakeProtocolVersion === INTAKE_PROTOCOL_VERSION
    && value.type === 'focus'
    && hasOnlyKeys(value, ['intakeProtocolVersion', 'type']);
}

export function createIntakeStatusReply(state: IntakeStatusState, text: string, clearText = false): IntakeStatusReply {
  return {
    intakeProtocolVersion: INTAKE_PROTOCOL_VERSION,
    type: 'status',
    state,
    text: text.slice(0, INTAKE_STATUS_MAX_TEXT_LENGTH),
    ...(clearText ? { clearText: true } : {}),
  };
}

/** Pure version, state, and field-shape guard for Host-to-Webview status replies. */
export function isIntakeStatusReply(value: unknown): value is IntakeStatusReply {
  if (!isRecord(value) || value.intakeProtocolVersion !== INTAKE_PROTOCOL_VERSION || value.type !== 'status') return false;
  if (!hasOnlyKeys(value, ['intakeProtocolVersion', 'type', 'state', 'text', 'clearText'])) return false;
  return (value.state === 'busy' || value.state === 'idle' || value.state === 'success' || value.state === 'error')
    && typeof value.text === 'string' && value.text.length <= INTAKE_STATUS_MAX_TEXT_LENGTH
    && (value.clearText === undefined || typeof value.clearText === 'boolean');
}

/** Pure shape and budget guard for source-intake Webview messages. */
export function isIntakeMessage(value: unknown): value is IntakeMessage {
  if (!isRecord(value) || value.intakeProtocolVersion !== INTAKE_PROTOCOL_VERSION) return false;
  if (value.type === 'import-jsonl') {
    return hasOnlyKeys(value, ['intakeProtocolVersion', 'type', 'text'])
      && typeof value.text === 'string' && value.text.length <= SOURCE_INTAKE_MAX_BYTES
      && utf8Length(value.text) <= SOURCE_INTAKE_MAX_BYTES;
  }
  if (value.type === 'preview-uris') {
    return hasOnlyKeys(value, ['intakeProtocolVersion', 'type', 'uris'])
      && Array.isArray(value.uris) && value.uris.length === 1
      && isBoundedString(value.uris[0], SOURCE_INTAKE_MAX_URI_LENGTH);
  }
  return value.type === 'webview-diagnostic'
    && hasOnlyKeys(value, ['intakeProtocolVersion', 'type', 'name', 'message'])
    && isBoundedString(value.name, 128) && isBoundedString(value.message, 512);
}

/** Pure intake shape and size classification for Host adapters that need user-facing errors. */
export function validateIntakeMessage(value: unknown): IntakeMessageValidation {
  if (isRecord(value) && value.intakeProtocolVersion !== INTAKE_PROTOCOL_VERSION) {
    return { ok: false, error: 'unsupported-version' };
  }
  if (isRecord(value) && value.type === 'import-jsonl' && typeof value.text === 'string'
    && (value.text.length > SOURCE_INTAKE_MAX_BYTES || utf8Length(value.text) > SOURCE_INTAKE_MAX_BYTES)) {
    return { ok: false, error: 'oversized' };
  }
  if (!isIntakeMessage(value)) return { ok: false, error: 'invalid' };
  return { ok: true, message: value };
}

/** Pure shape and budget guard for the editor-area source-intake canvas. */
export function isSourceDropMessage(value: unknown): value is SourceDropMessage {
  if (!isRecord(value) || value.intakeProtocolVersion !== INTAKE_PROTOCOL_VERSION) return false;
  if (value.type === 'pick-files' || value.type === 'pick-folder') {
    return hasOnlyKeys(value, ['intakeProtocolVersion', 'type']);
  }
  if (value.type === 'preview-uris') {
    return hasOnlyKeys(value, ['intakeProtocolVersion', 'type', 'uris'])
      && Array.isArray(value.uris) && value.uris.length === 1
      && isBoundedString(value.uris[0], SOURCE_INTAKE_MAX_URI_LENGTH);
  }
  return value.type === 'import-jsonl'
    && hasOnlyKeys(value, ['intakeProtocolVersion', 'type', 'text'])
    && typeof value.text === 'string' && value.text.length <= SOURCE_INTAKE_MAX_BYTES
    && utf8Length(value.text) <= SOURCE_INTAKE_MAX_BYTES;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isBoundedString(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
