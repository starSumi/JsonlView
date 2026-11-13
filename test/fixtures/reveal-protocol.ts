import { DocumentController, type JsonlSessionPort } from '../../src/extension/document-controller';
import type { PendingRevealIntent } from '../../src/experimental/session-navigator/reveal-intents';
import type { DocumentSummary, WebviewRequest } from '../../src/shared/types';
import type { RevealResult } from '../../src/shared/protocol/reveal';
import { WebviewRevealController, type RevealMessage } from '../../src/webview/features/record-query/reveal-controller';
import { VsCodeMessageClient } from '../../src/webview/protocol-client';

/** Synthetic transport loop: real Host validation, Webview correlation and render acknowledgement. */
export function createRevealProtocolFixture() {
  const identity = { documentId: 'synthetic-document', generation: 'synthetic-generation', epoch: 1 };
  const summary = { snapshot: identity, indexedRecords: '1', indexingComplete: true } as DocumentSummary;
  const reveals: RevealMessage[] = [];
  const acknowledgements: WebviewRequest[] = [];
  const receipts: RevealResult[] = [];
  const pending: Promise<void>[] = [];
  const client = new VsCodeMessageClient({ postMessage: (message) => {
    acknowledgements.push(message);
    pending.push(controller.handleMessage(message));
  } }, identity);
  const view = new WebviewRevealController({
    getSession: () => client.session,
    isLocal: () => true,
    load: () => undefined,
    acknowledge: (message, payload) => client.acknowledgeReveal(message, payload),
    onChange: () => undefined,
  });
  const controller = new DocumentController({ getSummary: () => summary } as JsonlSessionPort, {
    postMessage: async (message) => {
      const accepted = client.accept(message);
      if (accepted?.type === 'REVEAL') {
        reveals.push(accepted);
        view.begin(accepted);
      }
      return true;
    },
  });
  return {
    reveals,
    acknowledgements,
    receipts,
    deliver: async (intent: PendingRevealIntent) => {
      const target = { sourceId: intent.sourceId, nativeId: intent.nativeId, anchorOrdinal: intent.anchorOrdinal };
      const result = await controller.revealRow(target, intent.isAuthorized);
      receipts.push(result);
      intent.complete(result);
      return result;
    },
    render: async () => {
      const target = view.target;
      if (target !== undefined) view.rendered(target.requestId, target.payload.anchorOrdinal);
      await Promise.all(pending.splice(0));
    },
    dispose: () => { view.cancel(); controller.dispose(); },
  };
}
