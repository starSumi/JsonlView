import * as vscode from 'vscode';
import { AcpRpcError, AcpSessionTimeoutError, type AcpSessionStage } from './session-manager';
import { classifyErrorMetadata, type ErrorMetadata } from '../observability/error-metadata';

type ProgressStage = AcpSessionStage | 'permission' | 'receiving' | 'cancelling';

const LABELS: Record<ProgressStage, string> = {
  launch: 'Starting the configured agent',
  initialize: 'Waiting for agent handshake (initialize)',
  'session/new': 'Creating agent session (session/new)',
  'session/prompt': 'Waiting for agent response (session/prompt)',
  permission: 'Waiting for your tool permission',
  receiving: 'Receiving agent response (session/prompt)',
  cancelling: 'Cancelling the ACP request',
};

export interface AcpDiagnosticProgress {
  report(stage: ProgressStage): void;
  readonly token: vscode.CancellationToken;
}

/** One native operation surface; the status item remains visible if the toast is hidden. */
export async function withAcpDiagnosticProgress<T>(task: (progress: AcpDiagnosticProgress) => Promise<T>): Promise<T> {
  const status = vscode.window.createStatusBarItem('jsonlView.acp', vscode.StatusBarAlignment.Left);
  status.name = 'JsonlView ACP';
  status.command = 'jsonlView.showOutput';
  status.tooltip = 'ACP request in progress. Click to open JsonlView Output.';
  let stage: ProgressStage = 'launch';
  const started = Date.now();
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    return await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'JsonlView: Sending diagnostic via ACP',
      cancellable: true,
    }, async (progress, token) => {
      const render = (): void => {
        const message = `${LABELS[stage]} · elapsed ${Math.floor((Date.now() - started) / 1000)} s`;
        progress.report({ message });
        status.text = `$(sync~spin) ACP: ${message}`;
        status.show();
      };
      render();
      timer = setInterval(render, 1000);
      return task({ token, report: (next) => { if (stage !== next) { stage = next; render(); } } });
    });
  } finally {
    if (timer !== undefined) clearInterval(timer);
    status.dispose();
  }
}

export interface AcpFailureDetails extends ErrorMetadata {
  readonly message: string;
  readonly stage: AcpSessionStage;
  readonly timeoutMs?: number;
  readonly rpcCode?: number;
}

/** Fixed user-facing guidance. Adapter errors and stderr may contain credentials or source data. */
export function describeAcpFailure(error: unknown, stage: AcpSessionStage): AcpFailureDetails {
  const metadata = classifyErrorMetadata(error);
  if (error instanceof AcpSessionTimeoutError) {
    const submitted = error.operation === 'session/prompt';
    return {
      ...metadata, stage: error.operation, timeoutMs: error.timeoutMs,
      message: `ACP timed out during ${LABELS[error.operation].toLowerCase()} after ${error.timeoutMs / 1000} s. ` +
        (submitted
          ? 'The diagnostic was already submitted; the agent may have started work. Review the agent connection and jsonlView.acp.timeoutMs before retrying.'
          : error.operation === 'initialize'
            ? 'No diagnostic was sent. Check the launch command and agent startup; package downloads can delay the handshake.'
            : 'No diagnostic was sent. Check agent authentication and the configured MCP servers.'),
    };
  }
  if (error instanceof AcpRpcError) {
    return {
      ...metadata, stage, rpcCode: error.code,
      message: error.code === -32000
        ? 'ACP agent requires authentication. Sign in using the configured agent\'s supported authentication method, then retry.'
        : `ACP agent rejected the request during ${LABELS[stage].toLowerCase()} (RPC ${error.code}). Open JsonlView Output for connection metadata.`,
    };
  }
  return {
    ...metadata, stage,
    message: metadata.errorCode === 'ENOENT' || metadata.errorCode === 'EACCES' || metadata.errorCode === 'EPERM'
      ? `ACP could not start the configured executable (${metadata.errorCode}). Check jsonlView.acp.command, its arguments and executable permissions.`
      : `ACP failed during ${LABELS[stage].toLowerCase()}. Open JsonlView Output for the connection stage and error code.`,
  };
}
