import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';

const invocationDirectory = process.cwd();
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.css']);

export function parseArgs(argv) {
  const args = [...argv];
  if (args[0] === '--') args.shift();
  const result = { all: false, json: false, base: undefined, head: 'HEAD', includeWorktree: true };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--all') result.all = true;
    else if (argument === '--json') result.json = true;
    else if (argument === '--base') {
      const value = args[index + 1];
      if (!value || value.startsWith('-')) throw new Error('--base requires a revision.');
      result.base = value;
      index += 1;
    } else if (argument === '--head') {
      const value = args[index + 1];
      if (!value || value.startsWith('-')) throw new Error('--head requires a revision.');
      result.head = value;
      index += 1;
    } else if (argument === '--no-worktree') {
      result.includeWorktree = false;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return result;
}

async function collectSourceFiles(directory, extensions, files = []) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collectSourceFiles(path, extensions, files);
    else if (extensions.has(extname(entry.name))) files.push(path);
  }
  return files;
}

function git(repoRoot, args) {
  try {
    return execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const stderr = error?.stderr?.toString().trim();
    const detail = stderr || (error instanceof Error ? error.message : String(error));
    throw new Error(`git ${args.join(' ')} failed in ${repoRoot}: ${detail}`, { cause: error });
  }
}

function resolveRepoRoot(directory = invocationDirectory) {
  const candidate = resolve(directory);
  if (!existsSync(resolve(candidate, 'config/module-review.json')) || !existsSync(resolve(candidate, 'src'))) {
    throw new Error(`module review directory must be the product repository root: ${candidate}`);
  }
  let repoRoot;
  try {
    repoRoot = resolve(git(candidate, ['rev-parse', '--show-toplevel']).trim());
  } catch (error) {
    throw new Error(`module review directory is not inside a Git repository: ${candidate}`, { cause: error });
  }
  if (repoRoot !== candidate || !statSync(resolve(candidate, 'src')).isDirectory()) {
    throw new Error(`module review directory must be the product repository root: ${candidate}`);
  }
  return repoRoot;
}

