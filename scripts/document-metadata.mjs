import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';

export const REQUIRED_FIELDS = ['id', 'path', 'title', 'kind', 'status', 'owner', 'tags', 'evidence', 'revisit', 'rollback'];
export const KINDS = ['index', 'guide', 'roadmap', 'decision', 'design', 'policy', 'reliability', 'security'];
export const STATUSES = ['active', 'accepted', 'experimental', 'planned', 'proposed', 'historical', 'superseded', 'draft', 'archived', 'deleted'];

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function parseValue(value, lineNumber) {
  const trimmed = value.trim();
  if (trimmed === '[]') return [];
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) throw new Error('array values must be strings');
      return parsed;
    } catch (error) {
      throw new Error(`front matter line ${lineNumber}: invalid string array (${error.message})`);
    }
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try { return JSON.parse(trimmed); } catch (error) { throw new Error(`front matter line ${lineNumber}: invalid string (${error.message})`); }
  }
  if (trimmed.length === 0) throw new Error(`front matter line ${lineNumber}: empty value`);
  return trimmed;
}

export function expectedId(relativePath) {
  const normalized = relativePath.replaceAll('\\', '/');
  const file = basename(normalized, extname(normalized));
  if (file !== 'README') return file;
  const parent = basename(dirname(normalized));
  return parent === 'docs' ? 'docs-index' : `${parent || 'docs'}-index`;
}

export function parseDocument(text, relativePath) {
  const match = text.match(FRONT_MATTER);
  if (!match) throw new Error(`${relativePath}: missing YAML front matter`);
  const metadata = {};
  for (const [index, raw] of match[1].split(/\r?\n/).entries()) {
    const line = raw.trimEnd();
    if (!line || line.trimStart().startsWith('#')) continue;
    const field = line.match(/^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/);
    if (!field) throw new Error(`${relativePath}: unsupported front matter syntax at line ${index + 2}`);
    if (Object.hasOwn(metadata, field[1])) throw new Error(`${relativePath}: duplicate front matter field ${field[1]}`);
    metadata[field[1]] = parseValue(field[2], index + 2);
  }
  return { metadata, body: text.slice(match[0].length), frontMatter: match[0] };
}

export function serializeDocument(metadata, body) {
  const lines = ['---'];
  for (const field of REQUIRED_FIELDS) {
    const value = metadata[field];
    if (Array.isArray(value)) lines.push(`${field}: ${JSON.stringify(value)}`);
    else lines.push(`${field}: ${JSON.stringify(String(value))}`);
  }
  for (const field of Object.keys(metadata).sort()) {
    if (REQUIRED_FIELDS.includes(field)) continue;
    const value = metadata[field];
    lines.push(`${field}: ${Array.isArray(value) ? JSON.stringify(value) : JSON.stringify(String(value))}`);
  }
  lines.push('---', '');
  return lines.join('\n') + body.replace(/^\r?\n/, '');
}

function summaryFromBody(body) {
  const plain = body
    .replace(/^```[\s\S]*?```/gm, '')
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) => paragraph.replace(/^#{1,6}\s+/, '').replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim())
    .find((paragraph) => paragraph.length > 0) ?? '';
  return plain.length > 280 ? `${plain.slice(0, 277)}...` : plain;
}

async function markdownFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await markdownFiles(path));
    else if (entry.isFile() && (entry.name.endsWith('.md') || entry.name.endsWith('.mdx'))) files.push(path);
  }
  return files;
}

export async function buildIndex(root) {
  const docsRoot = resolve(root, 'docs');
  const documents = [];
  for (const absolute of await markdownFiles(docsRoot)) {
    const path = relative(root, absolute).split(sep).join('/');
    const text = await readFile(absolute, 'utf8');
    const parsed = parseDocument(text, path);
    const metadata = parsed.metadata;
    documents.push({
      id: metadata.id,
      path,
      title: metadata.title,
      kind: metadata.kind,
      status: metadata.status,
      owner: metadata.owner,
      tags: metadata.tags,
      evidence: metadata.evidence,
      revisit: metadata.revisit,
      rollback: metadata.rollback,
      summary: summaryFromBody(parsed.body),
      bytes: Buffer.byteLength(text),
      sha256: sha256(text),
    });
  }
  documents.sort((left, right) => left.id.localeCompare(right.id) || left.path.localeCompare(right.path));
  return { schema: 'jsonlview.documentation-index', version: 1, generated: true, documents };
}

export function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
