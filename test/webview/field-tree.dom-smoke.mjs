// Real native details, controlled checkboxes and Enter submit; no DOM shim or new dependency.
// node test/webview/field-tree.dom-smoke.mjs <chromium-executable> <outside-product-output-directory>
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { CdpClient } from '../../scripts/cdp-measurement-lifecycle.mjs';
import { assertOutsideTree } from '../../scripts/path-boundary.mjs';

const product = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const browserPath = process.argv[2];
if (!browserPath || !process.argv[3]) throw new Error('Supply a Chromium executable and an output directory outside the product.');
const output = resolve(process.argv[3]);
await assertOutsideTree(product, output, 'Field-tree DOM evidence');
await mkdir(output, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'jsonlview-field-tree-browser-'));
const source = (path) => JSON.stringify(join(product, path).replaceAll('\\', '/'));
await build({
  stdin: { resolveDir: product, loader: 'tsx', contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { ColumnChooser } from ${source('src/webview/features/record-query/ColumnChooser.tsx')};
    import { RecordQueryControls } from ${source('src/webview/features/record-query/RecordQueryControls.tsx')};
    import ${source('src/webview/styles.css')};
    const column = (...tokens) => ({ id: JSON.stringify(tokens), label: '$.' + tokens.map(t => t.kind === 'key' ? t.value : '[' + t.value + ']').join('.'), source: 'record', path: { tokens } });
    const key = value => ({ kind: 'key', value });
    const type = column(key('type'));
    const indexed = column(key('type'), { kind: 'index', value: 0 }, key('name'));
    const columns = [type, indexed, ...Array.from({ length: 248 }, (_, i) => column(key('f' + i)))];
    const sources = [{ column: type, values: ['response_item', 'message'], sampled: true }];
    window.receipt = { columns: [], selections: [], runs: 0 };
    function Fixture() {
      const [selected, setSelected] = useState(new Set());
      const [selection, setSelection] = useState();
      const [query, setQuery] = useState('needle');
      const noop = () => {};
      return <><ColumnChooser columns={columns} schema={[]} selectedRecordIds={selected} visibility={{}}
        recordColumnLimit={64} schemaComplete={true} schemaLoadFailed={false} onRetrySchema={noop}
        onVisibilityChange={(column, visible) => {
          window.receipt.columns.push({ id: column.id, path: column.path, visible });
          setSelected(current => { const next = new Set(current); visible ? next.add(column.id) : next.delete(column.id); return next; });
        }} rowTypes={{ sources, selection, disabled: false, onChange: value => {
          window.receipt.selections.push(value ?? null); setSelection(value);
        } }} />
        <RecordQueryControls query={query} searchDisabled={false} sortDirection="asc"
          descendingDisabled={false} descendingDisabledReason="" onSortDirectionChange={noop}
          onSearchSubmit={() => { window.receipt.runs += 1; }} onSearchChange={setQuery} onSearchClear={() => setQuery('')}
          filterActive={false} filters={[]} filterableColumns={columns} filterColumnId={type.id}
          filterOperator="contains" filterOperators={[{ value: 'contains', label: 'contains', needsValue: true }]}
          filterValue="" filterCaseSensitive={false} onFilterColumnChange={noop} onFilterOperatorChange={noop}
          onFilterValueChange={noop} onFilterCaseSensitiveChange={noop} onFilterSubmit={noop} onFilterClear={noop} />
      </>;
    }
    createRoot(document.getElementById('root')).render(<Fixture />);
  ` },
  bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  tsconfig: join(product, 'tsconfig.json'), outfile: join(output, 'fixture.js'),
});
await writeFile(join(output, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>');

const browser = spawn(browserPath, ['--headless=new', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`, 'about:blank'],
{ windowsHide: true, stdio: 'ignore' });
let client;
const pause = () => new Promise((done) => setTimeout(done, 25));
const until = async (read, timeout = 10_000) => {
  const deadline = performance.now() + timeout;
  let lastError;
  while (performance.now() < deadline) {
    try { const value = await read(); if (value) return value; } catch (error) { lastError = error; }
    await pause();
  }
  throw new Error('Timed out waiting for browser state', { cause: lastError });
};
const evaluate = async (expression) => {
  const result = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
};
const click = async (expression) => {
  const point = await evaluate(`(async () => { const e = (${expression}); if (!e) throw new Error('Missing click target');
    e.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
    const r=e.getBoundingClientRect(); const p={ x:r.x+r.width/2, y:r.y+r.height/2 };
    const hit=document.elementFromPoint(p.x,p.y); if (!e.contains(hit)) throw new Error('Click target is obscured: '+e.outerHTML+' at '+JSON.stringify(p)+' by '+hit?.outerHTML);
    return p; })()`);
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
};
const summary = (title) => `Array.from(document.querySelectorAll('summary[title]')).find(e => e.getAttribute('title') === ${JSON.stringify(title)})`;
const dynamic = `document.querySelectorAll('.field-tree-section')[1]`;
try {
  const activePort = await until(async () => (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
  const targets = await (await fetch(`http://127.0.0.1:${activePort}/json/list`)).json();
  client = new CdpClient(targets.find((target) => target.type === 'page').webSocketDebuggerUrl);
  await client.open();
  await client.send('Page.navigate', { url: pathToFileURL(join(output, 'index.html')).href });
  await until(() => evaluate('Boolean(document.querySelector(".columns-menu"))'));
  const quotedTitle = `quote'"\\]; globalThis.unexpectedTitleCode = true; //`;
  await evaluate(`(() => { const e = document.createElement('summary'); e.title = ${JSON.stringify(quotedTitle)};
    e.id = 'quoted-title-probe'; document.body.append(e); })()`);
  assert.equal(await evaluate(`(${summary(quotedTitle)})?.id`), 'quoted-title-probe');
  assert.equal(await evaluate('globalThis.unexpectedTitleCode === true'), false);
  await evaluate("document.getElementById('quoted-title-probe').remove()");
  const initial = await evaluate(`({ dynamicItems: (${dynamic}).querySelector(':scope > ul').children.length,
    dynamicCheckboxes: (${dynamic}).querySelectorAll('input[type=checkbox]').length,
    rowControls: document.querySelectorAll('.row-type-filter-fields').length,
    treeElements: (${dynamic}).querySelectorAll('*').length })`);
  assert.equal(initial.dynamicItems, 25); // 24 roots plus an explicit Show more control.
  assert.equal(initial.dynamicCheckboxes, 23); // The type branch remains unmounted.
  assert.equal(initial.rowControls, 0);
  assert.ok(initial.treeElements < 150);
  await click('document.querySelector(".columns-menu > summary")');
  await click(summary('$.type'));
  await until(() => evaluate(`Boolean((${summary('$.type')}).parentElement.querySelector(':scope > label > input'))`));
  await click(`(${summary('$.type')}).parentElement.querySelector(':scope > label > input')`);
  await until(() => evaluate('window.receipt.columns.length === 1'));
  assert.equal(await evaluate(`(${summary('$.type')}).parentElement.querySelector(':scope > label > input').checked`), true);
  await click(`document.querySelector('.field-tree-row-types > summary')`);
  await until(() => evaluate('document.querySelectorAll(".row-type-filter-fields").length === 1'));
  await click('document.querySelectorAll(".row-type-option input")[0]');
  await until(() => evaluate('window.receipt.selections.length === 1'));
  await click('document.querySelectorAll(".row-type-option input")[1]');
  await until(() => evaluate('window.receipt.selections.length === 2'));
  assert.deepEqual(await evaluate('window.receipt.selections.at(-1).values'), ['response_item', 'message']);
  assert.equal(await evaluate('document.querySelectorAll(".row-type-option input:checked").length'), 2);
  await click(`Array.from(document.querySelectorAll('.row-type-filter-fields button')).find(e=>e.textContent==='Show all types')`);
  await until(() => evaluate('window.receipt.selections.at(-1) === null'));
  await click(summary('$.type[]'));
  await until(() => evaluate(`Boolean(${summary('$.type[0]')})`));
  await click(summary('$.type[0]'));
  await until(() => evaluate(`Boolean((${summary('$.type[0]')}).parentElement.querySelector('label input'))`));
  await click(`(${summary('$.type[0]')}).parentElement.querySelector('label input')`);
  await until(() => evaluate('window.receipt.columns.length === 2'));
  assert.deepEqual(await evaluate('window.receipt.columns.at(-1).path.tokens'), [
    { kind: 'key', value: 'type' }, { kind: 'index', value: 0 }, { kind: 'key', value: 'name' },
  ]);
  await click(summary('$.type'));
  await until(() => evaluate('document.querySelectorAll(".row-type-filter-fields").length === 0'));
  for (let page = 0; page < 11; page += 1) {
    if (!await evaluate(`Boolean((${dynamic}).querySelector(':scope > ul > li > button'))`)) break;
    await click(`(${dynamic}).querySelector(':scope > ul > li > button')`);
    await pause();
  }
  assert.equal(await evaluate(`(${dynamic}).querySelector(':scope > ul').children.length`), 249);
  assert.equal(await evaluate(`Boolean((${dynamic}).querySelector('span[title="$.f247"]'))`), true);
  await evaluate(`(() => { const e=document.querySelector('[aria-label="Search field columns"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'$.f247'); e.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await until(() => evaluate(`(${dynamic}).querySelector(':scope > ul').children.length === 1`));
  assert.equal(await evaluate(`(${dynamic}).querySelectorAll('input[type=checkbox]').length`), 1);
  await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await until(() => evaluate('document.querySelector(".columns-menu").open === false'));
  await evaluate(`document.querySelector('[aria-label="Search records"]').focus()`);
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await until(() => evaluate('window.receipt.runs === 1'));
  const receipt = { browser: await client.send('Browser.getVersion'), initial,
    observed: await evaluate('window.receipt'), pagedRoots: 249, searchableLastField: true,
    nativeMouseAndKeyboard: true, scope: 'real Chromium component fixture; not a VS Code host acceptance' };
  await writeFile(join(output, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify(receipt));
} catch (error) {
  if (client) await writeFile(join(output, 'failure.json'), JSON.stringify(await evaluate(`({ receipt:window.receipt,
    disclosures:Array.from(document.querySelectorAll('details')).map(e=>({ open:e.open, summary:e.querySelector(':scope > summary')?.textContent })) })`), null, 2)).catch(() => {});
  throw error;
} finally {
  if (client) { await client.send('Browser.close').catch(() => {}); client.close(); }
  if (browser.exitCode === null) await Promise.race([
    new Promise((done) => browser.once('exit', done)), new Promise((done) => setTimeout(done, 3000)),
  ]);
  if (browser.exitCode === null) browser.kill();
  // This exact mkdtemp-owned path is the only recursively removed directory.
  if (!resolve(profile).startsWith(`${resolve(tmpdir())}${sep}jsonlview-field-tree-browser-`)) throw new Error('Unexpected browser profile path');
  await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
}
