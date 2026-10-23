import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const modules = ['tokens', 'base', 'layout', 'workspace-header', 'record-query', 'query-studio', 'views', 'source-intake', 'accessibility'] as const;
const root = new URL('../../src/webview/', import.meta.url);
const sourceHashes: Record<(typeof modules)[number], string> = {
  tokens: 'cdc1959a81fa8bdf16476db56f1dd0a80e8ba559e4c7e3a4dcd05f6bd58e5356',
  base: '7e96df3d2c29c1f065eaa22a85f277b1e10dd1af0c63ba7d2780e18cc260bbcb',
  layout: '927fd862193e64b5e0dfae6ee7cfeb3568ac8fcf6897553672eafd7b40411add',
  'workspace-header': '18977650c8692b4537fd8130af38846664f2854b303a6a9531e02aa51fe2542b',
  'record-query': '23e9ee63919717d9454100cb38f86fce51ed0f831594b5e6ec0d2d075dc09a91',
  'query-studio': 'b906145bf351994d5dbc665a0b93e02d57f91aba3bba0507ca56b3db318107ef',
  views: '7a5ad6e2e5a507e5e25ce6d8273560d65f0667a8dcdc24e2aff8197eb2e98ce4',
  'source-intake': 'e78c9a13a3d01b00885f5c907e5f5f5363b92f7dd7e003687dd28400dc4276b8',
  accessibility: '9945ed897b9758efc7c7985497652887bc4a0cb5753e6f9efc29e47258d038be',
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
  it('keeps the eight-module import order explicit', () => {
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
});
