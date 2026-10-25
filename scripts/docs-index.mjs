import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { expectedId, parseDocument } from './document-metadata.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const INDEX_RELATIVE_PATH = 'docs/index.json';
const INDEX_SCHEMA = 'jsonlview.documentation-index';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function normalizePath(value) {
  return value.replaceAll('\\', '/');
}

function compareText(left, right) {
  return left.localeCompare(right, 'en', { sensitivity: 'base' });
}

function sortDocuments(documents) {
  return [...documents].sort((left, right) => compareText(left.id, right.id) || compareText(left.path, right.path));
}

function parseOptionValue(args, index, name) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

export function parseArgs(argv) {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith('--') ? args.shift() : 'list';
  const options = { command, positional: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      options.positional.push(arg);
      continue;
    }
    const equals = arg.indexOf('=');
    const name = equals >= 0 ? arg.slice(0, equals) : arg;
    const inlineValue = equals >= 0 ? arg.slice(equals + 1) : undefined;
    if (name === '--help' || name === '-h') {
      options.help = true;
      continue;
    }
    const value = inlineValue ?? parseOptionValue(args, index, name);
    if (inlineValue === undefined) index += 1;
    if (name === '--root') options.root = resolve(value);
    else if (name === '--id') options.id = value;
    else if (name === '--query') options.query = value;
    else if (name === '--kind') options.kind = value;
    else if (name === '--status') options.status = value;
    else if (name === '--tag') options.tag = value;
    else if (name === '--owner') options.owner = value;
    else throw new Error(`unknown option: ${name}`);
  }
  return options;
}

