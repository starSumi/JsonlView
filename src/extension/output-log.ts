import {
  createObservabilityEvent,
  NOOP_OBSERVABILITY,
  type ObservabilityEvent,
  type ObservabilitySink,
} from './observability-contract';
import { isExecutionIdentity, isRuntimeExecutionIdentity, type ExecutionIdentity, type RuntimeExecutionIdentity } from '@shared/execution-identity';

const MAX_DETAIL_LENGTH = 512;

export interface JsonlViewOutputChannel {
  appendLine(value: string): void;
}

/** Fixed identity fields are validated and serialized whole, never truncated JSON. */
export function appendExecutionIdentityLog(
  channel: JsonlViewOutputChannel | undefined,
  executionIdentity: ExecutionIdentity,
  runtimeIdentity: RuntimeExecutionIdentity,
): void {
  if (channel === undefined || !isExecutionIdentity(executionIdentity) || !isRuntimeExecutionIdentity(runtimeIdentity)) return;
  const receipt = JSON.stringify({ executionIdentity, runtimeIdentity });
  if (receipt.length > 2048) return;
  channel.appendLine(`${new Date().toISOString()} [execution-identity] ${receipt}`);
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

/** Format a validated observability event for the local, user-visible log. */
export function formatObservabilityLogLine(event: ObservabilityEvent): string | undefined {
  let validated: ObservabilityEvent | undefined;
  try {
    validated = createObservabilityEvent(event.name, event.attributes, event.timestamp);
  } catch {
    return undefined;
  }
  if (validated === undefined) return undefined;
  const detail = Object.entries(validated.attributes)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');
  return formatOutputLogLine(validated.name, detail, validated.timestamp);
}

/** Append only contract-validated metadata; invalid events are dropped. */
export function appendObservabilityEvent(
  channel: JsonlViewOutputChannel | undefined,
  event: ObservabilityEvent,
): void {
  if (channel === undefined) return;
  const line = formatObservabilityLogLine(event);
  if (line === undefined) return;
  try {
    channel.appendLine(line);
  } catch {
    // A disposed output channel must not change the lifecycle being observed.
  }
}

/** Adapt the explicit local log channel into an opt-in observability sink. */
export function createOutputLogObservabilitySink(
  channel: JsonlViewOutputChannel | undefined,
): ObservabilitySink {
  if (channel === undefined) return NOOP_OBSERVABILITY;
  return Object.freeze({
    record: (event: ObservabilityEvent): void => appendObservabilityEvent(channel, event),
  });
}
