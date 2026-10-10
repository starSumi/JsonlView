const MAX_DETAIL_LENGTH = 512;

export interface JsonlViewOutputChannel {
  appendLine(value: string): void;
}

/** Keep the user-visible channel useful without copying source or payload data. */
export function formatOutputLogLine(
  event: string,
  detail?: string,
  timestamp = new Date().toISOString(),
): string {
  const safeEvent = event.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, 96) || 'event';
  const safeDetail = detail === undefined
    ? ''
    : ` ${detail.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, MAX_DETAIL_LENGTH)}`;
  return `${timestamp} [${safeEvent}]${safeDetail}`;
}

export function appendOutputLog(
  channel: JsonlViewOutputChannel | undefined,
  event: string,
  detail?: string,
): void {
  channel?.appendLine(formatOutputLogLine(event, detail));
}
