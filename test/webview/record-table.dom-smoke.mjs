// Real React mount, TanStack virtualizer, measured scroll layout, and native pointer click.
// node test/webview/record-table.dom-smoke.mjs <chromium-executable> <outside-product-output-directory>
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
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
await assertOutsideTree(product, output, 'RecordTable DOM evidence');
await mkdir(output, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'jsonlview-record-table-browser-'));
const source = (path) => JSON.stringify(join(product, path).replaceAll('\\', '/'));
await build({
  stdin: { resolveDir: product, loader: 'tsx', contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { RecordTable } from ${source('src/webview/features/record-query/RecordTable.tsx')};
    import ${source('src/webview/styles.css')};
    const rows = Array.from({ length: 800 }, (_, index) => ({
      ref: { generation: 'g1', ordinal: String(index), byteStart: String(index * 10),
        byteEndExclusive: String(index * 10 + 9), contentByteLength: '9',
        delimiterByteLength: index === 799 ? 0 : 1, parseState: 'valid' },
      cells: [{ columnId: '__ordinal', value: String(index) }, { columnId: 'value', value: 'row-' + index }],
      genericSummary: 'row-' + index,
    }));
    const columns = [{ id: '__ordinal', label: '#', source: 'system' },
      { id: 'value', label: 'Value', source: 'record' }];
    window.receipt = { selected: [] };
    function Fixture() {
      const [selectedOrdinal, setSelectedOrdinal] = useState('0');
      return <div style={{ display: 'flex', flexDirection: 'column', height: '360px', width: '720px' }}><RecordTable sessionId="dom-smoke"
        rows={rows} columns={columns} selectedOrdinal={selectedOrdinal} loading={false}
        onSelect={ref => { window.receipt.selected.push(ref.ordinal); setSelectedOrdinal(ref.ordinal); }}
        columnWidths={{}} onColumnWidthChange={() => {}} onColumnOrderChange={() => {}} /></div>;
    }
    createRoot(document.getElementById('root')).render(<Fixture />);
  ` },
  bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  tsconfig: join(product, 'tsconfig.json'), outfile: join(output, 'fixture.js'),
});
await writeFile(join(output, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><style>html,body,#root{height:100%;margin:0}</style><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>');

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
  if (result.exceptionDetails) throw new Error(result.result?.description ?? result.exceptionDetails.text);
  return result.result.value;
};
const click = async (expression) => {
  const point = await evaluate(`(() => { const e = (${expression}); if (!e) throw new Error('Missing click target');
    const r=e.getBoundingClientRect(); return { x:r.x+r.width/2, y:r.y+r.height/2 }; })()`);
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
};
try {
  const activePort = await until(async () => (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
  const targets = await (await fetch(`http://127.0.0.1:${activePort}/json/list`)).json();
  client = new CdpClient(targets.find((target) => target.type === 'page').webSocketDebuggerUrl);
  await client.open();
  await client.send('Page.navigate', { url: pathToFileURL(join(output, 'index.html')).href });
  await until(() => evaluate('Boolean(document.querySelector(".data-grid-scroll[role=grid] .virtual-space"))'));

  const initial = await evaluate(`(() => { const grid=document.querySelector('.data-grid-scroll');
    const rows=[...grid.querySelectorAll('[data-row-ordinal]')];
    return { viewportHeight:grid.clientHeight, totalHeight:grid.querySelector('.virtual-space').getBoundingClientRect().height,
      rowCount:Number(grid.getAttribute('aria-rowcount')), mountedRows:rows.length,
      firstOrdinal:rows[0]?.dataset.rowOrdinal, firstHeight:rows[0]?.getBoundingClientRect().height }; })()`);
  assert.equal(initial.viewportHeight, 360);
  assert.equal(initial.rowCount, 801);
  assert.ok(initial.totalHeight >= 24_000);
  assert.ok(initial.mountedRows < 80, `expected virtualized rows, observed ${initial.mountedRows}`);
  assert.equal(initial.firstOrdinal, '0');
  assert.ok(initial.firstHeight >= 29 && initial.firstHeight <= 31);

  await evaluate(`(() => { const grid=document.querySelector('.data-grid-scroll'); grid.scrollTop=21_000;
    grid.dispatchEvent(new Event('scroll')); })()`);
  await until(() => evaluate(`Boolean(document.querySelector('[data-row-ordinal="700"]'))`));
  const farRow = await evaluate(`(() => { const row=document.querySelector('[data-row-ordinal="700"]');
    return { index:row.getAttribute('aria-rowindex'), top:row.getBoundingClientRect().top,
      transform:getComputedStyle(row).transform }; })()`);
  assert.equal(farRow.index, '702');
  assert.ok(Number.isFinite(farRow.top));
  await click(`document.querySelector('[data-row-ordinal="700"] [role="gridcell"]')`);
  await until(() => evaluate('window.receipt.selected.at(-1) === "700"'));
  assert.equal(await evaluate(`document.querySelector('[data-row-ordinal="700"]').getAttribute('aria-selected')`), 'true');

  const receipt = { initial, farRow, selectedOrdinal: '700', browser: await client.send('Browser.getVersion'),
    scope: 'real React DOM mount with @tanstack/react-virtual; synthetic rows; not a VS Code host acceptance' };
  await writeFile(join(output, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify(receipt));
} catch (error) {
  if (client) {
    const diagnostic = await evaluate(`({ selected:window.receipt?.selected,
      grid:document.querySelector('.data-grid-scroll')?.outerHTML.slice(0,3000) })`).catch(() => undefined);
    if (diagnostic !== undefined) {
      await writeFile(join(output, 'failure.json'), JSON.stringify(diagnostic, null, 2)).catch(() => {});
    }
  }
  throw error;
} finally {
  if (client) { await client.send('Browser.close').catch(() => {}); client.close(); }
  if (browser.exitCode === null) await Promise.race([
    new Promise((done) => browser.once('exit', done)), new Promise((done) => setTimeout(done, 3000)),
  ]);
  if (browser.exitCode === null) browser.kill();
  if (!resolve(profile).startsWith(`${resolve(tmpdir())}${sep}jsonlview-record-table-browser-`)) throw new Error('Unexpected browser profile path');
  await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
}
