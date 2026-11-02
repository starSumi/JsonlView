import { randomBytes } from 'node:crypto';
import { SOURCE_INTAKE_MAX_BYTES, SOURCE_INTAKE_MAX_RECORDS } from './source-intake-limits';
import { JSONL_EXTENSION_PATTERN_SOURCE } from './source-intake-contract';
import type { DetectedAgentProviderId } from './types';

const DETECTED_AGENT_BUTTONS = [
  ['codex', 'Connect Codex'],
  ['claude', 'Connect Claude'],
  ['pi', 'Connect pi'],
  ['kimi', 'Connect Kimi Code'],
  ['gemini', 'Connect Gemini'],
  ['opencode', 'Connect OpenCode'],
  ['agentsview', 'Connect AgentsView'],
] as const satisfies readonly (readonly [DetectedAgentProviderId, string])[];

const DEFAULT_DETECTED_AGENTS = DETECTED_AGENT_BUTTONS.map(([provider]) => provider);
const JSONL_URI_VALIDATION_HELPER = `function hasJsonlExtension(value) { let path = String(value); try { path = decodeURIComponent(new URL(path).pathname); } catch {} return new RegExp(${JSON.stringify(JSONL_EXTENSION_PATTERN_SOURCE)}, 'iu').test(path.split(/[?#]/u, 1)[0] || ''); }`;

function formatMiB(bytes: number): string {
  const value = bytes / (1024 * 1024);
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/u, '').replace(/\.$/u, '');
}

function renderDetectedAgentButtons(availableProviders: readonly DetectedAgentProviderId[]): string {
  const available = new Set(availableProviders);
  return DETECTED_AGENT_BUTTONS
    .filter(([provider]) => available.has(provider))
    .map(([provider, label]) => `<button id="connect-${provider}" data-provider="${provider}" type="button">${label}</button>`)
    .join('');
}

