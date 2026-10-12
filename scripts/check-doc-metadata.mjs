import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const schemaPath = join(root, 'docs', 'metadata', 'schema.yaml');
const indexPath = join(root, 'docs', 'metadata', 'index.yaml');
const required = ['id', 'path', 'title', 'kind', 'status', 'owner', 'tags', 'evidence', 'revisit', 'rollback'];
const failures = [];

const parseScalar = (value) => {
  const trimmed = value.trim();
  if (trimmed === '[]') return [];
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1).split(',').map((item) => item.trim()).filter(Boolean);
  }
  if ((trimmed.startsWith('\"') && trimmed.endsWith('\"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const parseCatalog = (text) => {
  const top = {};
  const documents = [];
  let current;
  for (const [lineNumber, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.replace(/\s+$/, '');
    if (!line || line.trimStart().startsWith('#')) continue;
    if (/^ {2}- id: /.test(line)) {
      current = { id: line.slice(8).trim(), __line: lineNumber + 1 };
      documents.push(current);
      continue;
    }
    const field = line.match(/^ {4}([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/);
    if (field && current) {
      current[field[1]] = parseScalar(field[2]);
      continue;
    }
    const rootField = line.match(/^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/);
    if (rootField && !current) {
      top[rootField[1]] = parseScalar(rootField[2]);
      continue;
    }
    failures.push(`index.yaml:${lineNumber + 1} has unsupported YAML syntax`);
  }
  return { top, documents };
};

const allMarkdownFiles = async (directory) => {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await allMarkdownFiles(absolute)));
    else if (entry.isFile() && entry.name.endsWith('.md')) result.push(absolute);
  }
  return result;
};

const schema = await readFile(schemaPath, 'utf8');
const catalogText = await readFile(indexPath, 'utf8');
const catalog = parseCatalog(catalogText);
const schemaRequired = schema.match(/required: \[(.+)\]/)?.[1]?.split(',').map((item) => item.trim()) ?? [];
const schemaKinds = schema.match(/kinds: \[(.+)\]/)?.[1]?.split(',').map((item) => item.trim()) ?? [];
const schemaStatuses = schema.match(/statuses: \[(.+)\]/)?.[1]?.split(',').map((item) => item.trim()) ?? [];
if (!schema.includes('schema: jsonlview.documentation-metadata')) failures.push('schema.yaml must declare jsonlview.documentation-metadata');
if (schemaRequired.join(',') !== required.join(',')) failures.push('schema.yaml required fields must match the validator contract');
if (!schema.includes('extensionPrefix: x-')) failures.push('schema.yaml must reserve x- extension fields');
if (catalog.top.schema !== 'jsonlview.documentation-metadata' || catalog.top.version !== '1') {
  failures.push('index.yaml must declare schema jsonlview.documentation-metadata version 1');
}
if (!Array.isArray(catalog.documents) || catalog.documents.length === 0) failures.push('index.yaml must contain documents');

const seenIds = new Set();
const seenPaths = new Set();
for (const document of catalog.documents) {
  for (const field of required) {
    if (!(field in document)) failures.push(`index.yaml:${document.__line} is missing ${field}`);
  }
  for (const field of Object.keys(document)) {
    if (!field.startsWith('__') && !required.includes(field) && !field.startsWith('x-')) {
      failures.push(`index.yaml:${document.__line} contains unknown field ${field}; use x- prefix for extensions`);
    }
  }
  if (seenIds.has(document.id)) failures.push(`duplicate documentation id: ${document.id}`);
  seenIds.add(document.id);
  const path = typeof document.path === 'string' ? document.path : '';
  if (!path.startsWith('docs/') || !path.endsWith('.md') || path.includes('\\') || path.includes('..')) {
    failures.push(`invalid documentation path: ${path}`);
  }
  if (seenPaths.has(path)) failures.push(`duplicate documentation path: ${path}`);
  seenPaths.add(path);
  if (!schemaKinds.includes(document.kind)) failures.push(`${document.id} has unsupported kind ${document.kind}`);
  if (!schemaStatuses.includes(document.status)) failures.push(`${document.id} has unsupported status ${document.status}`);
  if (document.owner !== 'product') failures.push(`${document.id} must be owned by product`);
  if (!Array.isArray(document.tags) || document.tags.length === 0) failures.push(`${document.id} must have at least one tag`);
  if (!Array.isArray(document.evidence)) failures.push(`${document.id} evidence must be an array`);
  if (typeof document.revisit !== 'string' || document.revisit.length < 8) failures.push(`${document.id} must state a revisit trigger`);
  if (typeof document.rollback !== 'string' || document.rollback.length < 8) failures.push(`${document.id} must state a rollback action`);
}

const docsDirectory = join(root, 'docs');
const actualPaths = new Set((await allMarkdownFiles(docsDirectory)).map((file) => relative(root, file).replaceAll('\\', '/')));
for (const path of actualPaths) if (!seenPaths.has(path)) failures.push(`documentation file is missing metadata: ${path}`);
for (const path of seenPaths) if (!actualPaths.has(path)) failures.push(`metadata points to missing documentation: ${path}`);
if (/(?:[A-Za-z]:[\\/]|\\\\|(?:^|\s)\/(?:Users|home)\/)/.test(catalogText)) failures.push('metadata catalog contains a machine-local path');

const result = { ok: failures.length === 0, schemaVersion: 1, documents: catalog.documents.length, markdownFiles: actualPaths.size, failures };
console.log(JSON.stringify(result, null, 2));
if (failures.length > 0) process.exitCode = 1;
