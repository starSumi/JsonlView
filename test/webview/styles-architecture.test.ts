import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const modules = ['tokens', 'base', 'layout', 'workspace-header', 'record-query', 'views', 'source-intake', 'accessibility'] as const;
const root = new URL('../../src/webview/', import.meta.url);
const fixture = JSON.parse(readFileSync(new URL('./fixtures/styles-source-blocks.json', import.meta.url), 'utf8')) as {
  baseline: string;
  blocks: Array<{ sha256: string; module: (typeof modules)[number] }>;
};

function parseTopLevelBlocks(source: string): string[] {
  const blocks: string[] = [];
  let blockStart = 0;
  let index = 0;
  while (index < source.length) {
    const open = source.indexOf('{', index);
    if (open < 0) break;
    let cursor = open + 1;
    let depth = 1;
    let quote = '';
    let comment = false;
    while (cursor < source.length && depth > 0) {
      const current = source[cursor] ?? '';
      const next = source[cursor + 1] ?? '';
      if (comment) {
        if (current === '*' && next === '/') {
          comment = false;
          cursor += 2;
          continue;
        }
        cursor += 1;
        continue;
      }
      if (quote) {
        if (current === '\\') {
          cursor += 2;
          continue;
        }
        if (current === quote) quote = '';
        cursor += 1;
        continue;
      }
      if (current === '/' && next === '*') {
        comment = true;
        cursor += 2;
        continue;
      }
      if (current === '"' || current === "'") {
        quote = current;
        cursor += 1;
        continue;
      }
      if (current === '{') depth += 1;
      if (current === '}') depth -= 1;
      cursor += 1;
    }
    expect(depth, 'unbalanced CSS block near byte ' + open).toBe(0);
    blocks.push(source.slice(blockStart, cursor).trim());
    blockStart = cursor;
    index = cursor;
  }
  expect(source.slice(blockStart).trim(), 'unexpected CSS text after final block').toBe('');
  return blocks.filter(Boolean);
}

function hash(block: string): string {
  return createHash('sha256').update(block.trim()).digest('hex');
}

describe('webview stylesheet architecture', () => {
  it('keeps the eight-module import order explicit', () => {
    const entry = readFileSync(new URL('styles.css', root), 'utf8');
    const imports = entry.split(String.fromCharCode(10)).filter((line) => line.startsWith('@import ')).map((line) => line.slice("@import './styles/".length).replace(".css';", ''));
    expect(imports).toEqual([...modules]);
    expect(fixture.baseline).toBe('b244e86');
  });

  it('preserves every complete source rule block exactly once', () => {
    const expected = new Map<string, string[]>();
    for (const module of modules) expected.set(module, []);
    for (const block of fixture.blocks) expected.get(block.module)?.push(block.sha256);

    const actual = new Map<string, string[]>();
    for (const module of modules) {
      const blocks = parseTopLevelBlocks(readFileSync(new URL('styles/' + module + '.css', root), 'utf8'));
      actual.set(module, blocks.map(hash));
    }

    for (const module of modules) {
      expect(actual.get(module)?.slice().sort(), module).toEqual(expected.get(module)?.slice().sort());
    }
    expect(actual.get('source-intake')).toHaveLength(5);
  });
});