/** Static document: source content only travels as structured messages and textarea values. */
export function getSourceIntakeHtml(availableProviders: readonly DetectedAgentProviderId[] = DEFAULT_DETECTED_AGENTS): string {
  const nonce = randomBytes(18).toString('base64url');
  const maxBytes = SOURCE_INTAKE_MAX_BYTES;
  const maxMiB = formatMiB(maxBytes);
  const maxRecords = SOURCE_INTAKE_MAX_RECORDS;
  const detectedButtons = renderDetectedAgentButtons(availableProviders);
  const detectedSection = detectedButtons.length === 0 ? '' : `
    <section class="detected" aria-labelledby="detected-title">
      <p id="detected-title" class="detected-title">Connect known local agents</p>
      <p class="hint">Restore a provider home from its standard location when it is available. No source content is sent from this panel.</p>
      <div class="detected-actions">${detectedButtons}</div>
    </section>`;
  return String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none';">
  <title>Add Source</title>
  <style nonce="${nonce}">
    * { box-sizing: border-box; }
    body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font: var(--vscode-font-size)/1.5 var(--vscode-font-family); }
    main { width: min(780px, 100%); margin: 0 auto; padding: 48px 28px; }
    .eyebrow { color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; }
    h1 { margin: 8px 0; font-size: 28px; line-height: 1.25; font-weight: 600; }
    .intro, .hint { color: var(--vscode-descriptionForeground); }
    .intro { margin: 0 0 28px; }
    .detected { margin: 0 0 20px; padding: 12px; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 6px; background: var(--vscode-sideBar-background); }
    .detected-title { margin: 0 0 8px; font-weight: 600; }
    .detected-actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .detected-actions button { padding: 6px 10px; border: 1px solid var(--vscode-button-secondaryBorder, var(--vscode-widget-border, var(--vscode-panel-border))); border-radius: 4px; color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); background: var(--vscode-button-secondaryBackground, var(--vscode-sideBar-background)); }
    .detected-actions button:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }
    .choices { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
    button { font: inherit; cursor: pointer; }
    .choice { display: flex; align-items: flex-start; text-align: left; gap: 12px; min-height: 90px; padding: 18px 14px; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 8px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); }
    .choice:hover { background: var(--vscode-list-hoverBackground); }
    .choice[aria-expanded="true"] { border-color: var(--vscode-focusBorder); }
    .choice svg { flex: 0 0 20px; width: 20px; height: 20px; margin-top: 2px; fill: none; stroke: currentColor; stroke-width: 1.5; }
    strong { display: block; font-weight: 600; }
    .choice small { display: block; margin-top: 3px; font-size: 11px; color: var(--vscode-descriptionForeground); }
    button:focus-visible, textarea:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 3px; }
    button:disabled { cursor: default; opacity: .6; }
    .drop-zone { margin-top: 20px; border: 1px dashed var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 8px; padding: 36px 24px; text-align: center; }
    .drop-zone.dragging { border-color: var(--vscode-focusBorder); background: var(--vscode-list-dropBackground); }
    .drop-zone p { margin: 6px 0 0; }
    .paste { margin-top: 24px; }
    [hidden] { display: none !important; }
    label { display: block; margin-bottom: 8px; font-weight: 600; }
    textarea { display: block; width: 100%; min-height: 210px; resize: vertical; padding: 12px; border-radius: 5px; border: 1px solid var(--vscode-input-border, var(--vscode-widget-border)); background: var(--vscode-input-background); color: var(--vscode-input-foreground); font: var(--vscode-editor-font-size)/1.55 var(--vscode-editor-font-family); }
    textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
    .paste-footer { margin-top: 10px; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
    .primary { padding: 8px 16px; border: 1px solid transparent; border-radius: 4px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    .primary:hover { background: var(--vscode-button-hoverBackground); }
    .hint { font-size: 12px; }
    #status { min-height: 24px; margin: 20px 0 0; overflow-wrap: anywhere; }
    #status[data-state="error"] { color: var(--vscode-errorForeground); }
    #diagnostic { margin-top: 16px; padding: 12px; border: 1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground)); background: var(--vscode-inputValidation-errorBackground); }
    #diagnostic[hidden] { display: none; }
    #diagnostic strong { color: var(--vscode-errorForeground); }
    #diagnostic button { margin-right: 6px; }
    .privacy { margin-top: 28px; padding-top: 16px; border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); }
    @media (max-width: 560px) { main { padding: 28px 18px; } .choices { grid-template-columns: 1fr; gap: 8px; } .choice { min-height: 68px; padding: 12px; } .paste-footer { align-items: flex-start; flex-direction: column; } }
  </style>
</head>
<body>
  <main>
    <div class="eyebrow">JsonlView</div>
    <h1>Add sources</h1>
    <p class="intro">Choose local files, add a folder, or paste JSONL to start exploring.</p>
    ${detectedSection}
    <div class="choices" aria-label="Source options">
      <button class="choice" id="files" type="button">
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M14 3H6v18h12V7zM14 3v5h4M9 12h6M9 16h6"/></svg>
        <span><strong>Files</strong><small>JSONL and NDJSON</small></span>
      </button>
      <button class="choice" id="folder" type="button">
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 6h7l2 2h9v12H3zM3 6V4h7l2 2h7v2"/></svg>
        <span><strong>Folder</strong><small>A local source folder</small></span>
      </button>
      <button class="choice" id="paste-choice" type="button" aria-expanded="false" aria-controls="paste-section">
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M9 4H5v17h14V4h-4M9 2h6v4H9zM8 11h8M8 15h6"/></svg>
        <span><strong>Paste JSONL</strong><small>Open a text preview</small></span>
      </button>
    </div>
    <div class="drop-zone" id="drop-zone">
      <strong>Drop one JSONL file for a temporary preview</strong>
      <p class="hint">Use Files or Folder to authorize a source.</p>
    </div>
    <section class="paste" id="paste-section" hidden>
      <label for="jsonl">JSONL content</label>
      <textarea id="jsonl" spellcheck="false" autocapitalize="off" autocomplete="off" aria-describedby="paste-hint" placeholder='{"event":"started"}&#10;{"event":"finished"}'></textarea>
      <div class="paste-footer">
        <span class="hint" id="paste-hint">One JSON value per line · up to ${maxMiB} MiB / ${maxRecords} records</span>
        <button class="primary" id="preview" type="button">Open preview</button>
      </div>
    <p class="hint">Pasted text opens as a temporary local file. Reopen it from Recent Previews during this VS Code session; use Save As to keep a permanent copy.</p>
    </section>
    <p id="status" role="status" aria-live="polite"></p>
    <section id="diagnostic" hidden role="alert" aria-live="assertive">
      <strong>Webview error</strong>
      <p id="diagnostic-text" class="hint">The source intake view could not initialize.</p>
      <button id="diagnostic-copy" type="button">Copy diagnostics</button>
      <button id="diagnostic-send" type="button">Send to VS Code AI</button>
    </section>
    <p class="hint privacy">Source files are read-only. Custom folders are added after you confirm their source format.</p>
  </main>
  <script nonce="${nonce}">
    (() => {
      const vscode = acquireVsCodeApi();
      const maxBytes = ${maxBytes};
      const status = document.getElementById('status');
      const text = document.getElementById('jsonl');
      const drop = document.getElementById('drop-zone');
      const pasteChoice = document.getElementById('paste-choice');
      let busy = false;
      let dragDepth = 0;
      function setStatus(message, state) { status.textContent = message; status.dataset.state = state; }
      function setBusy(value) { busy = value; document.querySelectorAll('button').forEach(button => { button.disabled = value; }); text.readOnly = value; }
      function send(message) { if (busy) return; setBusy(true); vscode.postMessage(message); }
      ${JSONL_URI_VALIDATION_HELPER}
      function showDiagnostic(name, message) {
        const safeName = String(name || 'Error').slice(0, 128);
        const safeMessage = String(message || 'Unknown webview error').replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 512);
        const text = safeName + ': ' + (safeMessage || 'Unknown webview error');
        const card = document.getElementById('diagnostic');
        const detail = document.getElementById('diagnostic-text');
        detail.textContent = text;
        card.hidden = false;
        document.getElementById('diagnostic-copy').onclick = () => vscode.postMessage({ type: 'webview-diagnostic', name: safeName, message: safeMessage });
        document.getElementById('diagnostic-send').onclick = () => vscode.postMessage({ type: 'webview-diagnostic', name: safeName, message: safeMessage });
      }
      window.addEventListener('error', event => showDiagnostic('Error', event.message));
      window.addEventListener('unhandledrejection', event => showDiagnostic('UnhandledRejection', event.reason && event.reason.message ? event.reason.message : event.reason));
      document.getElementById('files').addEventListener('click', () => send({ type: 'pick-files' }));
      document.getElementById('folder').addEventListener('click', () => send({ type: 'pick-folder' }));
      document.querySelectorAll('[data-provider]').forEach(button => {
        const provider = button.dataset.provider;
        if (provider) button.addEventListener('click', () => send({ type: 'authorize-agent', provider }));
      });
      function openPasteSection() {
        document.getElementById('paste-section').hidden = false;
        pasteChoice.setAttribute('aria-expanded', 'true'); text.focus();
      }
      pasteChoice.addEventListener('click', openPasteSection);
      document.getElementById('preview').addEventListener('click', () => {
        if (text.value.length > maxBytes || new TextEncoder().encode(text.value).length > maxBytes) {
          setStatus('JSONL preview is limited to 1 MiB. Choose Files to open a larger local source.', 'error'); return;
        }
        send({ type: 'import-jsonl', text: text.value });
      });
      window.addEventListener('message', event => {
        const message = event.data;
        if (!message) return;
        if (message.type === 'open-paste') { openPasteSection(); return; }
        if (message.type !== 'status' || typeof message.text !== 'string') return;
        setBusy(message.state === 'busy'); setStatus(message.text, message.state);
        if (message.clearText === true) text.value = '';
      });
      document.addEventListener('dragenter', event => { event.preventDefault(); dragDepth++; drop.classList.add('dragging'); });
      document.addEventListener('dragleave', event => { event.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; drop.classList.remove('dragging'); } });
      document.addEventListener('dragover', event => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = busy ? 'none' : 'copy'; });
      document.addEventListener('drop', async event => {
        event.preventDefault(); dragDepth = 0; drop.classList.remove('dragging');
        if (busy || !event.dataTransfer) return;
        const transfer = event.dataTransfer;
        const rawUris = transfer.getData('text/uri-list');
        if (rawUris) {
          if (rawUris.length > 65536) { setStatus('Choose up to 32 local sources at a time.', 'error'); return; }
          const uris = rawUris.split(/\r?\n/u).map(value => value.trim()).filter(value => value && !value.startsWith('#'));
          if (uris.length !== 1) { setStatus('Drop one JSONL file for a temporary preview, or choose Files to add several sources.', 'error'); return; }
          if (!hasJsonlExtension(uris[0])) { setStatus('Drop a JSONL or NDJSON file, or choose Files.', 'error'); return; }
          send({ type: 'preview-uris', uris }); return;
        }
        const entries = Array.from(transfer.items || []).map(item => { try { return typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null; } catch { return null; } });
        if (entries.some(entry => entry && entry.isDirectory)) {
          setStatus('Choose the dropped folder in the folder picker. This window cannot read its original path.', 'idle');
          send({ type: 'pick-folder' }); return;
        }
        const files = Array.from(transfer.files);
        if (files.length !== 1) { setStatus('Drop one file for a temporary preview, or choose Files to add several sources.', 'error'); return; }
        const file = files[0];
        if (file.size > maxBytes) { setStatus('Dropped previews are limited to 1 MiB. Choose Files to open a larger source.', 'error'); return; }
        if (!hasJsonlExtension(file.name)) { setStatus('Drop a JSONL or NDJSON file, or choose Files.', 'error'); return; }
        setBusy(true);
        try {
          const buffer = await file.arrayBuffer();
          if (buffer.byteLength > maxBytes) throw new Error('Dropped previews are limited to 1 MiB.');
          const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
          setBusy(false); send({ type: 'import-jsonl', text: content });
        } catch { setBusy(false); setStatus('The dropped file could not be read as UTF-8 JSONL. Choose Files to open it directly.', 'error'); }
      });
    })();
  </script>
