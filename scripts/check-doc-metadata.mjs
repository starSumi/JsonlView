import { readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex, expectedId, KINDS, parseDocument, REQUIRED_FIELDS, stableJson, STATUSES } from './document-metadata.mjs';

const args = process.argv.slice(2);
const defaultRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const validRootArgument = args.length === 0 || (args.length === 2 && args[0] === '--root');
const root = args.length === 2 ? resolve(args[1]) : defaultRoot;
const failures = validRootArgument ? [] : ['usage: node scripts/check-doc-metadata.mjs [--root <repository-root>]'];
const indexPath = join(root, 'docs', 'index.json');
let index;
try { index = JSON.parse(await readFile(indexPath, 'utf8')); } catch (error) { failures.push(`docs/index.json cannot be read: ${error.message}`); }

let actual;
try {
  actual = await buildIndex(root);
  const documentPaths = new Set(actual.documents.map((document) => document.path));
  const seenIds = new Set();
  const seenPaths = new Set();
  for (const document of actual.documents) {
    const text = await readFile(join(root, document.path), 'utf8');
    const parsed = parseDocument(text, document.path);
    const metadata = parsed.metadata;
    for (const field of REQUIRED_FIELDS) if (!(field in metadata)) failures.push(`${document.path} is missing ${field}`);
    for (const field of Object.keys(metadata)) {
      if (!REQUIRED_FIELDS.includes(field) && !field.startsWith('x-')) failures.push(`${document.path} contains unknown front matter field ${field}; use x- prefix for extensions`);
    }
    if (metadata.id !== expectedId(document.path)) failures.push(`${document.path} id must equal ${expectedId(document.path)} (found ${metadata.id})`);
    if (seenIds.has(metadata.id)) failures.push(`duplicate documentation id: ${metadata.id}`);
    seenIds.add(metadata.id);
    if (metadata.path !== document.path) failures.push(`${document.path} metadata.path must equal its repository path`);
    if (seenPaths.has(metadata.path)) failures.push(`duplicate documentation path: ${metadata.path}`);
    seenPaths.add(metadata.path);
    if (!KINDS.includes(metadata.kind)) failures.push(`${document.path} has unsupported kind ${metadata.kind}`);
    if (!STATUSES.includes(metadata.status)) failures.push(`${document.path} has unsupported status ${metadata.status}`);
    if (metadata.owner !== 'product') failures.push(`${document.path} must be owned by product`);
    if (!Array.isArray(metadata.tags) || metadata.tags.length === 0 || new Set(metadata.tags).size !== metadata.tags.length) failures.push(`${document.path} tags must be a non-empty unique array`);
    if (!Array.isArray(metadata.evidence) || metadata.evidence.some((item) => typeof item !== 'string')) failures.push(`${document.path} evidence must be a string array`);
    if (typeof metadata.revisit !== 'string' || metadata.revisit.trim().length < 8) failures.push(`${document.path} must state a revisit trigger`);
    if (typeof metadata.rollback !== 'string' || metadata.rollback.trim().length < 8) failures.push(`${document.path} must state a rollback action`);
    if (metadata['x-priority'] !== undefined && !/^P[0-3]$/.test(metadata['x-priority'])) failures.push(`${document.path} x-priority must be P0, P1, P2, or P3`);
    if (metadata['x-freshness'] !== undefined && !['current', 'watch', 'stale'].includes(metadata['x-freshness'])) failures.push(`${document.path} x-freshness must be current, watch, or stale`);
    if (metadata['x-review-cadence'] !== undefined && (typeof metadata['x-review-cadence'] !== 'string' || metadata['x-review-cadence'].trim().length < 8)) failures.push(`${document.path} x-review-cadence must describe a review trigger`);
    if (metadata['x-last-reviewed'] !== undefined) {
      const reviewed = metadata['x-last-reviewed'];
      const reviewedAt = typeof reviewed === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(reviewed)
        ? new Date(`${reviewed}T00:00:00.000Z`)
        : null;
      if (!reviewedAt || Number.isNaN(reviewedAt.valueOf()) || reviewedAt.toISOString().slice(0, 10) !== reviewed) {
        failures.push(`${document.path} x-last-reviewed must be a valid YYYY-MM-DD date`);
      }
    }
    for (const field of ['x-supersedes', 'x-superseded-by']) {
      if (metadata[field] === undefined) continue;
      const target = metadata[field];
      if (typeof target !== 'string' || !target.startsWith('docs/') || !/\.(?:md|mdx)$/.test(target)) {
        failures.push(`${document.path} ${field} must be a repository-relative Markdown path`);
      } else if (!documentPaths.has(target)) {
        failures.push(`${document.path} ${field} must point to an indexed Markdown document (found ${target})`);
      }
    }
    if (!parsed.body.trim()) failures.push(`${document.path} must have a non-empty Markdown/MDX body`);
  }
} catch (error) { failures.push(error.message); }

if (index && actual) {
  if (index.schema !== 'jsonlview.documentation-index' || index.version !== 1 || index.generated !== true) failures.push('docs/index.json has an invalid schema header');
  if (stableJson(index) !== stableJson(actual)) failures.push('docs/index.json is stale; regenerate it from document front matter');
}

const result = { ok: failures.length === 0, schemaVersion: 1, documents: actual?.documents.length ?? 0, index: relative(root, indexPath).replaceAll('\\', '/'), failures };
console.log(JSON.stringify(result, null, 2));
if (failures.length > 0) process.exitCode = 1;
