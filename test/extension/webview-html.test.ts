import { describe, expect, it } from 'vitest';
import { getWebviewHtml } from '../../src/extension/webview-html';
import type { SnapshotIdentity } from '../../src/shared/types';

const snapshot: SnapshotIdentity = {
  documentId: 'document&lt;unsafe',
  generation: 'generation"unsafe',
  uri: 'file:///fixture.jsonl?value=<unsafe>',
  scheme: 'file',
  sizeBytes: '10',
  mtimeMs: 1,
  prefixFingerprint: 'abc',
  observedAt: '2026-08-30T00:00:00Z',
};

describe('getWebviewHtml', () => {
  it('keeps executable code nonce-bound while allowing virtualization style attributes', () => {
    const webview = {
      cspSource: 'vscode-webview://unit-test',
      asWebviewUri: (uri: { toString(): string }) => uri,
    };
    const vscodeUri = {
      path: '/jsonl-view',
      with: ({ path }: { path: string }) => ({ toString: () => `vscode-extension://${path}` }),
    };

    const html = getWebviewHtml(webview as never, vscodeUri as never, snapshot, 250);

    expect(html).toContain("default-src 'none'");
    expect(html).toContain("style-src-elem vscode-webview://unit-test");
    expect(html).toContain("style-src-attr 'unsafe-inline'");
    expect(html).toMatch(/script-src 'nonce-[A-Za-z0-9_-]+'/);
    expect(html).not.toContain("script-src 'unsafe-inline'");
    expect(html).toContain('data-generation="generation&quot;unsafe"');
    expect(html).not.toContain('data-uri="file:///fixture.jsonl?value=<unsafe>"');
    expect(html).toContain('data-page-size="250"');
  });
});