</body>
</html>`;
}


export function getSourceDropHtml(): string {
  const nonce = randomBytes(18).toString('base64url');
  const maxBytes = SOURCE_INTAKE_MAX_BYTES;
  const maxMiB = formatMiB(maxBytes);
  return String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none';">
  <style nonce="${nonce}">
    * { box-sizing: border-box; }
    body { margin: 0; min-width: 0; padding: 2px 8px 5px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font: var(--vscode-font-size)/1.35 var(--vscode-font-family); }
    button { min-width: 0; font: inherit; cursor: pointer; }
    .source-card { container: source-card / inline-size; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 6px; padding: 4px; transition: border-color 80ms ease, background-color 80ms ease; }
    .source-card.dragging { border-color: var(--vscode-focusBorder); background: var(--vscode-list-dropBackground); }
    .source-card.invalid-drag { border-color: var(--vscode-errorForeground); background: var(--vscode-inputValidation-errorBackground); }
    .toggle { display: flex; align-items: center; gap: 6px; width: 100%; min-height: 28px; padding: 4px 5px; border: 0; border-radius: 3px; color: var(--vscode-foreground); background: transparent; text-align: left; }
    .toggle:hover { background: var(--vscode-list-hoverBackground); }
    .toggle:focus-visible, .drop:focus-visible, .source-action:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
    .toggle svg { width: 14px; height: 14px; flex: 0 0 14px; fill: none; stroke: currentColor; stroke-width: 1.8; }
    .toggle strong { flex: 1; min-width: 0; overflow: hidden; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
    .toggle small { color: var(--vscode-descriptionForeground); font-size: 10px; white-space: nowrap; }
    .chevron { color: var(--vscode-descriptionForeground); font-size: 13px; line-height: 1; }
    .actions { padding: 3px 0 1px; }
    .drop { display: block; width: 100%; border: 1px dashed var(--vscode-focusBorder); border-radius: 4px; padding: 9px 8px 8px; color: var(--vscode-foreground); background: color-mix(in srgb, var(--vscode-focusBorder) 10%, var(--vscode-sideBar-background)); text-align: center; }
    .drop:hover { background: color-mix(in srgb, var(--vscode-focusBorder) 17%, var(--vscode-sideBar-background)); }
    .drop.dragging { border-color: var(--vscode-focusBorder); background: var(--vscode-list-dropBackground); }
    .drop svg { width: 17px; height: 17px; display: block; margin: 0 auto 3px; fill: none; stroke: currentColor; stroke-width: 1.6; }
    .drop strong { display: block; font-weight: 600; }
    .hint { display: block; margin-top: 3px; color: var(--vscode-descriptionForeground); font-size: 10px; line-height: 1.35; }
    .source-actions { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px; margin: 0 0 5px; }
    .source-action { display: inline-flex; align-items: center; justify-content: center; gap: 4px; width: 100%; min-height: 24px; padding: 3px 8px; border: 1px solid var(--vscode-button-secondaryBorder, var(--vscode-widget-border, var(--vscode-panel-border))); border-radius: 999px; color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); background: var(--vscode-button-secondaryBackground, var(--vscode-sideBar-background)); font-size: 11px; line-height: 1.35; white-space: nowrap; }
    .source-action .codicon { font-family: codicon; font-size: 14px; line-height: 1; }
    .source-action:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }
    .source-action:active, .toggle:active { background: var(--vscode-list-activeSelectionBackground); }
    @media (max-width: 240px) { .source-actions { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @container source-card (max-width: 240px) { .source-actions { grid-template-columns: repeat(2, minmax(0, 1fr)); } .source-action { padding-inline: 5px; } .source-action-label { display: none; } }
    @media (forced-colors: active) { .source-action { border-color: ButtonText; color: ButtonText; background: ButtonFace; } .source-action:active { color: HighlightText; background: Highlight; } .toggle:focus-visible, .drop:focus-visible, .source-action:focus-visible { outline-color: Highlight; } .drop { border-color: ButtonText; } }
    [hidden] { display: none !important; }
    #status { min-height: 14px; margin: 4px 0 0; overflow-wrap: anywhere; font-size: 10px; }
    #status[data-state=error] { color: var(--vscode-errorForeground); }
  </style>
</head>
<body>
  <section class="source-card" id="source-card" aria-label="Add source">
  <button class="toggle" id="toggle" type="button" aria-expanded="true" aria-controls="source-actions">
    <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
    <strong>Add source</strong><small>JSONL / folder</small><span class="chevron" aria-hidden="true">⌄</span>
  </button>
  <section class="actions" id="source-actions" aria-label="Source options">
    <div class="source-actions"><button class="source-action" id="files" type="button" aria-label="Files"><span class="codicon codicon-file" aria-hidden="true"></span><span class="source-action-label">Files</span></button><button class="source-action" id="folder" type="button" aria-label="Folder"><span class="codicon codicon-folder" aria-hidden="true"></span><span class="source-action-label">Folder</span></button><button class="source-action" id="paste" type="button" aria-label="Paste"><span class="codicon codicon-edit" aria-hidden="true"></span><span class="source-action-label">Paste</span></button><button class="source-action" id="connect" type="button" aria-label="Connect"><span class="codicon codicon-plug" aria-hidden="true"></span><span class="source-action-label">Connect</span></button></div>
    <button class="drop" id="drop" type="button">
      <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 16V4m0 0L7 9m5-5 5 5M4 15v4h16v-4"/></svg>
      <strong>Drop JSONL for a temporary preview</strong><span class="hint">or choose a source</span>
    </button>
    <span class="hint">Files and folders stay read-only. Drop or Paste opens a temporary preview; Files and Folder authorize sources.</span>
    <span id="status" role="status" aria-live="polite"></span>
  </section>
  </section>
  <script nonce="${nonce}">
    (() => {
      const v = acquireVsCodeApi();
      const toggle = document.getElementById('toggle');
      const actions = document.getElementById('source-actions');
      const card = document.getElementById('source-card');
      const drop = document.getElementById('drop');
      const statusNode = document.getElementById('status');
      let busy = false;
      function resetDrag() { card.classList.remove('dragging'); card.classList.remove('invalid-drag'); }
      ${JSONL_URI_VALIDATION_HELPER}
      function status(text, state) { statusNode.textContent = text; statusNode.dataset.state = state; }
      function send(message) { if (busy) return; busy = true; status('Adding source…', 'busy'); Promise.resolve(v.postMessage(message)).catch(() => { busy = false; status('Source view was closed. Reopen it and try again.', 'error'); }); }
      toggle.addEventListener('click', () => { const expanded = toggle.getAttribute('aria-expanded') === 'true'; toggle.setAttribute('aria-expanded', String(!expanded)); actions.hidden = expanded; toggle.querySelector('.chevron').textContent = expanded ? '›' : '⌄'; if (!expanded) drop.focus(); });
      drop.addEventListener('click', () => send({ type: 'pick-files' }));
      document.getElementById('files').addEventListener('click', () => send({ type: 'pick-files' }));
      document.getElementById('folder').addEventListener('click', () => send({ type: 'pick-folder' }));
      document.getElementById('paste').addEventListener('click', () => {
        if (busy) return;
        busy = true;
        status('Opening paste editor…', 'busy');
        Promise.resolve(v.postMessage({ type: 'paste-jsonl' })).catch(() => {
          busy = false;
          status('Source view was closed. Reopen it and try again.', 'error');
        });
      });
      document.getElementById('connect').addEventListener('click', () => send({ type: 'connect-agent' }));
      card.addEventListener('dragenter', event => { event.preventDefault(); if (event.relatedTarget && card.contains(event.relatedTarget)) return; if (actions.hidden) { actions.hidden = false; toggle.setAttribute('aria-expanded', 'true'); toggle.querySelector('.chevron').textContent = '⌄'; } card.classList.add('dragging'); });
      card.addEventListener('dragleave', event => { event.preventDefault(); if (!event.relatedTarget || !card.contains(event.relatedTarget)) resetDrag(); });
      card.addEventListener('dragend', resetDrag);
      window.addEventListener('blur', resetDrag);
      card.addEventListener('dragover', event => { event.preventDefault(); if (!event.dataTransfer) return; const raw = event.dataTransfer.getData('text/uri-list'); const uris = raw.split(/\r?\n/u).map(value => value.trim()).filter(value => value && !value.startsWith('#')); const invalidUri = uris.length === 1 && !hasJsonlExtension(uris[0]); card.classList.toggle('invalid-drag', invalidUri); event.dataTransfer.dropEffect = busy || invalidUri ? 'none' : 'copy'; });
      card.addEventListener('drop', event => { event.preventDefault(); resetDrag(); if (busy || !event.dataTransfer) return; const transfer = event.dataTransfer; const raw = transfer.getData('text/uri-list'); if (raw) { const uris = raw.split(/\r?\n/u).map(value => value.trim()).filter(value => value && !value.startsWith('#')); if (uris.length !== 1) { status('Drop one JSONL file for a temporary preview, or choose Files to add several sources.', 'error'); return; } if (!hasJsonlExtension(uris[0])) { status('Drop a JSONL or NDJSON file, or choose Files.', 'error'); return; } send({ type: 'preview-uris', uris }); return; } const entries = Array.from(transfer.items || []).map(item => { try { return typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null; } catch { return null; } }); if (entries.some(entry => entry && entry.isDirectory)) { status('Choose the dropped folder in the folder picker.', 'idle'); send({ type: 'pick-folder' }); return; } const files = Array.from(transfer.files || []); if (files.length === 1 && hasJsonlExtension(files[0].name) && typeof files[0].arrayBuffer === 'function') { const file = files[0]; if (file.size > ${maxBytes}) { status('Dropped previews are limited to ${maxMiB} MiB. Choose Files to open a larger source.', 'error'); return; } busy = true; status('Opening preview…', 'busy'); Promise.resolve(file.arrayBuffer()).then(buffer => { if (buffer.byteLength > ${maxBytes}) throw new Error('oversized'); const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer); busy = false; send({ type: 'import-jsonl', text: content }); }).catch(() => { busy = false; status('The dropped file could not be read as UTF-8 JSONL. Choose Files to open it directly.', 'error'); }); return; } if (files.length > 0) { status('Choose the dropped file in the file picker.', 'idle'); send({ type: 'pick-files' }); return; } status('Drop from the VS Code Explorer or click this box to choose files.', 'idle'); });
      window.addEventListener('message', event => { const message = event.data; if (!message || message.type !== 'status' || typeof message.text !== 'string') return; busy = message.state === 'busy'; status(message.text, message.state); });
    })();
  </script>
</body>
</html>`;
}
