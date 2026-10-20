import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifactDirectory } from './artifact-directory.mjs';
import { CdpClient, findCdpTargetWithinDeadline, runCdpMeasurement } from './cdp-measurement-lifecycle.mjs';
import { isExpectedPageNavigation, parsePageCursorOrdinal, samePageNavigationState } from './page-navigation-measurement.mjs';
import { assertOutsideTree } from './path-boundary.mjs';
import { createMutableSyntheticFixture } from './synthetic-cdp-fixture.mjs';

const port = Number(process.argv[2] ?? '9337');
const outputBaseDirectory = resolve(process.argv[3] ?? artifactDirectory('cdp-smoke'));
const inspectOnly = process.argv.includes('--inspect-only');
const exercise = process.argv.includes('--exercise');
const wide = process.argv.includes('--wide');
const leaveInsights = process.argv.includes('--leave-insights');
const measurePageNavigation = process.argv.includes('--measure-page-navigation');
const syntheticChangeIndex = process.argv.indexOf('--synthetic-change');
const syntheticChange = syntheticChangeIndex === -1 ? undefined : process.argv[syntheticChangeIndex + 1];
const settleMilliseconds = Number(process.env.JSONLVIEW_CDP_SETTLE_MS ?? '12000');
const baseUrl = `http://127.0.0.1:${String(port)}`;
const CDP_OPERATION_TIMEOUT_MS = 20000;
const SYNTHETIC_TARGET_DISCOVERY_TIMEOUT_MS = 30000;

if (!Number.isSafeInteger(settleMilliseconds) || settleMilliseconds < 0) {
  throw new Error('JSONLVIEW_CDP_SETTLE_MS must be a non-negative safe integer.');
}

if (process.argv.some((argument) => ['--follow-file', '--append-file', '--change-file', '--change-kind'].includes(argument))) {
  throw new Error('File mutation modes using a supplied path are disabled.');
}
if (syntheticChangeIndex !== -1 && !['append', 'truncate', 'rewrite'].includes(syntheticChange)) {
  throw new Error('--synthetic-change requires append, truncate, or rewrite.');
}
if (measurePageNavigation && inspectOnly) {
  throw new Error('--measure-page-navigation cannot be combined with --inspect-only.');
}
if (measurePageNavigation && (exercise || wide || leaveInsights || syntheticChangeIndex !== -1)) {
  throw new Error('--measure-page-navigation cannot be combined with other smoke modes.');
}
await assertOutsideTree(resolve(import.meta.dirname, '..'), outputBaseDirectory, 'CDP output');
await mkdir(outputBaseDirectory, { recursive: true });
await assertOutsideTree(resolve(import.meta.dirname, '..'), outputBaseDirectory, 'CDP output');
const outputDirectory = await mkdtemp(join(outputBaseDirectory, 'cdp-run-'));
const ownedFixture = syntheticChange === undefined && !measurePageNavigation ? undefined
  : await createMutableSyntheticFixture(outputDirectory, measurePageNavigation ? 1000 : 250);

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

