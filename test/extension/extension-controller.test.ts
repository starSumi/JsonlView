import { describe, expect, it, vi } from 'vitest';
import {
  buildActivationConflictPresentation,
  createDiagnosticActionController,
  isJsonlResource,
} from '../../src/extension/extension-controller';
import { buildDiagnosticEnvelope } from '../../src/extension/diagnostics/diagnostic-context';
import { buildActivationConflictDiagnostic } from '../../src/extension/diagnostics/side-agent-diagnostics';

describe('Node-testable extension controller', () => {
  it('builds sanitized conflict metadata while preserving the notification payload', () => {
    const presentation = buildActivationConflictPresentation('JsonlView\ncurrent', {
      extensionId: 'other',
      contributionIds: ['jsonlView.open', 'jsonlView.open', 'jsonlView.editor'],
    });

    expect(presentation).toMatchObject({
      diagnostic: {
        kind: 'activation-contribution-conflict',
        currentExtensionId: 'JsonlView current',
        conflictingExtensionId: 'other',
        contributionIds: ['jsonlView.editor', 'jsonlView.open'],
        contentPolicy: 'metadata-only',
      },
      envelope: {
        stage: 'activation-contribution-conflict',
        error: {
          name: 'ExtensionContributionConflict',
          message: 'Another enabled extension declares jsonlView.editor, jsonlView.open.',
        },
        extension: { id: 'JsonlView current' },
      },
      notificationMessage: 'JsonlView cannot activate while other is enabled because both extensions declare jsonlView.open, jsonlView.open, jsonlView.editor. Disable or uninstall one JsonlView build, then reload the window.',
    });
  });

  it.each([
    { path: '/workspace/session.jsonl', expected: true },
    { path: '/workspace/session.NDJSON', expected: true },
    { path: '/workspace/session.json', expected: false },
    { path: '/workspace/session.jsonl/child', expected: false },
    { path: '/workspace/.jsonl', expected: true },
    { path: '/workspace/session.jsonl.txt', expected: false },
  ])('guards a URI by its final path extension: $path', ({ path, expected }) => {
    expect(isJsonlResource({ path })).toBe(expected);
  });

  it('dispatches each offered diagnostic action through its matching host port', async () => {
    const ports = {
      copyText: vi.fn(async (_text: string) => undefined),
      openLog: vi.fn(),
      sendToSideAgent: vi.fn(async () => undefined),
      explainWithChat: vi.fn(async (_prompt: string) => undefined),
    };
    const dispatch = createDiagnosticActionController(ports);
    const envelope = buildDiagnosticEnvelope({ stage: 'test', name: 'Error', message: 'bounded detail' });

    await dispatch('Copy diagnostic context', envelope);
    expect(ports.copyText).toHaveBeenLastCalledWith(JSON.stringify(envelope, null, 2));

    await dispatch('Open JsonlView Log', envelope);
    expect(ports.openLog).toHaveBeenCalledOnce();

    await dispatch('Send to side agent', envelope);
    expect(ports.sendToSideAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'diagnostic', stage: 'test', contentPolicy: 'metadata-only' }),
      envelope,
      undefined,
    );

    const conflict = buildActivationConflictDiagnostic('current', {
      extensionId: 'other',
      contributionIds: ['jsonlView.open'],
    });
    await dispatch('Send to side agent', envelope, { sideAgentDiagnostic: conflict });
    expect(ports.sendToSideAgent).toHaveBeenLastCalledWith(conflict, envelope, undefined);

    const context = {} as never;
    await dispatch('Send to side agent', envelope, { sideAgentDiagnostic: conflict, context });
    expect(ports.sendToSideAgent).toHaveBeenLastCalledWith(conflict, envelope, context);

    await dispatch('Explain with VS Code Chat', envelope);
    expect(ports.explainWithChat).toHaveBeenLastCalledWith(expect.stringContaining(JSON.stringify(envelope, null, 2)));

    await dispatch(undefined, envelope);
    await dispatch('unrecognized action', envelope);
    expect(ports.copyText).toHaveBeenCalledOnce();
    expect(ports.openLog).toHaveBeenCalledOnce();
    expect(ports.sendToSideAgent).toHaveBeenCalledTimes(3);
    expect(ports.explainWithChat).toHaveBeenCalledOnce();
  });
});
