import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { artifactDirectory } from './artifact-directory.mjs';

const port = Number(process.argv[2] ?? '9337');
const outputDirectory = resolve(process.argv[3] ?? artifactDirectory('cdp-smoke'));
const inspectOnly = process.argv.includes('--inspect-only');
const exercise = process.argv.includes('--exercise');
const wide = process.argv.includes('--wide');
const leaveInsights = process.argv.includes('--leave-insights');
const followFileIndex = process.argv.indexOf('--follow-file');
const followFile = followFileIndex >= 0 ? resolve(process.argv[followFileIndex + 1] ?? '') : undefined;
const baseUrl = `http://127.0.0.1:${String(port)}`;
let followUsed = false;

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
            .find((candidate) => candidate.textContent?.trim() === label);

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
          };
        })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      exerciseResult = exercised.result.value;
    }

    let followResult = null;
    if (followFile && exerciseResult && !followUsed) {
      followUsed = true;
      const enabled = await client.send('Runtime.evaluate', {
        expression: `(() => {
          let inspected = document;
          for (let depth = 0; depth < 3; depth += 1) {
            const child = inspected.querySelector('iframe')?.contentDocument;
            if (!child?.body) break;
            inspected = child;
          }
          const input = inspected.querySelector('.follow-toggle input');
          if (!input) return null;
          if (!input.checked) input.click();
          return {
            checked: input.checked,
            rowCount: inspected.querySelectorAll('.data-grid-row').length,
            status: inspected.querySelector('.status-strip')?.innerText ?? '',
          };
        })()`,
        returnByValue: true,
      });
      await delay(250);
      await appendFile(followFile, `${JSON.stringify({
        timestamp: new Date().toISOString(),
        type: 'event_msg',
        payload: { type: 'follow_smoke', message: 'appended during CDP smoke' },
      })}\n`);
      const sampled = await client.send('Runtime.evaluate', {
        expression: `(async () => {
          let inspected = document;
          for (let depth = 0; depth < 3; depth += 1) {
            const child = inspected.querySelector('iframe')?.contentDocument;
            if (!child?.body) break;
            inspected = child;
          }
          const view = inspected.defaultView;
          const samples = [];
          for (let attempt = 0; attempt < 120; attempt += 1) {
            samples.push({
              rowCount: inspected.querySelectorAll('.data-grid-row').length,
              empty: Boolean(inspected.querySelector('.empty-state')),
              busy: inspected.querySelector('.data-grid-scroll')?.getAttribute('aria-busy') ?? null,
              status: inspected.querySelector('.status-strip')?.innerText ?? '',
            });
            await new Promise((resolveWait) => view.setTimeout(resolveWait, 25));
          }
          return {
            samples: samples.length,
            minimumRows: Math.min(...samples.map((sample) => sample.rowCount)),
            maximumRows: Math.max(...samples.map((sample) => sample.rowCount)),
            zeroRowSamples: samples.filter((sample) => sample.rowCount === 0).length,
            emptyStateSamples: samples.filter((sample) => sample.empty).length,
            busySamples: samples.filter((sample) => sample.busy === 'true').length,
            finalStatus: samples.at(-1)?.status ?? '',
          };
        })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      followResult = { enabled: enabled.result.value, sampled: sampled.result.value };
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
      await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));
    }
    return {
      target: { id: target.id, type: target.type, title: target.title, url: target.url },
      inspection: evaluation.result.value,
      exercise: exerciseResult,
      follow: followResult,
      screenshotPath,
    };
  } finally {
    client.close();
  }
}

await mkdir(outputDirectory, { recursive: true });
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

if (!inspectOnly) {
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
    await key(workbenchClient, 'P', 'KeyP', 80, 2 | 8);
    await delay(500);
    await workbenchClient.send('Input.insertText', { text: 'JsonlView: Open as Data Studio' });
    await delay(800);
    await key(workbenchClient, 'Enter', 'Enter', 13);
  } finally {
    workbenchClient.close();
  }
}

await delay(12_000);
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

const result = {
  port,
  targetCount: currentTargets.length,
  inspections,
};
await writeFile(resolve(outputDirectory, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
