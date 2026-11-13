import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { parse } from '@babel/parser';
import { describe, expect, it, vi } from 'vitest';

const source = await readFile(new URL('../../scripts/vscode-cdp-smoke.mjs', import.meta.url), 'utf8');
const declaration = parse(source, { sourceType: 'module' }).program.body.find((node) =>
  node.type === 'FunctionDeclaration' && node.id?.name === 'sampleSyntheticView');
if (declaration?.start == null || declaration.end == null) throw new Error('Missing synthetic view sampler');
const samplerSource = source.slice(declaration.start, declaration.end);

async function rebuild(selectors: Readonly<Record<string, unknown>>) {
  const document = {
    body: { dataset: { uri: 'file:///synthetic.jsonl' } },
    querySelector: (selector: string) => {
      if (selector === '.app-shell') return {};
      if (selector === '.status-records') return { textContent: '250 rows' };
      return selectors[selector] ?? null;
    },
  };
  class Client {
    async open() {}
    async send(_method: string, { expression }: { expression: string }) {
      try {
        return { result: { value: runInNewContext(expression, { document }) } };
      } catch (error) {
        return {
          result: {},
          exceptionDetails: { text: 'Uncaught', exception: { description: String(error) } },
        };
      }
    }
  }
  // Evaluate the actual driver function without running its CLI or contacting a host.
  const sample = runInNewContext(`(${samplerSource})`, {
    CdpClient: Client,
    runCdpMeasurement: ({ task }: { task: () => Promise<unknown> }) => task(),
  }) as (target: { webSocketDebuggerUrl: string }, action: string) => Promise<unknown>;
  return sample({ webSocketDebuggerUrl: 'ws://synthetic.invalid' }, 'rebuild');
}

describe('synthetic CDP Rebuild action', () => {
  it.each([
    ['the workspace header action', 'button.rebuild-action'],
    ['the legacy append action', '.snapshot-update button'],
    ['the invalidated source action', '.invalidated-banner button'],
  ])('clicks %s before sampling the view', async (_name, selector) => {
    const click = vi.fn();

    await expect(rebuild({ [selector]: { disabled: false, click } })).resolves.toMatchObject({ indexedRecords: 250 });

    expect(click).toHaveBeenCalledOnce();
  });

  it('prefers the current workspace header action over legacy actions', async () => {
    const click = vi.fn();
    const legacyClick = vi.fn();

    await rebuild({
      'button.rebuild-action': { disabled: false, click },
      '.snapshot-update button': { disabled: false, click: legacyClick },
    });

    expect(click).toHaveBeenCalledOnce();
    expect(legacyClick).not.toHaveBeenCalled();
  });

  it('rejects a missing Rebuild action instead of silently sampling an unchanged view', async () => {
    await expect(rebuild({})).rejects.toThrow('Synthetic Rebuild action was not found');
  });

  it('rejects a disabled Rebuild action without clicking it', async () => {
    const click = vi.fn();

    await expect(rebuild({ 'button.rebuild-action': { disabled: true, click } }))
      .rejects.toThrow('Synthetic Rebuild action is disabled');

    expect(click).not.toHaveBeenCalled();
  });
});
