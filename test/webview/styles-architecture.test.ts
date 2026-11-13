import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const modules = ['tokens', 'base', 'layout', 'workspace-header', 'record-query', 'query-studio', 'views', 'record-lineage', 'document-graph', 'insights-transition', 'source-intake', 'accessibility'] as const;
const root = new URL('../../src/webview/', import.meta.url);
const sourceHashes: Record<(typeof modules)[number], string> = {
  tokens: 'cdc1959a81fa8bdf16476db56f1dd0a80e8ba559e4c7e3a4dcd05f6bd58e5356',
  base: '7e96df3d2c29c1f065eaa22a85f277b1e10dd1af0c63ba7d2780e18cc260bbcb',
  layout: '927fd862193e64b5e0dfae6ee7cfeb3568ac8fcf6897553672eafd7b40411add',
  'workspace-header': '39255a694cc64f44226f630e29e018fec8571da6c98b38bef14fb204357e827b',
  'record-query': '23e9ee63919717d9454100cb38f86fce51ed0f831594b5e6ec0d2d075dc09a91',
  'query-studio': 'd353f2e6964b865846e19fce2b4bdded9f03a9e3e9f8ef4ddb0b781a1ec5d667',
  views: '4a70f91274fbea47704e2df8dda4b426755e7cdd41e679a691019466e297f1e9',
  'record-lineage': '3cabc17b454cf0d956daf4d4d8a177f76b10fc5428244b3284232f602a89fae7',
  'document-graph': 'e9ef9949f5bbb6cd9952a95d7e26eb0d4de48d4acf9eb07fe890745f6ee1900e',
  'insights-transition': '0758789e148eb68169a1ff74e169a707e017251d8ee75770358f70a5fa64d8fc',
  'source-intake': 'e78c9a13a3d01b00885f5c907e5f5f5363b92f7dd7e003687dd28400dc4276b8',
  accessibility: 'e5d91568d6b311c8b7ccc64a8dc6e44268309695d102150436d2c5c0ac1982b2',
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

describe('webview stylesheet architecture', () => {
  it('keeps the stylesheet import order explicit', () => {
    const entry = readFileSync(new URL('styles.css', root), 'utf8');
    const imports = entry.split(String.fromCharCode(10)).filter((line) => line.startsWith('@import ')).map((line) => line.slice("@import './styles/".length).replace(".css';", ''));
    expect(imports).toEqual([...modules]);
  });

  it('keeps complete source rule blocks unique across the stylesheet modules', () => {
    const seen = new Map<string, string>();
    for (const module of modules) {
      const source = readFileSync(new URL('styles/' + module + '.css', root), 'utf8');
      expect(createHash('sha256').update(source).digest('hex'), module + ': stylesheet content changed').toBe(sourceHashes[module]);
      const blocks = parseTopLevelBlocks(source);
      expect(blocks.length, module).toBeGreaterThan(0);
      for (const block of blocks) {
        expect(seen.get(block), module + ': duplicate rule block').toBeUndefined();
        seen.set(block, module);
      }
      if (module === 'source-intake') expect(blocks).toHaveLength(5);
    }
  });

  it('keeps diagnostic banners above modal detail drawers', () => {
    const source = readFileSync(new URL('styles/workspace-header.css', root), 'utf8');
    expect(source).toMatch(/\.workspace-banner\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*10;/su);
  });
});
