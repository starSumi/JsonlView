import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifactDirectory } from './artifact-directory.mjs';
import { assertOutsideTree } from './path-boundary.mjs';
import { createMutableSyntheticFixture } from './synthetic-cdp-fixture.mjs';

const port = Number(process.argv[2] ?? '9337');
const outputBaseDirectory = resolve(process.argv[3] ?? artifactDirectory('cdp-smoke'));
const inspectOnly = process.argv.includes('--inspect-only');
const exercise = process.argv.includes('--exercise');
const wide = process.argv.includes('--wide');
const leaveInsights = process.argv.includes('--leave-insights');
const syntheticChangeIndex = process.argv.indexOf('--synthetic-change');
const syntheticChange = syntheticChangeIndex === -1 ? undefined : process.argv[syntheticChangeIndex + 1];
const settleMilliseconds = Number(process.env.JSONLVIEW_CDP_SETTLE_MS ?? '12000');
const baseUrl = `http://127.0.0.1:${String(port)}`;

if (!Number.isSafeInteger(settleMilliseconds) || settleMilliseconds < 0) {
  throw new Error('JSONLVIEW_CDP_SETTLE_MS must be a non-negative safe integer.');
}

if (process.argv.some((argument) => ['--follow-file', '--append-file', '--change-file', '--change-kind'].includes(argument))) {
  throw new Error('File mutation modes using a supplied path are disabled.');
}
if (syntheticChangeIndex !== -1 && !['append', 'truncate', 'rewrite'].includes(syntheticChange)) {
  throw new Error('--synthetic-change requires append, truncate, or rewrite.');
}
await assertOutsideTree(resolve(import.meta.dirname, '..'), outputBaseDirectory, 'CDP output');
await mkdir(outputBaseDirectory, { recursive: true });
await assertOutsideTree(resolve(import.meta.dirname, '..'), outputBaseDirectory, 'CDP output');
const outputDirectory = await mkdtemp(join(outputBaseDirectory, 'cdp-run-'));
const ownedFixture = syntheticChange === undefined ? undefined
  : await createMutableSyntheticFixture(outputDirectory, 250);

class CdpClient {
  #nextId = 0;
  #pending = new Map();

  constructor(url) {
    this.socket = new WebSocket(url);
  }

