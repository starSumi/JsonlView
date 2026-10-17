import type { ExtensionMessage, ProtocolDirection, WebviewRequest } from '../types';
import { isProtocolDirection } from '../types';

export { isProtocolDirection };

export type WebviewRequestType = WebviewRequest['type'];
export type ExtensionMessageType = ExtensionMessage['type'];

const WEBVIEW_REQUEST_TYPES: ReadonlySet<string> = new Set<WebviewRequestType>([
  'READY', 'GET_ROWS', 'GET_PROBLEMS', 'GET_DETAIL', 'GET_SCHEMA', 'GET_INSIGHTS',
  'SET_PROFILE', 'SET_FOLLOW_MODE', 'SET_ROW_ORDER', 'OPEN_SESSION_NAVIGATOR',
  'SAVE_PREVIEW_AS', 'DIAGNOSE_ERROR', 'CANCEL', 'REBUILD_INDEX',
]);
const EXTENSION_MESSAGE_TYPES: ReadonlySet<string> = new Set<ExtensionMessageType>([
  'OPENED', 'PREVIEW_STATUS', 'ROWS', 'PROBLEMS', 'DETAIL', 'SCHEMA', 'INSIGHTS',
  'INDEX_PROGRESS', 'PROFILE_CHANGED', 'ROW_ORDER_CHANGED', 'REVEAL',
  'SOURCE_INVALIDATED', 'ERROR', 'NAVIGATOR_STATUS', 'SOURCE_REGISTRATION_RESULT',
]);

export function isWebviewRequestType(value: unknown): value is WebviewRequestType {
  return typeof value === 'string' && WEBVIEW_REQUEST_TYPES.has(value);
}

export function isExtensionMessageType(value: unknown): value is ExtensionMessageType {
  return typeof value === 'string' && EXTENSION_MESSAGE_TYPES.has(value);
}

/** Returns the only direction accepted for a known message discriminator. */
export function directionForMessageType(value: unknown): ProtocolDirection | undefined {
  if (isWebviewRequestType(value)) return 'webview-to-host';
  if (isExtensionMessageType(value)) return 'host-to-webview';
  return undefined;
}

export function isMessageDirection(value: unknown, direction: ProtocolDirection): boolean {
  const expected = directionForMessageType(value);
  return expected === undefined || expected === direction;
}