function resolveRevision(repoRoot, revision, label) {
  if (typeof revision !== 'string' || revision.length === 0) {
    throw new Error(`${label} requires a non-empty revision.`);
  }
  let resolved;
  try {
    resolved = git(repoRoot, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`]).trim();
  } catch (error) {
    throw new Error(`${label} revision does not resolve to a commit: ${revision}`, { cause: error });
  }
  if (!resolved) throw new Error(`${label} does not resolve to a commit: ${revision}`);
  return resolved;
}

function assertCleanSnapshot(repoRoot, resolvedHead) {
  const checkoutHead = resolveRevision(repoRoot, 'HEAD', 'checkout HEAD');
  if (checkoutHead !== resolvedHead) {
    throw new Error(`--no-worktree requires checkout HEAD ${checkoutHead} to match resolved head ${resolvedHead}`);
  }
  const status = git(repoRoot, ['status', '--porcelain', '--untracked-files=all']).trim();
  if (status) {
    throw new Error('--no-worktree requires a clean checkout; working-tree changes are present.');
  }
}

function normalizeRelative(repoRoot, path) {
  return relative(repoRoot, path).replaceAll('\\', '/');
}

function sourcePathCandidates(path) {
  return [path, ...sourceExtensions].map((candidate) => candidate === path ? candidate : `${path}${candidate}`);
}

function resolveRelativeImport(importer, specifier, sourcePaths) {
  if (!specifier.startsWith('.')) return undefined;
  const base = normalize(resolve(dirname(importer), specifier));
  return sourcePathCandidates(base)
    .map((candidate) => normalize(candidate))
    .find((candidate) => sourcePaths.has(candidate));
}

export function parseTypeScriptMetrics(path, sourceText) {
  if (extname(path) === '.css') return { functionCount: 0, maxFunctionLines: 0, branchCount: 0, directFanOut: 0, imports: [], parseDiagnostics: [] };
  const plugins = ['typescript', 'importAttributes', 'topLevelAwait'];
  if (path.endsWith('.tsx') || path.endsWith('.jsx')) plugins.push('jsx');
  const lineStarts = [0];
  for (let index = 0; index < sourceText.length; index += 1) {
    if (sourceText[index] === '\n') lineStarts.push(index + 1);
  }
  const lineAt = (position) => {
    let low = 0;
    let high = lineStarts.length;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if (lineStarts[middle] <= position) low = middle;
      else high = middle;
    }
    return low + 1;
  };
  try {
    const source = parse(sourceText, { sourceType: 'unambiguous', sourceFilename: path, errorRecovery: true, plugins });
    const functions = [];
    const imports = [];
    let branchCount = 0;
    const functionTypes = new Set([
      'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod',
      'ClassMethod', 'ClassPrivateMethod', 'ClassPrivateMethod', 'ClassMethod', 'ClassPrivateProperty',
    ]);
    const branchTypes = new Set([
      'IfStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement',
      'SwitchStatement', 'ConditionalExpression', 'CatchClause', 'LogicalExpression',
    ]);
    const visit = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'ImportDeclaration' && node.source?.value) imports.push(node.source.value);
      if ((node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') && node.source?.value) imports.push(node.source.value);
      if (node.type === 'CallExpression' && node.callee?.type === 'Import' && node.arguments[0]?.type === 'StringLiteral') imports.push(node.arguments[0].value);
      if (functionTypes.has(node.type) && node.body?.start !== undefined && node.body?.end !== undefined) {
        functions.push({ start: lineAt(node.body.start), end: lineAt(node.body.end) });
      }
      if (branchTypes.has(node.type)) branchCount += 1;
      for (const [key, value] of Object.entries(node)) {
        if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra' || key === 'comments' || key === 'tokens') continue;
        if (Array.isArray(value)) {
          for (const child of value) visit(child);
        } else {
          visit(value);
        }
      }
    };
    visit(source);
    const parseDiagnostics = (source.errors ?? []).map((diagnostic) => {
      const location = diagnostic.loc ? `${diagnostic.loc.line}:${diagnostic.loc.column} ` : '';
      return `${location}${diagnostic.message}`;
    });
    return {
      functionCount: functions.length,
      maxFunctionLines: functions.reduce((maximum, item) => Math.max(maximum, item.end - item.start + 1), 0),
      branchCount,
      directFanOut: new Set(imports).size,
      imports,
      parseDiagnostics,
      ...(parseDiagnostics.length > 0 ? { parseError: parseDiagnostics.join('; ') } : {}),
    };
  } catch (error) {
    const parseError = error instanceof Error ? error.message : String(error);
    return { functionCount: 0, maxFunctionLines: 0, branchCount: 0, directFanOut: 0, imports: [], parseDiagnostics: [parseError], parseError };
  }
}

function parseNumstat(text) {
  const result = new Map();
  for (const line of text.split(/\r?\n/u)) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const added = Number(parts[0]);
    const removed = Number(parts[1]);
    if (!Number.isFinite(added) || !Number.isFinite(removed)) continue;
    const path = parts[parts.length - 1].replaceAll('\\', '/');
    result.set(path, (result.get(path) ?? 0) + added + removed);
  }
  return result;
}

function changedLineCounts(repoRoot, base, head, includeWorktree) {
  const counts = new Map();
  if (base && head) {
    const committed = parseNumstat(git(repoRoot, ['diff', '--numstat', `${base}...${head}`, '--', 'src']));
    for (const [path, count] of committed) counts.set(path, (counts.get(path) ?? 0) + count);
  }
  if (includeWorktree) {
    const working = parseNumstat(git(repoRoot, ['diff', '--numstat', '--', 'src']));
    const staged = parseNumstat(git(repoRoot, ['diff', '--cached', '--numstat', '--', 'src']));
    for (const changes of [working, staged]) {
      for (const [path, count] of changes) counts.set(path, (counts.get(path) ?? 0) + count);
    }
    for (const path of git(repoRoot, ['ls-files', '--others', '--exclude-standard', '--', 'src']).split(/\r?\n/u).filter(Boolean)) {
      const absolutePath = resolve(repoRoot, path);
      try {
        const text = readFileSync(absolutePath, 'utf8');
        counts.set(path.replaceAll('\\', '/'), text.split(/\r?\n/u).filter((line, index, lines) => index < lines.length - 1 || line.length > 0).length);
      } catch {
        // The file may disappear while a developer is editing it.
      }
    }
  }
  return counts;
}

function recentCommitCounts(repoRoot, paths) {
  const counts = new Map([...paths].map((path) => [path, 0]));
  let currentFiles = new Set();
  const log = git(repoRoot, ['log', '--format=commit:%H', '--name-only', '--since=180 days ago', '--', 'src']);
  for (const line of log.split(/\r?\n/u)) {
    if (line.startsWith('commit:')) {
      for (const path of currentFiles) {
        if (counts.has(path)) counts.set(path, counts.get(path) + 1);
      }
      currentFiles = new Set();
    } else if (line) {
      currentFiles.add(line.replaceAll('\\', '/'));
    }
  }
  for (const path of currentFiles) {
    if (counts.has(path)) counts.set(path, counts.get(path) + 1);
  }
  return counts;
}

function reviewLevel(metrics, bands) {
  if (metrics.parseError) return 'critical';
  if (metrics.lines >= bands.fileLines.critical) return 'critical';
  if (metrics.lines >= bands.fileLines.high) return 'high';
  if (
    metrics.lines >= bands.fileLines.review
    || metrics.maxFunctionLines > bands.functionLines
    || metrics.changedLines >= bands.changedLines
    || metrics.directFanIn >= bands.directFanIn
    || metrics.directFanOut >= bands.directFanOut
    || metrics.branchCount >= bands.branchCount
    || metrics.recentCommits >= bands.recentCommits
  ) return 'review';
  return 'normal';
}

function reviewReasons(metrics, bands) {
  const reasons = [];
  if (metrics.parseError) reasons.push('parse-error');
  if (metrics.lines >= bands.fileLines.review) reasons.push('file-size');
  if (metrics.maxFunctionLines > bands.functionLines) reasons.push('function-shape');
  if (metrics.changedLines >= bands.changedLines) reasons.push('change-surface');
  if (metrics.directFanIn >= bands.directFanIn) reasons.push('fan-in');
  if (metrics.directFanOut >= bands.directFanOut) reasons.push('fan-out');
  if (metrics.branchCount >= bands.branchCount) reasons.push('branching');
  if (metrics.recentCommits >= bands.recentCommits) reasons.push('change-hotspot');
  return reasons;
}

function isExempt(path, exemptions) {
  return exemptions.find((entry) => new RegExp(entry.pattern).test(path));
}

function normalized(value, ceiling) {
  return Math.min(1, value / Math.max(1, ceiling));
}

function boundarySensitivity(path, config) {
  for (const entry of config.boundarySensitivity ?? []) {
    if (new RegExp(entry.pattern).test(path)) return entry.weight;
  }
  return 0.5;
}

function priorityScore(metrics, config) {
  const bands = config.reviewBands;
  const weights = config.priorityWeights ?? { size: 0.3, churn: 0.25, coupling: 0.2, complexity: 0.2, boundary: 0.05 };
  const size = normalized(metrics.lines, bands.fileLines.review);
  const churn = normalized(metrics.changedLines + metrics.recentCommits * 10, bands.changedLines + bands.recentCommits * 10);
  const coupling = normalized(metrics.directFanIn, bands.directFanIn) * 0.6 + normalized(metrics.directFanOut, bands.directFanOut) * 0.4;
  const complexity = normalized(metrics.maxFunctionLines, bands.functionLines) * 0.6 + normalized(metrics.branchCount, bands.branchCount) * 0.4;
  const boundary = boundarySensitivity(metrics.path, config);
  return Math.round(100 * (weights.size * size + weights.churn * churn + weights.coupling * coupling + weights.complexity * complexity + weights.boundary * boundary));
}

export async function buildReport({ directory = invocationDirectory, base, head = 'HEAD', includeWorktree = true, all = false } = {}) {
  const repoRoot = resolveRepoRoot(directory);
  const config = JSON.parse(await readFile(resolve(repoRoot, 'config/module-review.json'), 'utf8'));
  const sourceRoot = resolve(repoRoot, config.roots[0]);
  const files = await collectSourceFiles(sourceRoot, new Set(config.extensions));
  const sourcePaths = new Set(files.map((path) => normalize(path)));
  const resolvedHead = resolveRevision(repoRoot, head, '--head');
  const resolvedBase = base === undefined ? null : resolveRevision(repoRoot, base, '--base');
  if (!includeWorktree) assertCleanSnapshot(repoRoot, resolvedHead);
  const changed = changedLineCounts(repoRoot, resolvedBase, resolvedHead, includeWorktree);
  const importsByFile = new Map();
  const metricsByPath = new Map();
  const recentCommits = recentCommitCounts(repoRoot, files.map((path) => normalizeRelative(repoRoot, path)));

  for (const path of files) {
    const sourceText = await readFile(path, 'utf8');
    const parsed = parseTypeScriptMetrics(path, sourceText);
    importsByFile.set(path, parsed.imports);
    metricsByPath.set(path, {
      path: normalizeRelative(repoRoot, path),
      lines: sourceText.split(/\r?\n/u).length - (sourceText.endsWith('\n') ? 1 : 0),
      bytes: Buffer.byteLength(sourceText),
      functionCount: parsed.functionCount,
      maxFunctionLines: parsed.maxFunctionLines,
      branchCount: parsed.branchCount,
      directFanOut: parsed.directFanOut,
      directFanIn: 0,
      changedLines: changed.get(normalizeRelative(repoRoot, path)) ?? 0,
      recentCommits: recentCommits.get(normalizeRelative(repoRoot, path)) ?? 0,
      parseError: parsed.parseError,
      parseDiagnostics: parsed.parseDiagnostics ?? [],
    });
  }

  const importersByTarget = new Map();
  for (const [importer, imports] of importsByFile) {
    for (const specifier of imports) {
      const target = resolveRelativeImport(importer, specifier, sourcePaths);
      if (target) {
        const importers = importersByTarget.get(target) ?? new Set();
        importers.add(importer);
        importersByTarget.set(target, importers);
      }
    }
  }
  for (const [target, importers] of importersByTarget) {
    const metrics = metricsByPath.get(target);
    if (metrics) metrics.directFanIn = importers.size;
  }

  const entries = [...metricsByPath.values()].map((metrics) => {
    const exemption = isExempt(metrics.path, config.exemptions ?? []);
    const reasons = reviewReasons(metrics, config.reviewBands);
    const priority = priorityScore(metrics, config);
    return {
      ...metrics,
      priority,
      level: exemption ? 'exempt' : reviewLevel(metrics, config.reviewBands),
      reasons: exemption ? [`exempt:${exemption.reason}`] : reasons,
      reviewRequired: !exemption && reasons.length > 0,
    };
  }).filter((entry) => all || entry.reviewRequired || entry.changedLines > 0);

  const order = { critical: 0, high: 1, review: 2, normal: 3, exempt: 4 };
  entries.sort((left, right) => right.priority - left.priority || order[left.level] - order[right.level] || right.lines - left.lines || left.path.localeCompare(right.path));
  return {
    schemaVersion: 1,
    base: base ?? null,
    head,
    resolvedBase,
    resolvedHead,
    revision: {
      base: { requested: base ?? null, resolved: resolvedBase },
      head: { requested: head, resolved: resolvedHead },
    },
    includeWorktree,
    dependencyGraph: { scope: 'relative-imports-only', fanOutScope: 'all-import-specifiers' },
    scope: all ? 'all-source' : 'changed-or-review-required',
    thresholds: config.reviewBands,
    entries,
    reviewRequired: entries.filter((entry) => entry.reviewRequired).map((entry) => entry.path),
  };
}

function formatHuman(report) {
  const lines = [`Module review (${report.scope}; base=${report.base ?? 'working-tree'}; head=${report.head}; worktree=${report.includeWorktree ? 'included' : 'excluded'}; graph=${report.dependencyGraph.scope})`];
  if (report.entries.length === 0) return `${lines[0]}\nNo changed or review-priority source modules.`;
  for (const entry of report.entries) {
    const reasons = entry.reasons.length > 0 ? ` [${entry.reasons.join(', ')}]` : '';
    lines.push(`${entry.level.padEnd(8)} score=${String(entry.priority).padStart(3)} ${String(entry.lines).padStart(5)} lines  +${String(entry.changedLines).padStart(4)} changed  fan-in=${entry.directFanIn} fan-out=${entry.directFanOut} max-fn=${entry.maxFunctionLines}  ${entry.path}${reasons}`);
  }
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const report = await buildReport({ base: args.base, head: args.head, includeWorktree: args.includeWorktree, all: args.all });
  process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatHuman(report)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