  async open() {
    await new Promise((resolveOpen, rejectOpen) => {
      this.socket.addEventListener('open', resolveOpen, { once: true });
      this.socket.addEventListener('error', rejectOpen, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id === undefined) return;
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = ++this.#nextId;
    return new Promise((resolveRequest, rejectRequest) => {
      this.#pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

async function targets() {
  const response = await fetch(`${baseUrl}/json/list`);
  if (!response.ok) throw new Error(`CDP target list failed: ${String(response.status)}`);
  return response.json();
}

async function key(client, keyName, code, keyCode, modifiers = 0) {
  await client.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: keyName,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    modifiers,
  });
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: keyName,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    modifiers,
  });
}

async function clickElement(client, expression) {
  const evaluated = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const element = (${expression});
      const rect = element?.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) return null;
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`,
    returnByValue: true,
  });
  const point = evaluated.result.value;
  if (!point) return false;
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  return true;
}

async function inspectTarget(target, index) {
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.open();
  try {
    await client.send('Runtime.enable');
    if (target.type === 'page') await client.send('Page.enable');
    let exerciseResult = null;
    if (exercise && (target.type === 'page' || target.type === 'iframe')) {
      const exercised = await client.send('Runtime.evaluate', {
        expression: `(async () => {
          let inspected = document;
          for (let depth = 0; depth < 3; depth += 1) {
            const child = inspected.querySelector('iframe')?.contentDocument;
            if (!child?.body) break;
            inspected = child;
          }
          if (!inspected.querySelector('.app-shell')) return null;
          const view = inspected.defaultView;
          const wait = (milliseconds) => new Promise((resolveWait) => view.setTimeout(resolveWait, milliseconds));
          const button = (label) => [...inspected.querySelectorAll('button')]
            .find((candidate) => candidate.textContent?.trim().startsWith(label));

          if (!inspected.querySelector('.detail-drawer')) {
            inspected.querySelector('.data-grid-row')?.click();
            await wait(350);
          }

          button('Tree')?.click();
          await wait(100);
          const eventPresentation = inspected.querySelector('.event-presentation');
          const eventTitle = eventPresentation?.querySelector('.event-presentation-title')?.textContent?.trim() ?? null;
          const eventText = eventPresentation?.querySelector('.event-text')?.textContent ?? null;
          const treeRowsBefore = inspected.querySelectorAll('.tree-row').length;
          const nestedToggle = [...inspected.querySelectorAll('.tree-toggle')]
            .find((candidate) => candidate.getAttribute('aria-label')?.startsWith('Expand '));
          const nestedLabel = nestedToggle?.getAttribute('aria-label') ?? null;
          nestedToggle?.click();
          await wait(100);
          const treeRowsAfter = inspected.querySelectorAll('.tree-row').length;

          button('Raw')?.click();
          await wait(100);
          const prettyButton = button('Pretty');
          const sourceButton = button('Source');
          const prettyActive = prettyButton?.getAttribute('aria-pressed') === 'true';
          const prettyPane = inspected.querySelector('.json-fold-view.json-pretty, pre.json-pretty');
          const prettyText = prettyPane?.textContent ?? '';
          const foldLinesBefore = prettyPane?.querySelectorAll('.json-line').length ?? 0;
          const highlightedKinds = [...new Set([...inspected.querySelectorAll('.json-token')]
            .map((token) => [...token.classList].find((name) => name.startsWith('json-token-') && name !== 'json-token'))
            .filter(Boolean))];
          const tokenColors = Object.fromEntries([...inspected.querySelectorAll('.json-token')]
            .slice(0, 80)
            .map((token) => [[...token.classList].find((name) => name.startsWith('json-token-') && name !== 'json-token'), view.getComputedStyle(token).color])
            .filter(([kind]) => kind));
          const foldToggle = prettyPane?.querySelector('.json-fold-toggle');
          foldToggle?.click();
          await wait(100);
          const foldLinesAfter = prettyPane?.querySelectorAll('.json-line').length ?? 0;
          sourceButton?.click();
          await wait(100);
          const sourceText = inspected.querySelector('pre.json-source')?.textContent ?? '';
          const sourceActive = sourceButton?.getAttribute('aria-pressed') === 'true';

          const splitter = inspected.querySelector('.detail-splitter');
          const drawer = inspected.querySelector('.detail-drawer');
          const widthBefore = drawer?.getBoundingClientRect().width ?? null;
          if (splitter) {
            splitter.dispatchEvent(new view.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
            await wait(100);
          }
          const widthAfterKeyboard = drawer?.getBoundingClientRect().width ?? null;
          if (splitter) {
            const pointerX = splitter.getBoundingClientRect().x;
            splitter.dispatchEvent(new view.PointerEvent('pointerdown', {
              pointerId: 41,
              pointerType: 'mouse',
              button: 0,
              buttons: 1,
              clientX: pointerX,
              bubbles: true,
            }));
            view.dispatchEvent(new view.PointerEvent('pointermove', {
              pointerId: 41,
              pointerType: 'mouse',
              buttons: 1,
              clientX: pointerX - 80,
            }));
            view.dispatchEvent(new view.PointerEvent('pointerup', {
              pointerId: 41,
              pointerType: 'mouse',
              button: 0,
              clientX: pointerX - 80,
            }));
            await wait(100);
          }
          const widthAfterPointer = drawer?.getBoundingClientRect().width ?? null;
          prettyButton?.click();
          await wait(100);

          button('Insights')?.click();
          for (let attempt = 0; attempt < 120; attempt += 1) {
            if (inspected.querySelector('.insights-panel') || inspected.querySelector('.insights-state[data-kind="error"]')) break;
            await wait(50);
          }
          const insights = {
            panels: inspected.querySelectorAll('.insights-panel').length,
            charts: inspected.querySelectorAll('.insights-chart').length,
            bars: inspected.querySelectorAll('.insights-chart-bar').length,
            rows: inspected.querySelectorAll('.insights-table tbody tr').length,
            meta: inspected.querySelector('.insights-meta')?.textContent?.trim() ?? null,
            error: inspected.querySelector('.insights-state[data-kind="error"]')?.textContent?.trim() ?? null,
          };
          button('Schema')?.click();
          await wait(250);
          const schemaRowsBefore = inspected.querySelectorAll('.schema-tree-row').length;
          const schemaToggle = [...inspected.querySelectorAll('.schema-tree-toggle')]
            .find((candidate) => candidate.getAttribute('aria-label')?.startsWith('Expand '));
          const schemaToggleLabel = schemaToggle?.getAttribute('aria-label') ?? null;
          schemaToggle?.click();
          await wait(100);
          const schemaRowsAfter = inspected.querySelectorAll('.schema-tree-row').length;
          button('Problems')?.click();
          for (let attempt = 0; attempt < 120; attempt += 1) {
            if (
              inspected.querySelector('.problems-view .problem-row')
              || inspected.querySelector('.problems-view .workspace-banner')
            ) break;
            await wait(50);
          }
          const problemsBefore = {
            rows: inspected.querySelectorAll('.problem-row').length,
            partial: Boolean(inspected.querySelector('.problems-view .workspace-banner')),
            body: inspected.querySelector('.problems-view')?.textContent?.trim() ?? null,
          };
          const continueButton = button('Continue scan');
          const canContinue = Boolean(continueButton);
          continueButton?.click();
          if (canContinue) {
            for (let attempt = 0; attempt < 120; attempt += 1) {
              const nextButton = button('Continue scan');
              if (!nextButton || !nextButton.disabled) break;
              await wait(50);
            }
          }
          const problemsAfter = {
            rows: inspected.querySelectorAll('.problem-row').length,
            partial: Boolean(inspected.querySelector('.problems-view .workspace-banner')),
          };
          if (!${leaveInsights ? 'true' : 'false'}) {
            button('Table')?.click();
            await wait(100);
          }

          return {
            event: {
              present: Boolean(eventPresentation),
              title: eventTitle,
              multiline: Boolean(eventText?.includes('\\n')),
            },
            tree: { nestedLabel, rowsBefore: treeRowsBefore, rowsAfter: treeRowsAfter },
            raw: {
              prettyActive,
              prettyHasLineBreaks: foldLinesBefore > 1,
              prettyLength: prettyText.length,
              foldLinesBefore,
              foldLinesAfter,
              foldControls: prettyPane?.querySelectorAll('.json-fold-toggle').length ?? 0,
              sourceActive,
              sourceLength: sourceText.length,
              sourcePhysicalLineCount: sourceText ? sourceText.split('\\n').length : 0,
              highlightedKinds,
              tokenColors,
            },
            splitter: { widthBefore, widthAfterKeyboard, widthAfterPointer },
            insights,
            schema: { schemaToggleLabel, rowsBefore: schemaRowsBefore, rowsAfter: schemaRowsAfter },
            problems: { before: problemsBefore, after: problemsAfter, canContinue },
          };
        })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      exerciseResult = exercised.result.value;
    }

    const evaluation = await client.send('Runtime.evaluate', {
      expression: `(() => {
        let inspected = document;
        for (let depth = 0; depth < 3; depth += 1) {
          const child = inspected.querySelector('iframe')?.contentDocument;
          if (!child?.body) break;
          inspected = child;
        }
        const root = inspected.querySelector('#root');
        const rootRect = root?.getBoundingClientRect();
        return {
        title: inspected.title,
        url: inspected.defaultView?.location.href ?? location.href,
        readyState: inspected.readyState,
        bodyText: (inspected.body?.innerText ?? '').slice(0, 6000),
        bodyDataset: inspected.body ? { ...inspected.body.dataset } : {},
        rootChildren: root?.childElementCount ?? null,
        rowCount: inspected.querySelectorAll('.data-grid-row').length,
        timelineCount: inspected.querySelectorAll('.timeline-row').length,
        treeRowCount: inspected.querySelectorAll('.tree-row').length,
        treeToggleCount: inspected.querySelectorAll('.tree-toggle').length,
        jsonTokenCount: inspected.querySelectorAll('.json-token').length,
        rawMode: [...inspected.querySelectorAll('.raw-mode-switch button')].map((button) => ({
          label: button.textContent?.trim(),
          pressed: button.getAttribute('aria-pressed'),
          disabled: button.disabled,
        })),
        splitter: (() => {
          const element = inspected.querySelector('.detail-splitter');
          const drawer = inspected.querySelector('.detail-drawer');
          return element ? {
            valueNow: element.getAttribute('aria-valuenow'),
            valueMin: element.getAttribute('aria-valuemin'),
            valueMax: element.getAttribute('aria-valuemax'),
            drawerWidth: drawer?.getBoundingClientRect().width ?? null,
          } : null;
        })(),
        selectedProfile: inspected.querySelector('.profile-field select')?.value ?? null,
        statusText: inspected.querySelector('.status-strip')?.innerText ?? null,
        copyButtons: [...inspected.querySelectorAll('button.copy-button')].map((button) => ({
          label: button.getAttribute('aria-label'),
          disabled: button.disabled,
        })),
        codePane: (() => {
          const content = inspected.querySelector('.detail-content');
          const pane = inspected.querySelector('.code-pane');
          const fold = inspected.querySelector('.json-fold-view');
          if (!content || !pane) return null;
          return {
            contentClientWidth: content.clientWidth,
            contentScrollWidth: content.scrollWidth,
            paneClientWidth: pane.clientWidth,
            paneScrollWidth: pane.scrollWidth,
            paneRectWidth: pane.getBoundingClientRect().width,
            foldScrollWidth: fold?.scrollWidth ?? null,
            background: inspected.defaultView?.getComputedStyle(pane).backgroundColor ?? null,
          };
        })(),
        geometry: {
          documentClientWidth: inspected.documentElement.clientWidth,
          documentScrollWidth: inspected.documentElement.scrollWidth,
          documentClientHeight: inspected.documentElement.clientHeight,
          documentScrollHeight: inspected.documentElement.scrollHeight,
          root: rootRect ? { x: rootRect.x, y: rootRect.y, width: rootRect.width, height: rootRect.height } : null,
        },
        iframes: [...document.querySelectorAll('iframe, webview')].map((element) => ({
          tag: element.tagName,
          title: element.getAttribute('title'),
          src: element.getAttribute('src'),
          className: element.getAttribute('class'),
        })),
      }; })()`,
      returnByValue: true,
    });
    let screenshotPath = null;
    if (target.type === 'page') {
      const screenshot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      screenshotPath = resolve(outputDirectory, `target-${String(index)}-${target.type}.png`);
      await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'), { flag: 'wx' });
    }
    return {
      target: { id: target.id, type: target.type, title: target.title, url: target.url },
      inspection: evaluation.result.value,
      exercise: exerciseResult,
      screenshotPath,
    };
  } finally {
    client.close();
  }
}

