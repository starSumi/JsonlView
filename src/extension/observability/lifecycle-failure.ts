import { formatOutputLogLine, type JsonlViewOutputChannel } from './output-log';
import { classifyErrorMetadata } from './error-metadata';

export type LifecycleFailureStage = 'source_reconcile' | 'webview_delivery' | 'webview_diagnostic' | 'preview_collection_filing';

function failureEvent(stage: LifecycleFailureStage): string | undefined {
  switch (stage) {
    case 'source_reconcile': return 'source-reconcile-failed';
    case 'webview_delivery': return 'webview-delivery-failed';
    case 'webview_diagnostic': return 'diagnostic';
    case 'preview_collection_filing': return 'preview-collection-filing-failed';
    default: return undefined;
  }
}

/** Fixed local metadata only; failures of either observer cannot change the operation. */
export function logLifecycleFailure(
  channel: JsonlViewOutputChannel | undefined,
  stage: LifecycleFailureStage,
  error: unknown,
  warn?: (line: string) => void,
): void {
  const event = failureEvent(stage);
  if (event === undefined) return;
  const { errorName, errorCode: code } = classifyErrorMetadata(error);
  const errorCode = code === undefined ? '' : ` code=${code}`;
  const detail = `stage=${stage} outcome=failed error_name=${errorName}${errorCode}`;
  try {
    channel?.appendLine(formatOutputLogLine(event, detail));
  } catch {
    // A disposed or failed log channel must not interrupt recovery or delivery.
  }
  try {
    warn?.(`[JsonlView] ${event} ${detail}`);
  } catch {
    // Console observation has the same best-effort boundary as the output channel.
  }
}
