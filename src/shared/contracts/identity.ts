export const PROTOCOL_VERSION = 1 as const;

export type ProtocolDirection = 'webview-to-host' | 'host-to-webview';
export type ProtocolDelivery = 'request' | 'reply' | 'broadcast';

export const MAX_PROTOCOL_DOCUMENT_ID_LENGTH = 256;
export const MAX_PROTOCOL_GENERATION_LENGTH = 256;
export const MAX_PROTOCOL_REQUEST_ID_LENGTH = 128;

export interface SnapshotIdentity {
  documentId: string;
  generation: string;
  /** Optional monotonic lifecycle epoch. Older protocol fixtures may omit it. */
  epoch?: number;
  uri: string;
  scheme: string;
  sizeBytes: string;
  mtimeMs: number;
  device?: string;
  inode?: string;
  prefixFingerprint: string;
  observedAt: string;
}

export interface ProtocolIdentity {
  documentId: string;
  generation: string;
  requestId: string;
}

export function isProtocolDirection(value: unknown): value is ProtocolDirection {
  return value === 'webview-to-host' || value === 'host-to-webview';
}