function isOwnedFixtureUri(uri, fixture) {
  try {
    return resolve(fileURLToPath(uri)).toLowerCase() === resolve(fixture).toLowerCase();
  } catch {
    return false;
  }
}

async function sampleSyntheticView(target, action) {
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.open();
  try {
    const sampled = await client.send('Runtime.evaluate', {
      expression: `(() => {
        let inspected = document;
        for (let depth = 0; depth < 3; depth += 1) {
          const child = inspected.querySelector('iframe')?.contentDocument;
          if (!child?.body) break;
          inspected = child;
        }
        if (!inspected.querySelector('.app-shell')) return null;
        if (${JSON.stringify(action)} === 'select') inspected.querySelectorAll('.data-grid-row')[1]?.click();
        if (${JSON.stringify(action)} === 'rebuild') {
          (inspected.querySelector('.snapshot-update button')
            ?? inspected.querySelector('.invalidated-banner button'))?.click();
        }
        return {
          uri: inspected.body?.dataset.uri ?? null,
          indexedRecords: Number.parseInt(inspected.querySelector('.status-records')?.textContent ?? '', 10),
          pending: Boolean(inspected.querySelector('.snapshot-update')),
          blocked: Boolean(inspected.querySelector('.invalidated-banner')),
          detail: inspected.querySelector('.detail-drawer')?.innerText ?? null,
        };
      })()`,
      returnByValue: true,
    });
    return sampled.result.value;
  } finally {
    client.close();
  }
}

