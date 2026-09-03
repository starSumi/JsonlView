import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import type * as vscode from 'vscode';
import type { SnapshotIdentity } from '../shared/types';

export function getWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  snapshot: SnapshotIdentity,
  pageSize = 100,
): string {
  const nonce = randomBytes(18).toString('base64url');
  const scriptUri = webview.asWebviewUri(extensionUri.with({
    path: posix.join(extensionUri.path, 'dist', 'webview.js'),
  }));
  const styleUri = webview.asWebviewUri(extensionUri.with({
    path: posix.join(extensionUri.path, 'dist', 'webview.css'),
  }));

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src-elem ${webview.cspSource}; style-src-attr 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
  <link rel="stylesheet" href="${styleUri}">
  <title>JsonlView</title>
</head>
<body
  data-document-id="${escapeAttribute(snapshot.documentId)}"
  data-generation="${escapeAttribute(snapshot.generation)}"
  data-uri="${escapeAttribute(snapshot.uri)}"
  data-page-size="${String(Math.min(500, Math.max(20, Math.trunc(pageSize))))}"
>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function escapeAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return character;
    }
  });
}