export async function loadIndex(root = DEFAULT_ROOT) {
  const resolvedRoot = resolve(root);
  const indexPath = join(resolvedRoot, INDEX_RELATIVE_PATH);
  let index;
  try {
    index = JSON.parse(await readFile(indexPath, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${INDEX_RELATIVE_PATH}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (index?.schema !== INDEX_SCHEMA || index?.version !== 1 || index?.generated !== true || !Array.isArray(index.documents)) {
    throw new Error(`${INDEX_RELATIVE_PATH} has an invalid generated index header`);
  }
  const documents = sortDocuments(index.documents);
  for (const document of documents) {
    if (!document || typeof document.id !== 'string' || typeof document.path !== 'string' || typeof document.title !== 'string' ||
      typeof document.kind !== 'string' || typeof document.status !== 'string' || typeof document.owner !== 'string' ||
      !Array.isArray(document.tags) || !Array.isArray(document.evidence) || typeof document.summary !== 'string' ||
      !Number.isInteger(document.bytes) || typeof document.sha256 !== 'string') {
      throw new Error(`${INDEX_RELATIVE_PATH} contains an invalid document entry`);
    }
  }
  return { root: resolvedRoot, indexPath, index: { ...index, documents } };
}

function matchesFilters(document, options) {
  if (options.kind && document.kind !== options.kind) return false;
  if (options.status && document.status !== options.status) return false;
  if (options.tag && !document.tags.includes(options.tag)) return false;
  if (options.owner && document.owner !== options.owner) return false;
  return true;
}

export function listDocuments(index, options = {}) {
  return sortDocuments(index.documents).filter((document) => matchesFilters(document, options));
}

export function searchDocuments(index, query, options = {}) {
  const needle = String(query ?? '').trim().toLocaleLowerCase('en');
  if (!needle) return listDocuments(index, options);
  return listDocuments(index, options).filter((document) => {
    const haystack = [document.id, document.path, document.title, document.kind, document.status, document.owner, ...document.tags, document.summary]
      .join('\n')
      .toLocaleLowerCase('en');
    return haystack.includes(needle);
  });
}

function findDocument(index, id) {
  const matches = index.documents.filter((document) => document.id === id);
  if (matches.length === 0) throw new Error(`documentation id not found: ${id}`);
  if (matches.length > 1) throw new Error(`documentation id is ambiguous: ${id}`);
  return matches[0];
}

function assertDocumentPath(root, document) {
  const relativePath = normalizePath(document.path);
  if (!/^docs\/(?:[^/]+\/)*[^/]+\.(?:md|mdx)$/.test(relativePath)) {
    throw new Error(`index entry has an unsafe document path: ${relativePath}`);
  }
  const absolutePath = resolve(root, relativePath);
  const docsRoot = resolve(root, 'docs') + sep;
  if (!absolutePath.startsWith(docsRoot)) throw new Error(`index entry escapes docs/: ${relativePath}`);
  return absolutePath;
}

export async function readDocument(loaded, id) {
  const document = findDocument(loaded.index, id);
  const absolutePath = assertDocumentPath(loaded.root, document);
  const text = await readFile(absolutePath, 'utf8');
  const relativePath = normalizePath(relative(loaded.root, absolutePath));
  if (relativePath !== document.path) throw new Error(`index path mismatch for ${id}: ${relativePath}`);
  if (Buffer.byteLength(text) !== document.bytes || sha256(text) !== document.sha256) {
    throw new Error(`source integrity mismatch for ${id}; regenerate docs/index.json`);
  }
  const parsed = parseDocument(text, relativePath);
  if (parsed.metadata.id !== expectedId(relativePath) || parsed.metadata.id !== id) {
    throw new Error(`source identity mismatch for ${id}`);
  }
  return { ...document, metadata: parsed.metadata, body: parsed.body };
}

export function summarizeIndex(index) {
  const byKind = {};
  const byStatus = {};
  const byTag = {};
  const documents = sortDocuments(index.documents);
  for (const document of documents) {
    byKind[document.kind] = (byKind[document.kind] || 0) + 1;
    byStatus[document.status] = (byStatus[document.status] || 0) + 1;
    for (const tag of [...document.tags].sort(compareText)) byTag[tag] = (byTag[tag] || 0) + 1;
  }
  const items = documents.map(({ id, title, kind, status, summary }) => ({ id, title, kind, status, summary }));
  return { schema: INDEX_SCHEMA, version: 1, documents: documents.length, byKind, byStatus, byTag, items };
}

function usage() {
  return [
    'Usage: node scripts/docs-index.mjs <list|search|read|summary> [options]',
    '  list [--kind KIND] [--status STATUS] [--tag TAG] [--owner OWNER]',
    '  search QUERY [--kind KIND] [--status STATUS] [--tag TAG] [--owner OWNER]',
    '  read ID',
    '  summary',
    '  --root PATH  repository root (defaults to this product checkout)',
    '',
    'The index is read-only. Create/update/delete require a reviewed source edit and index regeneration.',
  ].join('\n');
}

export async function run(argv, root = DEFAULT_ROOT) {
  const options = parseArgs(argv);
  if (options.help) return { ok: true, help: usage() };
  const loaded = await loadIndex(options.root || root);
  const filters = { kind: options.kind, status: options.status, tag: options.tag, owner: options.owner };
  if (options.command === 'list') return { ok: true, command: 'list', documents: listDocuments(loaded.index, filters) };
  if (options.command === 'search') {
    const query = options.query ?? options.positional[0] ?? '';
    return { ok: true, command: 'search', query, documents: searchDocuments(loaded.index, query, filters) };
  }
  if (options.command === 'read') {
    const id = options.id ?? options.positional[0];
    if (!id) throw new Error('read requires a documentation id');
    return { ok: true, command: 'read', document: await readDocument(loaded, id) };
  }
  if (options.command === 'summary') return { ok: true, command: 'summary', summary: summarizeIndex(loaded.index) };
  if (['create', 'update', 'delete'].includes(options.command)) {
    throw new Error(`${options.command} is not available in the read-only index CLI; edit the source document, then regenerate docs/index.json`);
  }
  throw new Error(`unknown command: ${options.command}`);
}

if (pathToFileURL(process.argv[1] || '').href === import.meta.url) {
  try {
    console.log(JSON.stringify(await run(process.argv.slice(2)), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
    process.exitCode = 1;
  }
}
