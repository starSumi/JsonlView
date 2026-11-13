import { randomBytes } from 'node:crypto';
import { INTAKE_PROTOCOL_VERSION, INTAKE_STATUS_MAX_TEXT_LENGTH } from '../../shared/contracts/intake';
import { JSONL_EXTENSION_PATTERN_SOURCE } from './source-intake-contract';
import { SOURCE_INTAKE_MAX_BYTES, SOURCE_INTAKE_MAX_URI_LIST_CHARS } from './source-intake-limits';

/** Wide editor-area intake canvas; bytes and source authorization remain owned by the host. */
export function getSourceDropHtml(): string {
  const nonce = randomBytes(18).toString('base64url');
  return String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none';">
  <title>Use Resources</title>
  <style nonce="${nonce}">
    * { box-sizing: border-box; }
    html, body { min-height: 100%; }
    body { margin: 0; min-height: 100vh; padding: clamp(18px, 5vh, 56px) 24px; display: grid; place-items: center; color: var(--vscode-foreground); background: var(--vscode-editor-background); font: var(--vscode-font-size)/1.45 var(--vscode-font-family); }
    .canvas { width: min(100%, 1120px); min-height: min(78vh, 760px); display: flex; flex-direction: column; gap: 18px; padding: clamp(22px, 4vw, 42px); border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, #808080)); border-radius: 8px; background: var(--vscode-sideBar-background); box-shadow: 0 18px 48px color-mix(in srgb, var(--vscode-editor-foreground) 16%, transparent); }
    .heading { display: flex; flex-direction: column; gap: 5px; }
    h1 { margin: 0; font-size: 18px; font-weight: 600; }
    .subtitle, .drop-hint, #status { margin: 0; color: var(--vscode-descriptionForeground); }
    .subtitle { font-size: 12px; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    button { min-height: 32px; padding: 6px 12px; border: 1px solid var(--vscode-button-border, var(--vscode-widget-border, transparent)); border-radius: 4px; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); font: inherit; cursor: pointer; }
    button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
    button:focus-visible, textarea:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
    button:disabled { opacity: .65; cursor: default; }
    .primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    .primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    .import-tray-icon { width: 16px; height: 16px; margin-right: 6px; vertical-align: middle; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
    .dropzone { flex: 1; min-height: clamp(300px, 48vh, 520px); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 24px; border: 2px dashed var(--vscode-panel-border, var(--vscode-contrastBorder, #808080)); border-radius: 7px; background: color-mix(in srgb, var(--vscode-editor-background) 56%, transparent); text-align: center; transition: border-color 100ms ease, background-color 100ms ease, box-shadow 100ms ease; }
    .dropzone.dragging { border-style: solid; border-color: var(--vscode-focusBorder); background: var(--vscode-list-dropBackground); box-shadow: inset 0 0 0 1px var(--vscode-focusBorder); }
    .dropzone svg { width: 38px; height: 38px; fill: none; stroke: var(--vscode-descriptionForeground); stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
    .drop-title { margin: 0; font-size: 15px; font-weight: 600; }
    .drop-hint { font-size: 12px; }
    .paste-editor { display: flex; flex-direction: column; gap: 10px; }
    .paste-editor[hidden] { display: none; }
    textarea { width: 100%; min-height: 180px; resize: vertical; padding: 10px 12px; border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, #808080)); border-radius: 4px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); font: 12px/1.5 var(--vscode-editor-font-family, monospace); }
    .paste-actions { display: flex; justify-content: flex-end; gap: 8px; }
    #status { min-height: 18px; font-size: 12px; }
    #status[data-state='error'] { color: var(--vscode-errorForeground); }
    @media (max-width: 640px) {
      body { padding: 12px; }
      .canvas { min-height: calc(100vh - 24px); padding: 18px; gap: 14px; }
      .dropzone { min-height: 38vh; }
    }
    @media (forced-colors: active) { .canvas, .dropzone, button { border-color: ButtonText; } .dropzone.dragging { outline: 2px solid Highlight; } }
    @media (prefers-reduced-motion: reduce) { .dropzone { transition: none; } }
  </style>
</head>
<body>
  <main class="canvas" aria-labelledby="canvas-title">
    <header class="heading">
      <h1 id="canvas-title">Use Resources</h1>
      <p class="subtitle">Select a source or drop one JSONL / NDJSON file for a temporary JsonlView preview.</p>
    </header>
    <div class="actions" role="group" aria-label="Import actions">
      <button class="primary" id="pick-files" type="button" aria-label="Choose files"><svg class="import-tray-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 20H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3Z"/><path d="M18 6c-3 0-6.5 2-7.5 7.5"/><path d="M7.5 10.5 10.5 13.5 13.5 10.5"/></svg>Choose files</button>
      <button id="pick-folder" type="button" aria-label="Choose folder">Choose folder</button>
      <button id="show-paste" type="button" aria-label="Paste JSONL" aria-expanded="false" aria-controls="paste-editor">Paste JSONL</button>
    </div>
    <section class="dropzone" id="dropzone" aria-label="Drop JSONL or NDJSON file here">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m0 0L7 9m5-5 5 5M4 15v4h16v-4" /></svg>
      <p class="drop-title">Drop JSONL / NDJSON</p>
      <p class="drop-hint">Drag one file from File Explorer anywhere on this canvas.</p>
    </section>
    <section class="paste-editor" id="paste-editor" hidden aria-label="Paste JSONL draft">
      <label for="paste-text">Paste JSONL text</label>
      <textarea id="paste-text" spellcheck="false" placeholder='{"message":"Paste JSONL here"}'></textarea>
      <div class="paste-actions">
        <button id="cancel-paste" type="button">Cancel</button>
        <button class="primary" id="preview-paste" type="button">Open temporary preview</button>
      </div>
    </section>
    <p id="status" role="status" aria-live="polite">Source files remain unchanged. Choose Files to authorize a read-only source separately.</p>
  </main>
  <script nonce="${nonce}">
    (() => {
      const vscode = acquireVsCodeApi();
      const dropzone = document.getElementById('dropzone');
      const pasteEditor = document.getElementById('paste-editor');
      const pasteText = document.getElementById('paste-text');
      const showPaste = document.getElementById('show-paste');
      const status = document.getElementById('status');
      const intakeProtocolVersion = ${INTAKE_PROTOCOL_VERSION};
      const maxStatusTextLength = ${INTAKE_STATUS_MAX_TEXT_LENGTH};
      const buttons = Array.from(document.querySelectorAll('button'));
      const extension = new RegExp(${JSON.stringify(JSONL_EXTENSION_PATTERN_SOURCE)}, 'iu');
      let busy = false;
      let dragDepth = 0;
      function setStatus(text, state = 'idle') { status.textContent = text; status.dataset.state = state; }
      function isStatusReply(message) {
        return message !== null && typeof message === 'object'
          && message.intakeProtocolVersion === intakeProtocolVersion
          && message.type === 'status'
          && ['busy', 'idle', 'success', 'error'].includes(message.state)
          && typeof message.text === 'string' && message.text.length <= maxStatusTextLength
          && (message.clearText === undefined || typeof message.clearText === 'boolean');
      }
      function isFileDrag(event) {
        const transfer = event.dataTransfer;
        if (!transfer) return false;
        const items = Array.from(transfer.items || []);
        if (items.some(item => item.kind === 'file')) return true;
        const types = Array.from(transfer.types || []).map(type => String(type).toLowerCase());
        return types.includes('files') || types.includes('text/uri-list');
      }
      function setDragging(active) {
        dropzone.classList.toggle('dragging', active);
        if (active) setStatus('Release to preview the dropped file…', 'dragging');
        else if (status.dataset.state === 'dragging') setStatus('Source files remain unchanged.');
      }
      function resetDrag() { dragDepth = 0; setDragging(false); }
      function setBusy(value) {
        busy = value;
        for (const button of buttons) button.disabled = value;
        if (value) resetDrag();
      }
      function send(message) {
        if (busy) return;
        setBusy(true);
        setStatus('Processing…', 'busy');
        try { Promise.resolve(vscode.postMessage({ ...message, intakeProtocolVersion })).catch(() => { setBusy(false); setStatus('View connection closed. Reopen Import and retry.', 'error'); }); }
        catch { setBusy(false); setStatus('View connection closed. Reopen Import and retry.', 'error'); }
      }
      function fileUriList(transfer) {
        const raw = transfer.getData('text/uri-list');
        if (!raw) return undefined;
        if (raw.length > ${SOURCE_INTAKE_MAX_URI_LIST_CHARS}) throw new Error('Drop one local file, or use Choose files.');
        const uris = raw.split(/\r?\n/u).map(uri => uri.trim()).filter(uri => uri && !uri.startsWith('#'));
        if (uris.length !== 1) throw new Error('Drop one file for a temporary preview, or use Choose files.');
        return uris[0];
      }
      async function handleDrop(event) {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        resetDrag();
        if (busy || !event.dataTransfer) return;
        try {
          const uri = fileUriList(event.dataTransfer);
          if (uri !== undefined) { send({ type: 'preview-uris', uris: [uri] }); return; }
          const entries = Array.from(event.dataTransfer.items || []).map(item => {
            try { return typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null; }
            catch { return null; }
          });
          if (entries.some(entry => entry && entry.isDirectory)) { send({ type: 'pick-folder' }); return; }
          const files = Array.from(event.dataTransfer.files || []);
          if (files.length !== 1) { setStatus('Drop one file for a temporary preview, or use Choose files.', 'error'); return; }
          const file = files[0];
          if (!extension.test(file.name)) { setStatus('Only .jsonl or .ndjson files can be previewed.', 'error'); return; }
          if (file.size > ${SOURCE_INTAKE_MAX_BYTES}) { setStatus('Dropped previews are limited to 1 MiB. Use Choose files for larger sources.', 'error'); return; }
          if (typeof file.arrayBuffer !== 'function') { setStatus('This file cannot be read from the drop. Use Choose files.', 'error'); return; }
          setBusy(true);
          setStatus('Opening preview…', 'busy');
          const buffer = await file.arrayBuffer();
          if (buffer.byteLength > ${SOURCE_INTAKE_MAX_BYTES}) throw new Error('File exceeds the 1 MiB temporary preview limit.');
          const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
          setBusy(false);
          send({ type: 'import-jsonl', text });
        } catch (error) {
          setBusy(false);
          setStatus(error instanceof Error && error.message !== 'oversized' ? error.message : 'File must be UTF-8 JSONL within the 1 MiB preview limit.', 'error');
        }
      }
      document.addEventListener('dragenter', event => {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        if (busy) return;
        dragDepth++;
        setDragging(true);
      }, true);
      document.addEventListener('dragover', event => {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = busy ? 'none' : 'copy';
        if (!busy) setDragging(true);
      }, true);
      document.addEventListener('dragleave', event => {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0 || event.relatedTarget === null) resetDrag();
      }, true);
      document.addEventListener('drop', event => handleDrop(event), true);
      document.addEventListener('dragend', resetDrag, true);
      window.addEventListener('blur', resetDrag);
      document.getElementById('pick-files').addEventListener('click', () => send({ type: 'pick-files' }));
      document.getElementById('pick-folder').addEventListener('click', () => send({ type: 'pick-folder' }));
      showPaste.addEventListener('click', () => {
        pasteEditor.hidden = false;
        showPaste.setAttribute('aria-expanded', 'true');
        pasteText.focus();
      });
      document.getElementById('cancel-paste').addEventListener('click', () => {
        pasteEditor.hidden = true;
        showPaste.setAttribute('aria-expanded', 'false');
        pasteText.value = '';
        showPaste.focus();
      });
      document.getElementById('preview-paste').addEventListener('click', () => {
        if (pasteText.value.length === 0) { setStatus('Paste at least one JSON record.', 'error'); pasteText.focus(); return; }
        send({ type: 'import-jsonl', text: pasteText.value });
      });
      window.addEventListener('message', event => {
        const message = event.data;
        if (!isStatusReply(message)) return;
        setBusy(message.state === 'busy');
        setStatus(message.text, message.state);
      });
    })();
  </script>
</body>
</html>`;
}
