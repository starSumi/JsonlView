import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const manifestPath = join(root, 'config', 'agent-spec.json');
const agentsPath = join(root, 'AGENTS.md');
const packagePath = join(root, 'package.json');

const args = process.argv.slice(2);
const readArg = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const base = readArg('--base');
const head = readArg('--head') || 'HEAD';
const failures = [];

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const manifest = await readJson(manifestPath);
const packageJson = await readJson(packagePath);
const agents = await readFile(agentsPath, 'utf8');

if (manifest.version !== 1) failures.push('config/agent-spec.json must use manifest version 1');
if (manifest.instructionFile !== 'AGENTS.md') failures.push('agent-spec instructionFile must be AGENTS.md');

for (const section of manifest.requiredSections || []) {
  if (!agents.includes(section)) failures.push('AGENTS.md missing required section: ' + section);
}

for (const command of manifest.mandatoryCommands || []) {
  if (typeof packageJson.scripts?.[command.script] !== 'string') {
    failures.push('package.json is missing mandatory command script: ' + command.script);
  }
  if (!agents.includes(command.text)) {
    failures.push('AGENTS.md Mandatory Commands is missing: ' + command.text);
  }
}

for (const marker of manifest.architectureMarkers || []) {
  if (!agents.includes(marker)) failures.push('AGENTS.md is missing architecture owner marker: ' + marker);
}

for (const entry of manifest.forbiddenInstructionPatterns || []) {
  let matcher;
  try {
    matcher = new RegExp(entry.pattern, 'i');
  } catch (error) {
    failures.push('invalid forbidden instruction pattern ' + entry.name + ': ' + (error instanceof Error ? error.message : String(error)));
    continue;
  }
  if (matcher.test(agents)) failures.push('AGENTS.md contains forbidden ' + entry.name + ' pattern');
}

const globMatches = (path, pattern) => {
  if (pattern.endsWith('/**')) return path.startsWith(pattern.slice(0, -2));
  if (pattern.endsWith('/')) return path.startsWith(pattern);
  return path === pattern;
};

const changed = [];
if (base) {
  const diff = spawnSync('git', ['diff', '--name-status', '--find-renames', base + '..' + head], {
    cwd: root,
    encoding: 'utf8',
  });
  if (diff.error) failures.push('unable to inspect Git diff: ' + diff.error.message);
  if (diff.status !== 0) failures.push('Git diff failed: ' + ((diff.stderr || '').trim() || ('exit ' + diff.status)));
  for (const line of (diff.stdout || '').split(/\\r?\\n/).filter(Boolean)) {
    const fields = line.split('\\t');
    const status = fields[0] || '';
    const paths = fields.slice(1);
    for (const path of paths) changed.push({ status, path: path.replaceAll('\\\\', '/') });
  }

  const instructionChanged = changed.some(({ path }) => path === 'AGENTS.md');
  const alwaysSensitive = changed.some(({ path }) =>
    (manifest.sensitivePaths?.always || []).some((pattern) => globMatches(path, pattern)),
  );
  const topologyChanged = changed.some(({ status, path }) =>
    /^[ADRC]/.test(status) &&
    (manifest.sensitivePaths?.topologyRoots || []).some((rootPath) => path.startsWith(rootPath)),
  );
  if ((alwaysSensitive || topologyChanged) && !instructionChanged) {
    const reasons = [
      alwaysSensitive ? 'product/build contract' : undefined,
      topologyChanged ? 'source/native topology' : undefined,
    ].filter(Boolean).join(' and ');
    failures.push('AGENTS.md must change when ' + reasons + ' changes (base ' + base + ', head ' + head + ')');
  }
}

const result = {
  ok: failures.length === 0,
  manifestVersion: manifest.version,
  instructionFile: manifest.instructionFile,
  changedPathCount: changed.length,
  checked: {
    requiredSections: manifest.requiredSections?.length || 0,
    mandatoryCommands: manifest.mandatoryCommands?.length || 0,
    architectureMarkers: manifest.architectureMarkers?.length || 0,
  },
  failures,
};
console.log(JSON.stringify(result, null, 2));
if (failures.length > 0) process.exitCode = 1;
