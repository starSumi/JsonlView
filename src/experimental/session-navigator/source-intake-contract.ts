/** Shared file-name contract used by host validation and generated intake views. */
export const JSONL_EXTENSION_PATTERN = /\.(jsonl|ndjson)$/iu;
export const JSONL_EXTENSION_PATTERN_SOURCE = String.raw`\.(jsonl|ndjson)$`;

export function hasJsonlExtension(value: string): boolean {
  return JSONL_EXTENSION_PATTERN.test(value.split(/[?#]/u, 1)[0] ?? '');
}
