import { randomBytes } from 'node:crypto';

/** Static document: source content only travels as structured messages and textarea values. */
export function getSourceIntakeHtml(): string {
  const nonce = randomBytes(18).toString('base64url');
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
    .privacy { margin-top: 28px; padding-top: 16px; border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); }
    @media (max-width: 560px) { main { padding: 28px 18px; } .choices { grid-template-columns: 1fr; gap: 8px; } .choice { min-height: 68px; padding: 12px; } .paste-footer { align-items: flex-start; flex-direction: column; } }
  </style>
</head>
<body>
  <main>
    <div class="eyebrow">JsonlView</div>
    <h1>Add sources</h1>
    <p class="intro">Choose local files, add a folder, or paste JSONL to start exploring.</p>
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
      <strong>Drop files or a folder here</strong>
      <p class="hint">Local sources stay on your machine.</p>
    </div>
    <section class="paste" id="paste-section" hidden>
      <label for="jsonl">JSONL content</label>
      <textarea id="jsonl" spellcheck="false" autocapitalize="off" autocomplete="off" aria-describedby="paste-hint" placeholder='{"event":"started"}&#10;{"event":"finished"}'></textarea>
      <div class="paste-footer">
        <span class="hint" id="paste-hint">One JSON value per line · up to 1 MiB / 10,000 records</span>
        <button class="primary" id="preview" type="button">Open preview</button>
      </div>
      <p class="hint">Pasted text opens as a temporary local file for this VS Code session.</p>
    </section>
    <p id="status" role="status" aria-live="polite"></p>
    <p class="hint privacy">Source files are read-only. Custom folders are added after you confirm their source format.</p>
  </main>
  <script nonce="${nonce}">
    (() => {
      const vscode = acquireVsCodeApi();
      const maxBytes = 1048576;
      const status = document.getElementById('status');
      const text = document.getElementById('jsonl');
      const drop = document.getElementById('drop-zone');
      const pasteChoice = document.getElementById('paste-choice');
      let busy = false;
      let dragDepth = 0;
      function setStatus(message, state) { status.textContent = message; status.dataset.state = state; }
      function setBusy(value) { busy = value; document.querySelectorAll('button').forEach(button => { button.disabled = value; }); text.readOnly = value; }
      function send(message) { if (busy) return; setBusy(true); vscode.postMessage(message); }
      document.getElementById('files').addEventListener('click', () => send({ type: 'pick-files' }));
      document.getElementById('folder').addEventListener('click', () => send({ type: 'pick-folder' }));
      pasteChoice.addEventListener('click', () => {
        document.getElementById('paste-section').hidden = false;
        pasteChoice.setAttribute('aria-expanded', 'true'); text.focus();
      });
      document.getElementById('preview').addEventListener('click', () => {
        if (text.value.length > maxBytes || new TextEncoder().encode(text.value).length > maxBytes) {
          setStatus('JSONL preview is limited to 1 MiB. Choose Files to open a larger local source.', 'error'); return;
        }
        send({ type: 'import-jsonl', text: text.value });
      });
      window.addEventListener('message', event => {
        const message = event.data;
        if (!message || message.type !== 'status' || typeof message.text !== 'string') return;
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
          send({ type: 'drop-uris', uris }); return;
        }
        const entries = Array.from(transfer.items || []).map(item => typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null);
        if (entries.some(entry => entry && entry.isDirectory)) {
          setStatus('Choose the dropped folder in the folder picker. This window cannot read its original path.', 'idle');
          send({ type: 'pick-folder' }); return;
        }
        const files = Array.from(transfer.files);
        if (files.length !== 1) { setStatus('Drop one file for a temporary preview, or choose Files to add several sources.', 'error'); return; }
        const file = files[0];
        if (file.size > maxBytes) { setStatus('Dropped previews are limited to 1 MiB. Choose Files to open a larger source.', 'error'); return; }
        if (!/\.(jsonl|ndjson)$/iu.test(file.name)) { setStatus('Drop a JSONL or NDJSON file, or choose Files.', 'error'); return; }
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

/** Compact persistent Webview View used as the always-visible local source drop target. */
export function getSourceDropHtml(): string {
  const nonce = randomBytes(18).toString('base64url');
  return String.raw`<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none';"><style nonce="${nonce}">*{box-sizing:border-box}body{margin:0;padding:6px 8px;color:var(--vscode-foreground);background:var(--vscode-sideBar-background);font:var(--vscode-font-size)/1.35 var(--vscode-font-family)}.drop{display:block;width:100%;border:1px dashed var(--vscode-widget-border,var(--vscode-panel-border));border-radius:6px;padding:14px 8px;text-align:center;color:#d7eaff;background:color-mix(in srgb,var(--vscode-focusBorder) 16%,transparent);cursor:pointer}.drop:hover{background:color-mix(in srgb,var(--vscode-focusBorder) 23%,transparent)}.drop.dragging{border-color:var(--vscode-focusBorder);background:var(--vscode-list-dropBackground)}svg{width:20px;height:20px;display:block;margin:0 auto 4px;fill:none;stroke:currentColor;stroke-width:1.6}strong{display:block;font-weight:600}.hint{display:block;margin-top:2px;color:#aebed0;font-size:11px}button{margin-top:6px;padding:3px 9px;border:1px solid var(--vscode-button-border,var(--vscode-button-background));border-radius:3px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);font:inherit;cursor:pointer}button:hover{background:var(--vscode-button-hoverBackground)}button:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}button:disabled{opacity:.6;cursor:default}#status{min-height:14px;margin:4px 0 0;font-size:11px;overflow-wrap:anywhere}#status[data-state=error]{color:var(--vscode-errorForeground)}</style></head><body><button class="drop" id="drop" type="button"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 16V4m0 0L7 9m5-5 5 5M4 15v4h16v-4"/></svg><strong>Drop JSONL here</strong><span class="hint">or choose a local file</span><span id="status" role="status" aria-live="polite"></span></button><script nonce="${nonce}">(()=>{const v=acquireVsCodeApi(),d=document.getElementById('drop'),s=document.getElementById('status');let busy=false,depth=0;function status(t,state){s.textContent=t;s.dataset.state=state}function send(m){if(busy)return;busy=true;status('Adding source…','busy');v.postMessage(m).catch(()=>{busy=false;status('Source view was closed. Reopen it and try again.','error')})}d.addEventListener('click',()=>send({type:'pick-files'}));document.addEventListener('dragenter',e=>{e.preventDefault();depth++;d.classList.add('dragging')});document.addEventListener('dragleave',e=>{e.preventDefault();if(--depth<=0){depth=0;d.classList.remove('dragging')}});document.addEventListener('dragover',e=>{e.preventDefault();if(e.dataTransfer)e.dataTransfer.dropEffect=busy?'none':'copy'});document.addEventListener('drop',e=>{e.preventDefault();depth=0;d.classList.remove('dragging');if(busy||!e.dataTransfer)return;const raw=e.dataTransfer.getData('text/uri-list');if(raw){const uris=raw.split(/\r?\n/u).map(x=>x.trim()).filter(x=>x&&!x.startsWith('#'));send({type:'drop-uris',uris});return}status('Drop from the VS Code Explorer or click this box to choose files.','idle')});window.addEventListener('message',e=>{const m=e.data;if(!m||m.type!=='status'||typeof m.text!=='string')return;busy=m.state==='busy';status(m.text,m.state)})})();</script></body></html>`;
}
