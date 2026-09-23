import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { artifactDirectory } from './artifact-directory.mjs';
import { isWithin } from './path-boundary.mjs';

const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', 'target', 'dist', 'build', 'vendor', 'coverage', '.next']);
const SOURCE_EXTENSIONS = new Set(['.rs', '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.java', '.cs', '.md']);
const execFile = promisify(execFileCallback);
const options = parseArgs(process.argv.slice(2));
const sourceRoot = resolve(options.root);
const output = resolve(options.out);
if (isWithin(sourceRoot, output)) {
  throw new Error(`--out must be outside the producer checkout: ${output}`);
}
const files = [];
const skipped = [];
const candidates = new Map();
const producerFiles = [];
const streamCandidates = new Map();
let examinedBytes = 0;
let coverageTruncated = false;

await walk(sourceRoot, '');
for (const file of files) {
  const lines = file.contents.split(/\r?\n/);
  const matches = [];
  const terminals = [];
  const environmentControls = new Set();
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? '';
    const literals = [...line.matchAll(/(?:["'`])([^"'`\r\n]*\.(?:jsonl|ndjson)(?:\.zst)?)(?:["'`])/gi)];
    for (const match of literals) {
      const literal = match[1];
      if (!literal) continue;
      const windowStart = Math.max(0, lineIndex - 8);
      const windowEnd = Math.min(lines.length, lineIndex + 9);
      const context = lines.slice(windowStart, windowEnd).join('\n');
      const signals = [];
      if (/\.(?:jsonl|ndjson)(?:\.zst)?$/i.test(literal)) signals.push('line-delimited-path');
      if (/serde_json::(?:to_string|to_writer|to_value)|JSON\.stringify|json\.dumps|JSON\.dump/i.test(context)) signals.push('serializer-nearby');
      if (/write_all|writeFile|appendFile|OpenOptions|File::create|\.append\(|\.create\(/i.test(context)) signals.push('writer-nearby');
      const kind = /\.jsonl\.zst$/i.test(literal) ? 'compressed-jsonl' : /\.ndjson$/i.test(literal) ? 'ndjson' : 'jsonl';
      const key = literal.replaceAll('\\', '/');
      const entry = {
        path: key,
        kind,
        source: relative(sourceRoot, file.path).replaceAll(sep, '/'),
        scope: classifyScope(relative(sourceRoot, file.path).replaceAll(sep, '/')),
        line: lineIndex + 1,
        signals: [...new Set(signals)],
        confidence: signals.includes('serializer-nearby') && signals.includes('writer-nearby') ? 'candidate' : 'observed',
      };
      matches.push(entry);
      const existing = candidates.get(key) ?? [];
      existing.push(entry);
      candidates.set(key, existing);
    }
    const contextStart = Math.max(0, lineIndex - 8);
    const contextEnd = Math.min(lines.length, lineIndex + 9);
    const terminalContext = lines.slice(contextStart, contextEnd).join('\n');
    const serializer = serializerName(terminalContext);
    const writer = writerName(terminalContext);
    if (serializer && writer) {
      terminals.push({
        source: relative(sourceRoot, file.path).replaceAll(sep, '/'),
        line: lineIndex + 1,
        serializer,
        writer,
        confidence: 'candidate',
      });
    }
    for (const match of line.matchAll(/\bCODEX_[A-Z0-9_]+\b/g)) environmentControls.add(match[0]);
  }
  file.matches = matches.length;
  const source = relative(sourceRoot, file.path).replaceAll(sep, '/');
  const scope = classifyScope(source);
  for (const surface of inferStreamSurfaces(file.contents)) {
    const key = `${surface.kind}:${source}`;
    streamCandidates.set(key, {
      kind: surface.kind,
      source,
      scope,
      anchors: surface.anchors,
      confidence: 'candidate',
    });
  }
  if (terminals.length > 0 || environmentControls.size > 0) {
    producerFiles.push({
      source,
      scope,
      terminals: dedupeTerminals(terminals),
      environmentControls: [...environmentControls].sort(),
    });
  }
}

const revision = await gitRevision(sourceRoot);
const git = await gitMetadata(sourceRoot);
const examinedTreeSha256 = digestExaminedFiles(files);
const report = {
  schemaVersion: 2,
  toolVersion: '1',
  generatedAt: new Date().toISOString(),
  source: { root: '<source-root>', revision, examinedTreeSha256, ...git },
  method: {
    description: 'bounded lexical candidate discovery of line-delimited path literals, serializer/writer terminals, and stream producers',
    contextLines: 8,
    runtimeRegistration: false,
    requiresSourceReview: true,
    limits: {
      maxFiles: options.maxFiles,
      maxBytes: options.maxBytes,
      maxFileBytes: options.maxFileBytes,
    },
    coverageLimits: [
      'dynamic path construction and paths more than the context window away may be missed',
      'lexical matches can occur in comments, tests, or documentation and are not ownership proof',
      'runtime streams without a recognizable producer token remain candidates only when a source anchor is reviewed',
    ],
  },
  summary: {
    filesExamined: files.length,
    bytesExamined: examinedBytes,
    filesSkipped: skipped.length,
    surfaces: candidates.size,
    candidateReferences: [...candidates.values()].flat().filter((entry) => entry.confidence === 'candidate').length,
    producerFiles: producerFiles.length,
    serializerWriterCandidates: producerFiles.reduce((total, file) => total + file.terminals.length, 0),
    streamCandidates: streamCandidates.size,
    coverageTruncated,
  },
  coverage: {
    truncated: coverageTruncated,
    reason: coverageTruncated ? 'scan-limit' : undefined,
  },
  surfaces: [...candidates.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, references]) => ({
      path,
      kind: references[0]?.kind ?? 'jsonl',
      candidate: references.some((entry) => entry.confidence === 'candidate'),
      references,
    })),
  skipped,
  producerFiles,
  streamCandidates: [...streamCandidates.values()].sort((left, right) => left.kind.localeCompare(right.kind) || left.source.localeCompare(right.source)),
};

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ ok: true, output, summary: report.summary }, null, 2));

function digestExaminedFiles(entries) {
  const digest = createHash('sha256');
  const ordered = [...entries].sort((left, right) => left.path.localeCompare(right.path));
  for (const entry of ordered) {
    const relativePath = relative(sourceRoot, entry.path).replaceAll(sep, '/');
    const contentDigest = createHash('sha256').update(entry.contents, 'utf8').digest('hex');
    digest.update(`${relativePath}\0${String(Buffer.byteLength(entry.contents, 'utf8'))}\0${contentDigest}\n`, 'utf8');
  }
  return digest.digest('hex');
}

async function walk(directory, prefix) {
  if (files.length >= options.maxFiles || examinedBytes >= options.maxBytes) {
    coverageTruncated = true;
    return;
  }
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    skipped.push({ path: prefix || '.', reason: error instanceof Error ? error.message : String(error) });
    return;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (files.length >= options.maxFiles || examinedBytes >= options.maxBytes) {
      coverageTruncated = true;
      break;
    }
    if (SKIP_DIRECTORIES.has(entry.name.toLowerCase())) continue;
    const child = resolve(directory, entry.name);
    const childPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await walk(child, childPrefix);
      continue;
    }
    if (!entry.isFile() || !SOURCE_EXTENSIONS.has(extension(entry.name))) continue;
    let details;
    try {
      details = await lstat(child);
    } catch {
      continue;
    }
    if (details.size > options.maxFileBytes) {
      skipped.push({ path: childPrefix, reason: 'file-size-limit' });
      continue;
    }
    try {
      const contents = await readFile(child, 'utf8');
      examinedBytes += Buffer.byteLength(contents, 'utf8');
      files.push({ path: child, contents, matches: 0 });
    } catch (error) {
      skipped.push({ path: childPrefix, reason: error instanceof Error ? error.message : String(error) });
    }
  }
}

async function gitRevision(directory) {
  try {
    return (await execFile('git', ['-C', directory, 'rev-parse', 'HEAD'], { windowsHide: true })).stdout.trim();
  } catch {
    return 'unavailable';
  }
}

async function gitMetadata(directory) {
  const read = async (args, fallback) => {
    try {
      return (await execFile('git', ['-C', directory, ...args], { windowsHide: true })).stdout.trim() || fallback;
    } catch {
      return fallback;
    }
  };
  const status = await read(['status', '--porcelain', '--untracked-files=all'], 'unavailable');
  return {
    branch: await read(['branch', '--show-current'], 'detached-or-unavailable'),
    remote: await read(['remote', 'get-url', 'origin'], 'unavailable'),
    workingTreeClean: status === '',
  };
}

function extension(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.rs')) return '.rs';
  if (lower.endsWith('.ts')) return '.ts';
  if (lower.endsWith('.tsx')) return '.tsx';
  if (lower.endsWith('.js')) return '.js';
  if (lower.endsWith('.jsx')) return '.jsx';
  if (lower.endsWith('.py')) return '.py';
  if (lower.endsWith('.go')) return '.go';
  if (lower.endsWith('.java')) return '.java';
  if (lower.endsWith('.cs')) return '.cs';
  if (lower.endsWith('.md')) return '.md';
  return '';
}

function parseArgs(args) {
  const parsed = {
    root: undefined,
    out: resolve(artifactDirectory('source-surfaces', 'producer-surfaces.json')),
    maxFiles: 20_000,
    maxBytes: 128 * 1024 * 1024,
    maxFileBytes: 2 * 1024 * 1024,
  };
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    // pnpm keeps the conventional script separator in argv for direct
    // `pnpm <script> -- ...` invocations. Treat it as a transport marker.
    if (key === '--') continue;
    const value = args[index + 1];
    if (key === '--root' || key === '--out' || key === '--max-files' || key === '--max-bytes' || key === '--max-file-bytes') {
      if (value === undefined || value.startsWith('--')) throw new Error(`${key} requires a value`);
      if (key === '--root') parsed.root = value;
      else if (key === '--out') parsed.out = resolve(value);
      else if (key === '--max-files') parsed.maxFiles = positiveInteger(value, key);
      else if (key === '--max-bytes') parsed.maxBytes = positiveInteger(value, key);
      else parsed.maxFileBytes = positiveInteger(value, key);
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${key}`);
  }
  if (parsed.root === undefined) throw new Error('Usage: node scripts/discover-producer-surfaces.mjs --root <producer-checkout> [--out <external-report>]');
  return parsed;
}

function positiveInteger(value, key) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${key} must be a positive integer`);
  return parsed;
}

function serializerName(context) {
  if (/serde_json::to_(?:string|writer|value|vec)/i.test(context)) return 'serde_json';
  if (/JSON\.stringify\s*\(/i.test(context)) return 'JSON.stringify';
  if (/json\.(?:dumps|dump)\s*\(/i.test(context)) return 'json.dumps';
  if (/json\.NewEncoder|\.Encode\s*\(/i.test(context)) return 'json.Encoder';
  return undefined;
}

function writerName(context) {
  if (/write_all|writeFile|appendFile|OpenOptions|File::create/i.test(context)) return 'file-writer';
  if (/println!|console\.log|process\.stdout|stdout\.write|write\(.*\\n/i.test(context)) return 'stream-writer';
  if (/\.append\s*\(/i.test(context)) return 'append-writer';
  return undefined;
}

function dedupeTerminals(terminals) {
  const seen = new Set();
  return terminals.filter((terminal) => {
    const key = `${terminal.line}:${terminal.serializer}:${terminal.writer}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function classifyScope(source) {
  const normalized = source.toLowerCase();
  if (/(^|\/)(test|tests|fixtures|examples|docs)(\/|$)|(?:_test|\.test|\.spec)\./.test(normalized)) return 'test-or-doc';
  return 'production-candidate';
}

function inferStreamSurfaces(contents) {
  const surfaces = [];
  if (/ThreadEvent|--(?:experimental-)?json[\s\S]{0,240}(?:stdout|jsonl)|Print events to stdout as JSONL/i.test(contents)) {
    surfaces.push({ kind: 'codex-exec-jsonl', anchors: ['ThreadEvent', '--json', 'stdout JSONL'] });
  }
  if (/JSONRPCMessage|ServerNotificationEnvelope/i.test(contents) && /stdin|stdout|newline-delimited|JSONL/i.test(contents)) {
    surfaces.push({ kind: 'codex-app-server', anchors: ['JSONRPCMessage', 'stdio/newline-delimited transport'] });
  }
  if (/LOG_FORMAT_ENV_VAR|LOG_FORMAT\s*=\s*"json"/i.test(contents)
    && /tracing_subscriber::fmt::layer\(\)\.json\(\)/i.test(contents)
    && /with_writer\(std::io::stderr\)/i.test(contents)) {
    surfaces.push({ kind: 'codex-app-server-log', anchors: ['LOG_FORMAT=json', 'tracing JSON layer', 'stderr sink'] });
  }
  if (/CODEX_TUI_RECORD_SESSION|CODEX_TUI_SESSION_LOG_PATH/i.test(contents)) {
    surfaces.push({ kind: 'codex-tui-session-log', anchors: ['CODEX_TUI_RECORD_SESSION', 'CODEX_TUI_SESSION_LOG_PATH'] });
  }
  if (/CODEX_ANALYTICS_EVENTS_CAPTURE_FILE/i.test(contents)) {
    surfaces.push({ kind: 'codex-analytics-capture', anchors: ['CODEX_ANALYTICS_EVENTS_CAPTURE_FILE'] });
  }
  if (/RawTraceEvent|trace\.jsonl/i.test(contents) && /serde_json::to_(?:writer|string)|write_all/i.test(contents)) {
    surfaces.push({ kind: 'codex-trace', anchors: ['RawTraceEvent', 'trace.jsonl', 'newline writer'] });
  }
  return surfaces;
}
