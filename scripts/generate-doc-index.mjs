import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildIndex, stableJson } from './document-metadata.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const indexPath = join(root, 'docs', 'index.json');
const index = await buildIndex(root);
await writeFile(indexPath, stableJson(index), 'utf8');
console.log(JSON.stringify({ ok: true, index: 'docs/index.json', documents: index.documents.length }, null, 2));