async function waitForSyntheticView(target, predicate) {
  let latest;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    latest = await sampleSyntheticView(target);
    if (predicate(latest)) return latest;
    await delay(100);
  }
  return latest;
}

try {
const initialTargets = await targets();
const workbench = initialTargets.find((target) => target.type === 'page' && target.url.includes('workbench.html'));
if (!workbench) throw new Error('VS Code workbench target was not found.');

if (wide) {
  const workbenchClient = new CdpClient(workbench.webSocketDebuggerUrl);
  await workbenchClient.open();
  try {
    const visible = await workbenchClient.send('Runtime.evaluate', {
      expression: `(() => ({
        primary: document.querySelector('.part.sidebar')?.getBoundingClientRect().width ?? 0,
        secondary: document.querySelector('.part.auxiliarybar')?.getBoundingClientRect().width ?? 0,
      }))()`,
      returnByValue: true,
    });
    if ((visible.result.value?.primary ?? 0) > 0) {
      await key(workbenchClient, 'b', 'KeyB', 66, 2);
      await delay(300);
    }
    if ((visible.result.value?.secondary ?? 0) > 0) {
      await key(workbenchClient, 'P', 'KeyP', 80, 2 | 8);
      await delay(300);
      await workbenchClient.send('Input.insertText', { text: 'View: Toggle Secondary Side Bar Visibility' });
      await delay(500);
      await key(workbenchClient, 'Enter', 'Enter', 13);
      await delay(500);
    }
  } finally {
    workbenchClient.close();
  }
}

if (ownedFixture) {
  const workbenchClient = new CdpClient(workbench.webSocketDebuggerUrl);
  await workbenchClient.open();
  try {
    await key(workbenchClient, 'Escape', 'Escape', 27);
    await key(workbenchClient, 'p', 'KeyP', 80, 2);
    await delay(350);
    await workbenchClient.send('Input.insertText', { text: ownedFixture.fixture });
    await delay(500);
    await key(workbenchClient, 'Enter', 'Enter', 13);
    await delay(900);
  } finally {
    workbenchClient.close();
  }
}

if (!inspectOnly && !ownedFixture) {
  const workbenchClient = new CdpClient(workbench.webSocketDebuggerUrl);
  await workbenchClient.open();
  try {
    await workbenchClient.send('Runtime.evaluate', {
      expression: `(() => {
        const button = [...document.querySelectorAll('button')]
          .find((candidate) => candidate.textContent?.includes('Continue without Signing In'));
        button?.click();
      })()`,
    });
    await delay(300);
    await key(workbenchClient, 'Escape', 'Escape', 27);
    await delay(250);
    let paletteOpened = false;
    for (let attempt = 0; attempt < 20 && !paletteOpened; attempt += 1) {
      await key(workbenchClient, 'P', 'KeyP', 80, 2 | 8);
      await delay(250);
      const paletteState = await workbenchClient.send('Runtime.evaluate', {
        expression: `(() => {
          const element = document.querySelector('.quick-input-widget');
          const rect = element?.getBoundingClientRect();
          return Boolean(rect && rect.width > 0 && rect.height > 0);
        })()`,
        returnByValue: true,
      });
      paletteOpened = paletteState.result.value === true;
      if (!paletteOpened) await key(workbenchClient, 'Escape', 'Escape', 27);
      if (!paletteOpened) await delay(250);
    }
    if (!paletteOpened) {
      for (let attempt = 0; attempt < 20 && !paletteOpened; attempt += 1) {
        await key(workbenchClient, 'Escape', 'Escape', 27);
        await clickElement(workbenchClient, `document.querySelector('.menubar-menu-button[aria-label="View"]')`);
        await delay(300);
        paletteOpened = await clickElement(workbenchClient, `[
          ...document.querySelectorAll('.monaco-menu .action-menu-item')
        ].find((candidate) => candidate.textContent?.includes('Command Palette'))`);
        if (!paletteOpened) await delay(250);
      }
    }
    if (!paletteOpened) throw new Error('VS Code Command Palette was not visible.');
    await delay(500);
    await workbenchClient.send('Input.insertText', { text: 'JsonlView: Open as Data Studio' });
    await delay(500);
    const resultClicked = await clickElement(workbenchClient, `[
      ...document.querySelectorAll('.quick-input-list .monaco-list-row')
    ].find((candidate) => candidate.textContent?.includes('JsonlView: Open as Data Studio'))`);
    if (!resultClicked) await key(workbenchClient, 'Enter', 'Enter', 13);
  } finally {
    workbenchClient.close();
  }
}

await delay(settleMilliseconds);
const currentTargets = await targets();
const inspectable = currentTargets.filter((target) =>
  target.webSocketDebuggerUrl
  && (target.type === 'page' || target.type === 'webview' || target.type === 'iframe'),
).sort((left, right) => {
  const priority = (target) => target.type === 'iframe' ? 0 : target.type === 'webview' ? 1 : 2;
  return priority(left) - priority(right);
});
const inspections = [];
for (let index = 0; index < inspectable.length; index += 1) {
  inspections.push(await inspectTarget(inspectable[index], index));
}

let changeResult = null;
if (ownedFixture) {
  const inspectedFixture = inspections.find((entry) =>
    isOwnedFixtureUri(entry.inspection?.bodyDataset?.uri, ownedFixture.fixture));
  if (!inspectedFixture) throw new Error('The isolated host did not open the run-owned synthetic fixture.');
  const target = inspectable.find((entry) => entry.id === inspectedFixture.target.id);
  const before = await waitForSyntheticView(target, (sample) => sample?.indexedRecords === 250);
  if (before?.indexedRecords !== 250 || before.pending || before.blocked) {
    throw new Error('Synthetic fixture did not reach a stable indexed baseline; no mutation was made.');
  }
  await ownedFixture.change(syntheticChange);
  const after = await waitForSyntheticView(target, (sample) =>
    syntheticChange === 'append' ? sample?.pending === true : sample?.blocked === true);
  await sampleSyntheticView(target, 'select');
  await delay(350);
  const selected = await sampleSyntheticView(target);
  if (after?.pending || after?.blocked) await sampleSyntheticView(target, 'rebuild');
  const expectedRows = syntheticChange === 'append' ? 251 : syntheticChange === 'truncate' ? 0 : 250;
  const rebuilt = await waitForSyntheticView(target, (sample) =>
    sample?.indexedRecords === expectedRows && !sample.pending && !sample.blocked);
  const selectedCorrectly = syntheticChange === 'append'
    ? selected?.detail?.includes('Record #1') && !selected.detail.includes('unavailable')
    : selected?.detail?.includes('Record #1 unavailable');
  changeResult = {
    kind: syntheticChange,
    fixture: ownedFixture.fixture,
    before,
    after,
    selected,
    rebuilt,
    pass: before.indexedRecords === 250 && after?.indexedRecords === 250
      && (syntheticChange === 'append' ? after.pending && !after.blocked : after.blocked)
      && selectedCorrectly && rebuilt?.indexedRecords === expectedRows && !rebuilt.pending && !rebuilt.blocked,
  };
}

const result = {
  port,
  outputDirectory,
  targetCount: currentTargets.length,
  inspections,
  ...(changeResult === null ? {} : { change: changeResult }),
};
await writeFile(resolve(outputDirectory, 'result.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
console.log(JSON.stringify(result, null, 2));
if (changeResult !== null && !changeResult.pass) process.exitCode = 1;
} finally {
  await ownedFixture?.close();
}
