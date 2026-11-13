import { randomBytes } from 'node:crypto';
import { INTAKE_PROTOCOL_VERSION, INTAKE_STATUS_MAX_TEXT_LENGTH } from '../../shared/contracts/intake';
import { JSONL_EXTENSION_PATTERN_SOURCE } from './source-intake-contract';
import { SOURCE_INTAKE_MAX_BYTES, SOURCE_INTAKE_MAX_RECORDS, SOURCE_INTAKE_MAX_URI_LIST_CHARS } from './source-intake-limits';

function formatMiB(bytes: number): string {
  const value = bytes / (1024 * 1024);
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/u, '').replace(/\.$/u, '');
}

/** Paste-only document; file, folder, drop, and agent actions live in native trees. */
export function getSourceIntakeHtml(): string {
  const nonce = randomBytes(18).toString('base64url');
  const maxBytes = SOURCE_INTAKE_MAX_BYTES;
  const maxMiB = formatMiB(maxBytes);
  const maxRecords = SOURCE_INTAKE_MAX_RECORDS;
  return String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none';">
  <title>Paste JSONL</title>
  <style nonce="${nonce}">
    * { box-sizing: border-box; }
    body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font: var(--vscode-font-size)/1.5 var(--vscode-font-family); }
    main { width: min(780px, 100%); margin: 0 auto; padding: 40px 28px; }
    .eyebrow { color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; }
    h1 { margin: 8px 0; font-size: 26px; line-height: 1.25; font-weight: 600; }
    .hint { color: var(--vscode-descriptionForeground); font-size: 12px; }
    label { display: block; margin: 24px 0 8px; font-weight: 600; }
    textarea { display: block; width: 100%; min-height: 260px; resize: vertical; padding: 12px; border-radius: 5px; border: 1px solid var(--vscode-input-border, var(--vscode-widget-border)); background: var(--vscode-input-background); color: var(--vscode-input-foreground); font: var(--vscode-editor-font-size)/1.55 var(--vscode-editor-font-family); }
    textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
    button { font: inherit; cursor: pointer; }
    button:focus-visible, textarea:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 3px; }
    button:disabled { cursor: default; opacity: .6; }
    .footer { margin-top: 10px; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
    .primary { padding: 8px 16px; border: 1px solid transparent; border-radius: 4px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    .primary:hover { background: var(--vscode-button-hoverBackground); }
    #status { min-height: 24px; margin: 16px 0 0; overflow-wrap: anywhere; }
    #status[data-state="error"] { color: var(--vscode-errorForeground); }
    #diagnostic { margin-top: 16px; padding: 12px; border: 1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground)); background: var(--vscode-inputValidation-errorBackground); }
    #diagnostic[hidden] { display: none; }
    #diagnostic strong { color: var(--vscode-errorForeground); }
    #diagnostic button { margin-right: 6px; }
    .privacy { margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); }
    @media (max-width: 560px) { main { padding: 28px 18px; } .footer { align-items: flex-start; flex-direction: column; } }
  </style>
</head>
<body>
  <main>
    <div class="eyebrow">JsonlView</div>
    <h1>Paste JSONL</h1>
    <p class="hint">Paste one JSON value per line, drag one JSONL / NDJSON file here, or press Ctrl/Cmd+Enter to open a temporary preview.</p>
    <label for="jsonl">JSONL content</label>
    <textarea id="jsonl" spellcheck="false" autocapitalize="off" autocomplete="off" aria-describedby="paste-hint" placeholder='{"event":"started"}&#10;{"event":"finished"}'></textarea>
    <div class="footer">
      <span class="hint" id="paste-hint">Up to ${maxMiB} MiB / ${maxRecords} records · Save As keeps a permanent copy</span>
      <button class="primary" id="preview" type="button">Open preview</button>
    </div>
    <p id="status" role="status" aria-live="polite"></p>
    <section id="diagnostic" hidden role="alert" aria-live="assertive">
      <strong>Webview error</strong>
      <p id="diagnostic-text" class="hint">The paste view could not initialize.</p>
      <button id="diagnostic-copy" type="button">Copy diagnostics</button>
      <button id="diagnostic-send" type="button">Send to VS Code AI</button>
    </section>
    <p class="hint privacy">Source text is stored in a temporary local preview. It remains available during this VS Code session; use Save As to keep a permanent copy.</p>
  </main>
  <script nonce="${nonce}">
    (() => {
      const vscode = acquireVsCodeApi();
      const maxBytes = ${maxBytes};
      const text = document.getElementById('jsonl');
      const status = document.getElementById('status');
      const intakeProtocolVersion = ${INTAKE_PROTOCOL_VERSION};
      const maxStatusTextLength = ${INTAKE_STATUS_MAX_TEXT_LENGTH};
      const extension = new RegExp(${JSON.stringify(JSONL_EXTENSION_PATTERN_SOURCE)}, 'iu');
      let busy = false;
      function setStatus(message, state) { status.textContent = message; status.dataset.state = state; }
      function setBusy(value) { busy = value; document.querySelectorAll('button').forEach(button => { button.disabled = value; }); text.readOnly = value; }
      function isStatusReply(message) {
        return message !== null && typeof message === 'object'
          && message.intakeProtocolVersion === intakeProtocolVersion
          && message.type === 'status'
          && ['busy', 'idle', 'success', 'error'].includes(message.state)
          && typeof message.text === 'string' && message.text.length <= maxStatusTextLength
          && (message.clearText === undefined || typeof message.clearText === 'boolean');
      }
      function isFocusMessage(message) {
        return message !== null && typeof message === 'object'
          && message.intakeProtocolVersion === intakeProtocolVersion && message.type === 'focus'
          && Object.keys(message).length === 2 && Object.hasOwn(message, 'intakeProtocolVersion') && Object.hasOwn(message, 'type');
      }
      function send(message) {
        if (busy) return;
        setBusy(true);
        setStatus('Processing…', 'busy');
        try {
          Promise.resolve(vscode.postMessage({ ...message, intakeProtocolVersion })).then((accepted) => {
            if (accepted === false) {
              setBusy(false); setStatus('View connection closed. Reopen Paste JSONL and retry.', 'error');
            }
          }, () => {
            setBusy(false); setStatus('View connection closed. Reopen Paste JSONL and retry.', 'error');
          });
        } catch {
          setBusy(false); setStatus('View connection closed. Reopen Paste JSONL and retry.', 'error');
        }
      }
      function isLocalJsonlUri(value) {
        try {
          const uri = new URL(value);
          return uri.protocol === 'file:' && uri.hostname === '' && uri.search === '' && uri.hash === ''
            && extension.test(decodeURIComponent(uri.pathname));
        } catch { return false; }
      }
      function isFileDrag(event) {
        const transfer = event.dataTransfer;
        if (!transfer) return false;
        const items = Array.from(transfer.items || []);
        if (items.some(item => item.kind === 'file')) return true;
        return Array.from(transfer.types || []).map(type => String(type).toLowerCase()).some(type => type === 'files' || type === 'text/uri-list');
      }
      function submitPaste() {
        if (busy) return;
        if (text.value.length === 0) { setStatus('Paste at least one JSON record.', 'error'); text.focus(); return; }
        if (text.value.length > maxBytes || new TextEncoder().encode(text.value).byteLength > maxBytes) {
          setStatus('JSONL preview is limited to ' + ${JSON.stringify(maxMiB)} + ' MiB.', 'error'); return;
        }
        send({ type: 'import-jsonl', text: text.value });
      }
      async function handleDrop(event) {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        if (busy || !event.dataTransfer) return;
        const transfer = event.dataTransfer;
        try {
          const rawUris = transfer.getData('text/uri-list');
          if (rawUris) {
            if (rawUris.length > ${SOURCE_INTAKE_MAX_URI_LIST_CHARS}) throw new Error('Drop one JSONL file at a time.');
            const uris = rawUris.split(/\r?\n/u).map(value => value.trim()).filter(value => value && !value.startsWith('#'));
            if (uris.length !== 1 || !isLocalJsonlUri(uris[0])) throw new Error('Drop one local JSONL or NDJSON file for a temporary preview.');
            send({ type: 'preview-uris', uris });
            return;
          }
          const files = Array.from(transfer.files || []);
          if (files.length !== 1 || !extension.test(files[0].name)) throw new Error('Drop one JSONL or NDJSON file for a temporary preview.');
          const file = files[0];
          if (file.size > maxBytes) throw new Error('Dropped previews are limited to ' + ${JSON.stringify(maxMiB)} + ' MiB. Use Import → Files for larger sources.');
          if (typeof file.arrayBuffer !== 'function') throw new Error('This dropped file cannot be read. Use Import → Files instead.');
          setBusy(true);
          setStatus('Opening preview…', 'busy');
          const buffer = await file.arrayBuffer();
          if (buffer.byteLength > maxBytes) throw new Error('Dropped previews are limited to ' + ${JSON.stringify(maxMiB)} + ' MiB.');
          const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
          setBusy(false);
          send({ type: 'import-jsonl', text: content });
        } catch (error) {
          setBusy(false);
          setStatus(error instanceof Error ? error.message : 'The dropped file could not be read as UTF-8 JSONL.', 'error');
        }
      }
      function showDiagnostic(name, message) {
        const safeName = String(name || 'Error').slice(0, 128);
        const safeMessage = String(message || 'Unknown webview error').replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 512);
        const detail = safeName + ': ' + (safeMessage || 'Unknown webview error');
        const card = document.getElementById('diagnostic');
        document.getElementById('diagnostic-text').textContent = detail;
        card.hidden = false;
        const report = () => vscode.postMessage({ intakeProtocolVersion, type: 'webview-diagnostic', name: safeName, message: safeMessage });
        document.getElementById('diagnostic-copy').onclick = report;
        document.getElementById('diagnostic-send').onclick = report;
      }
      window.addEventListener('error', event => showDiagnostic('Error', event.message));
      window.addEventListener('unhandledrejection', event => showDiagnostic('UnhandledRejection', event.reason && event.reason.message ? event.reason.message : event.reason));
      document.getElementById('preview').addEventListener('click', () => {
        submitPaste();
      });
      text.addEventListener('keydown', event => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !busy) {
          event.preventDefault();
          submitPaste();
        }
      });
      document.addEventListener('dragover', event => { if (isFileDrag(event)) event.preventDefault(); }, true);
      document.addEventListener('drop', event => { void handleDrop(event); }, true);
      window.addEventListener('message', event => {
        const message = event.data;
        if (isFocusMessage(message)) { text.focus(); return; }
        if (!isStatusReply(message)) return;
        setBusy(message.state === 'busy');
        setStatus(message.text, message.state);
        if (message.clearText === true) text.value = '';
      });
    })();
  </script>
</body>
</html>`;
}