async function targets() {
  const response = await fetch(`${baseUrl}/json/list`, { signal: AbortSignal.timeout(5000) });
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

async function sampleSyntheticView(target, action, includeDetail = false, timeoutMs = 5000) {
  const client = new CdpClient(target.webSocketDebuggerUrl);
  return runCdpMeasurement({
    client,
    timeoutMs,
    timeoutMessage: 'Synthetic Webview sampling exceeded its deadline.',
    task: async () => {
      await client.open();
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
            detail: ${JSON.stringify(includeDetail)} ? inspected.querySelector('.detail-drawer')?.innerText ?? null : null,
          };
        })()`,
        returnByValue: true,
      });
      return sampled.result.value;
    },
  });
}

async function waitForSyntheticView(target, predicate, timeoutMs = 12000) {
  const deadline = performance.now() + timeoutMs;
  let latest;
  while (performance.now() < deadline) {
    const remainingMs = deadline - performance.now();
    latest = await sampleSyntheticView(target, undefined, false, Math.min(5000, remainingMs));
    if (predicate(latest)) return latest;
    const pauseMs = Math.min(100, deadline - performance.now());
    if (pauseMs <= 0) break;
    await delay(pauseMs);
  }
  return latest;
}

function preparePageNavigationMeasurement(parseCursorOrdinal, probeId) {
  let inspected = document;
  for (let depth = 0; depth < 3; depth += 1) {
    const child = inspected.querySelector('iframe')?.contentDocument;
    if (!child?.body) break;
    inspected = child;
  }
  const view = inspected.defaultView;
  const pager = inspected.querySelector('.page-controls');
  const grid = inspected.querySelector('.data-grid-scroll');
  const cursor = pager?.querySelector('.page-cursor');
  if (!view || !pager || !grid || !cursor) throw new Error('Page navigation controls are not ready.');
  const registryKey = '__jsonlviewPageNavigationMeasurements';
  let registry = view[registryKey];
  if (!registry) {
    registry = new Map();
    view[registryKey] = registry;
  }
  if (registry.get(probeId)?.cancelled) {
    registry.delete(probeId);
    throw new Error('Page navigation measurement was cancelled before preparation.');
  }
  grid.scrollTop = 0;
  return new Promise((resolvePreparation, rejectPreparation) => {
    let timeoutId;
    let retryId;
    const frameIds = new Set();
    let completed = false;
    const finish = (error, result) => {
      if (completed) return;
      completed = true;
      view.clearTimeout(timeoutId);
      view.clearTimeout(retryId);
      for (const frameId of frameIds) view.cancelAnimationFrame(frameId);
      frameIds.clear();
      if (registry.get(probeId) === probe) registry.delete(probeId);
      if (error) rejectPreparation(error);
      else resolvePreparation(result);
    };
    const scheduleFrame = (callback) => {
      const frameId = view.requestAnimationFrame(() => {
        frameIds.delete(frameId);
        if (!completed) callback();
      });
      frameIds.add(frameId);
    };
    const check = () => {
      if (completed) return;
      scheduleFrame(() => scheduleFrame(() => {
        const cursorText = cursor.textContent?.trim() ?? '';
        const cursorOrdinal = parseCursorOrdinal(cursorText);
        const row = cursorOrdinal === undefined ? null
          : grid.querySelector('.data-grid-row[data-row-ordinal="' + cursorOrdinal + '"][data-row-generation]');
        const busy = pager.getAttribute('aria-busy') === 'true' || grid.getAttribute('aria-busy') === 'true';
        if (busy || !row) {
          retryId = view.setTimeout(check, 25);
          return;
        }
        finish(null, {
          page: Number(pager.querySelector('input[aria-label="Page number"]')?.value),
          cursorOrdinal,
          generation: row.dataset.rowGeneration,
        });
      }));
    };
    const probe = { cancel: null };
    probe.cancel = () => finish(new Error('Page navigation preparation was cancelled by the CDP runner.'));
    registry.set(probeId, probe);
    timeoutId = view.setTimeout(() => finish(new Error('Page top did not mount within 10 seconds.')), 10000);
    check();
  });
}

function installPageNavigationMeasurement(direction, parseCursorOrdinal, isSameState, expectedPage, probeId) {
  let inspected = document;
  for (let depth = 0; depth < 3; depth += 1) {
    const child = inspected.querySelector('iframe')?.contentDocument;
    if (!child?.body) break;
    inspected = child;
  }
  const view = inspected.defaultView;
  const pager = inspected.querySelector('.page-controls');
  const grid = inspected.querySelector('.data-grid-scroll');
  const pageInput = pager?.querySelector('input[aria-label="Page number"]');
  const cursor = pager?.querySelector('.page-cursor');
  const buttonTitle = direction === 'next' ? 'Next page' : 'Previous page';
  const button = pager?.querySelector('button[title=' + JSON.stringify(buttonTitle) + ']');
  if (!view || !pager || !grid || !pageInput || !cursor || !button) {
    throw new Error('Page navigation controls are not ready.');
  }
  const registryKey = '__jsonlviewPageNavigationMeasurements';
  let registry = view[registryKey];
  if (!registry) {
    registry = new Map();
    view[registryKey] = registry;
  }
  if (registry.get(probeId)?.cancelled) {
    registry.delete(probeId);
    return Promise.reject(new Error('Page navigation measurement was cancelled before setup.'));
  }
  const fromPage = Number(pageInput.value);
  const fromCursor = cursor.textContent?.trim() ?? '';
  const fromOrdinal = parseCursorOrdinal(fromCursor);
  const firstRow = fromOrdinal === undefined ? null
    : grid.querySelector('.data-grid-row[data-row-ordinal="' + fromOrdinal + '"][data-row-generation]');
  const generation = firstRow?.dataset.rowGeneration;
  if (!Number.isInteger(fromPage) || fromOrdinal === undefined || !generation || button.disabled) {
    throw new Error('Requested page navigation is unavailable.');
  }
  return new Promise((resolveMeasurement, rejectMeasurement) => {
    let startedAt;
    let framePending = false;
    let completed = false;
    let timeoutId;
    let observer;
    const probe = { cancel: null };
    registry.set(probeId, probe);
    const readState = () => {
      const page = Number(pageInput.value);
      const cursorText = cursor.textContent?.trim() ?? '';
      const cursorOrdinal = parseCursorOrdinal(cursorText);
      const row = cursorOrdinal === undefined ? null
        : grid.querySelector('.data-grid-row[data-row-ordinal="' + cursorOrdinal + '"][data-row-generation]');
      const busy = pager.getAttribute('aria-busy') === 'true' || grid.getAttribute('aria-busy') === 'true';
      return {
        page,
        cursorText,
        cursorOrdinal,
        mountedOrdinal: Number(row?.dataset.rowOrdinal),
        generation: row?.dataset.rowGeneration,
        mountedRows: grid.querySelectorAll('.data-grid-row[data-row-ordinal]').length,
        busy,
        ready: cursorText !== fromCursor && cursorText !== 'Loading page...'
          && cursorOrdinal !== fromOrdinal && expectedPage(fromPage, page, direction)
          && row?.dataset.rowGeneration === generation
          && Number.isInteger(Number(row?.dataset.rowOrdinal)),
      };
    };
    const cleanup = () => {
      observer.disconnect();
      pager.removeEventListener('click', onClick, true);
      view.clearTimeout(timeoutId);
      if (registry.get(probeId) === probe) registry.delete(probeId);
    };
    const finish = (error, result) => {
      if (completed) return;
      completed = true;
      cleanup();
      if (error) rejectMeasurement(error);
      else resolveMeasurement(result);
    };
    probe.cancel = () => finish(new Error('Page navigation measurement was cancelled by the CDP runner.'));
    const check = () => {
      if (startedAt === undefined || framePending) return;
      const current = readState();
      if (!current.ready || current.busy) return;
      framePending = true;
      view.requestAnimationFrame(() => view.requestAnimationFrame(() => {
        framePending = false;
        const settled = readState();
        if (!settled.ready || settled.busy) {
          check();
          return;
        }
        if (!isSameState(current, settled)) {
          check();
          return;
        }
        const durationMs = view.performance.now() - startedAt;
        finish(null, {
          direction,
          fromPage,
          toPage: settled.page,
          cursorFirstOrdinal: settled.cursorOrdinal,
          mountedOrdinal: settled.mountedOrdinal,
          mountedRows: settled.mountedRows,
          durationMs,
        });
      }));
    };
    const onClick = (event) => {
      if (!event.isTrusted || !event.composedPath().includes(button)) return;
      if (startedAt !== undefined) {
        finish(new Error('Concurrent page navigation clicks cannot share one measurement.'));
        return;
      }
      startedAt = view.performance.now();
      observer.observe(pager, { attributes: true, childList: true, characterData: true, subtree: true });
      observer.observe(grid, { attributes: true, childList: true, characterData: true, subtree: true });
      check();
    };
    timeoutId = view.setTimeout(() => {
      finish(new Error('Page navigation did not commit within 15 seconds.'));
    }, 15000);
    observer = new view.MutationObserver(check);
    pager.addEventListener('click', onClick, true);
  });
}

function cancelPageNavigationMeasurement(probeId) {
  let inspected = document;
  for (let depth = 0; depth < 3; depth += 1) {
    const child = inspected.querySelector('iframe')?.contentDocument;
    if (!child?.body) break;
    inspected = child;
  }
  const view = inspected.defaultView;
  const registry = view?.__jsonlviewPageNavigationMeasurements;
  const probe = registry?.get(probeId);
  if (probe?.cancel) probe.cancel();
  else registry?.set(probeId, { cancelled: true });
}

async function identifySyntheticTarget(target, timeoutMs = CDP_OPERATION_TIMEOUT_MS) {
  const client = new CdpClient(target.webSocketDebuggerUrl);
  return runCdpMeasurement({
    client,
    timeoutMs,
    timeoutMessage: 'Synthetic target identification exceeded 20 seconds.',
    task: async () => {
      await client.open();
      const evaluated = await client.send('Runtime.evaluate', {
        expression: '(() => { let inspected = document; for (let depth = 0; depth < 3; depth += 1) { const child = inspected.querySelector("iframe")?.contentDocument; if (!child?.body) break; inspected = child; } return { appShell: Boolean(inspected.querySelector(".app-shell")), uri: inspected.body?.dataset.uri ?? null }; })()',
        returnByValue: true,
      });
      return evaluated.result.value;
    },
  });
}

async function collectPageNavigationMeasurements(target) {
  let probeSequence = 0;
  const measureDirection = async (direction) => {
    const probeId = 'page-nav:' + direction + ':' + String(++probeSequence);
    const expression = '(' + installPageNavigationMeasurement.toString() + ')(' + JSON.stringify(direction)
      + ', ' + parsePageCursorOrdinal.toString() + ', ' + samePageNavigationState.toString()
      + ', ' + isExpectedPageNavigation.toString()
      + ', ' + JSON.stringify(probeId) + ')';
    const client = new CdpClient(target.webSocketDebuggerUrl);
    const prepareExpression = '(' + preparePageNavigationMeasurement.toString()
      + ')(' + parsePageCursorOrdinal.toString() + ', ' + JSON.stringify(probeId) + ')';
    return runCdpMeasurement({
      client,
      timeoutMs: CDP_OPERATION_TIMEOUT_MS,
      timeoutMessage: 'Page navigation CDP measurement exceeded 20 seconds.',
      cancelTimeoutMs: 1000,
      task: async () => {
        await client.open();
        const preparedResponse = await client.send('Runtime.evaluate', {
          expression: prepareExpression, awaitPromise: true, returnByValue: true,
        });
        if (preparedResponse.exceptionDetails) {
          throw new Error(preparedResponse.exceptionDetails.exception?.description ?? preparedResponse.exceptionDetails.text);
        }
        const evaluation = client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
          .then((response) => ({ response }), (error) => ({ error }));
        const buttonTitle = direction === 'next' ? 'Next page' : 'Previous page';
        const selector = '.page-controls button[title=' + JSON.stringify(buttonTitle) + ']';
        const clickExpression = '(() => { let inspected = document; for (let depth = 0; depth < 3; depth += 1) { const child = inspected.querySelector("iframe")?.contentDocument; if (!child?.body) break; inspected = child; } return inspected.querySelector(' + JSON.stringify(selector) + '); })()';
        const clicked = await clickElement(client, clickExpression);
        if (!clicked) throw new Error('The ' + direction + ' page button was not clickable.');
        const outcome = await evaluation;
        if (outcome.error) throw outcome.error;
        const result = outcome.response;
        if (result.exceptionDetails) {
          throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
        }
        return result.result.value;
      },
      onTimeout: () => {
        const cancelExpression = '(' + cancelPageNavigationMeasurement.toString() + ')(' + JSON.stringify(probeId) + ')';
        return client.send('Runtime.evaluate', { expression: cancelExpression });
      },
    });
  };
  const warmupsPerDirection = 3;
  const measuredSamplesPerDirection = 20;
  const measured = { next: [], previous: [] };
  for (let index = 0; index < warmupsPerDirection; index += 1) {
    await measureDirection('next');
    await measureDirection('previous');
  }
  for (let index = 0; index < measuredSamplesPerDirection; index += 1) {
    measured.next.push(await measureDirection('next'));
    measured.previous.push(await measureDirection('previous'));
  }
  const summarize = (samples) => {
    const sorted = samples.map((sample) => sample.durationMs).sort((left, right) => left - right);
    const percentile = (value) => sorted[Math.max(0, Math.ceil(value * sorted.length) - 1)];
    const round = (value) => Number(value.toFixed(3));
    return {
      sampleCount: samples.length,
      minMs: round(sorted[0]),
      p50Ms: round(percentile(0.5)),
      p95Ms: round(percentile(0.95)),
      maxMs: round(sorted.at(-1)),
    };
  };
  return {
    metric: 'webview-click-to-committed-dom-settle-proxy-plus-two-animation-frames',
    clock: 'window.performance.now',
    cacheCondition: 'run-owned synthetic fixture already indexed; paired warm-view sequence',
    completionCondition: 'page number advances exactly one page in the requested direction, its cursor-first ordinal is mounted with the same generation, pager and grid idle, same page state survives two animation-frame callbacks',
    presentationGuaranteed: false,
    percentileMethod: 'nearest-rank',
    warmupsPerDirection,
    measuredSamplesPerDirection,
    directions: {
      next: { summary: summarize(measured.next), samples: measured.next },
      previous: { summary: summarize(measured.previous), samples: measured.previous },
    },
  };
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
  await runCdpMeasurement({
    client: workbenchClient,
    timeoutMs: CDP_OPERATION_TIMEOUT_MS,
    timeoutMessage: 'Synthetic fixture open exceeded 20 seconds.',
    task: async () => {
      await workbenchClient.open();
      await key(workbenchClient, 'Escape', 'Escape', 27);
      await key(workbenchClient, 'p', 'KeyP', 80, 2);
      await delay(350);
      await workbenchClient.send('Input.insertText', { text: ownedFixture.fixture });
      await delay(500);
      await key(workbenchClient, 'Enter', 'Enter', 13);
      await delay(900);
    },
  });
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
if (!measurePageNavigation) {
  for (let index = 0; index < inspectable.length; index += 1) {
    inspections.push(await inspectTarget(inspectable[index], index));
  }
}

let ownedFixtureTarget;
let ownedFixtureBefore;
if (ownedFixture) {
  if (measurePageNavigation) {
    const fixtureTarget = await findCdpTargetWithinDeadline({
      candidates: inspectable,
      probe: identifySyntheticTarget,
      matches: (identity) => identity?.appShell && isOwnedFixtureUri(identity.uri, ownedFixture.fixture),
      timeoutMs: SYNTHETIC_TARGET_DISCOVERY_TIMEOUT_MS,
      timeoutMessage: `Synthetic fixture target discovery exceeded ${String(SYNTHETIC_TARGET_DISCOVERY_TIMEOUT_MS / 1000)} seconds.`,
    });
    ownedFixtureTarget = fixtureTarget?.candidate;
  } else {
    const inspectedFixture = inspections.find((entry) =>
      isOwnedFixtureUri(entry.inspection?.bodyDataset?.uri, ownedFixture.fixture));
    ownedFixtureTarget = inspectable.find((entry) => entry.id === inspectedFixture?.target.id);
  }
  if (!ownedFixtureTarget) throw new Error('The isolated host did not open the run-owned synthetic fixture.');
  const expectedRecords = measurePageNavigation ? 1000 : 250;
  ownedFixtureBefore = await waitForSyntheticView(ownedFixtureTarget,
    (sample) => sample?.indexedRecords === expectedRecords);
  if (ownedFixtureBefore?.indexedRecords !== expectedRecords || ownedFixtureBefore.pending || ownedFixtureBefore.blocked) {
    throw new Error('Synthetic fixture did not reach a stable indexed baseline; no mutation was made.');
  }
}

let changeResult = null;
if (ownedFixture && syntheticChange !== undefined) {
  const target = ownedFixtureTarget;
  const before = ownedFixtureBefore;
  await ownedFixture.change(syntheticChange);
  const after = await waitForSyntheticView(target, (sample) =>
    syntheticChange === 'append' ? sample?.pending === true : sample?.blocked === true);
  await sampleSyntheticView(target, 'select');
  await delay(350);
  const selected = await sampleSyntheticView(target, undefined, true);
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

const pageNavigation = measurePageNavigation
  ? await collectPageNavigationMeasurements(ownedFixtureTarget)
  : null;

const result = {
  port,
  outputDirectory,
  targetCount: currentTargets.length,
  ...(measurePageNavigation ? {} : { inspections }),
  ...(changeResult === null ? {} : { change: changeResult }),
  ...(pageNavigation === null ? {} : { pageNavigation }),
};
await writeFile(resolve(outputDirectory, 'result.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
console.log(JSON.stringify(result, null, 2));
if (changeResult !== null && !changeResult.pass) process.exitCode = 1;
if (pageNavigation !== null && (pageNavigation.directions.next.summary.sampleCount !== 20
  || pageNavigation.directions.previous.summary.sampleCount !== 20)) process.exitCode = 1;
} finally {
  await ownedFixture?.close();
}
