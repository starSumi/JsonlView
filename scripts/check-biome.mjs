import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = process.cwd();
const baseline = process.env.BIOME_BASELINE ?? 'baseline/pre-architecture-20261009';
// These package-owned entrypoints are intentionally outside the legacy root
// source globs; keep the newly executable MCP boundary and its smoke tests in
// the same changed-file lint gate without linting copied migration inventory.
const packageLintFiles = new Set([
  'packages/mcp-server/src/cli.ts',
  'packages/mcp-server/src/index.ts',
  'packages/mcp-server/src/mcp-server-runtime.ts',
  'packages/mcp-server/src/mcp-trajectory-contract.ts',
  'packages/mcp-server/src/mcp-trajectory-tools.ts',
  'packages/mcp-server/src/trajectory-spine.ts',
  'packages/mcp-server/src/contracts/trajectory-spine.ts',
  'packages/mcp-server/test/cli.test.mjs',
  'packages/runtime/src/index.ts',
  'packages/runtime/test/runtime.test.ts',
  'packages/runtime/test/process-tree-smoke.mjs',
]);
const committedDiff = (() => {
  try {
    execFileSync('git', ['rev-parse', '--verify', baseline], { cwd: root, stdio: 'ignore' });
    return execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMRT', baseline + '...HEAD'], { encoding: 'utf8' });
  } catch {
    try {
      return execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMRT', 'HEAD^...HEAD'], { encoding: 'utf8' });
    } catch {
      return '';
    }
  }
})();
const listed = committedDiff
  .split(/\r?\n/u)
  .concat(execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMRT'], { encoding: 'utf8' }).split(/\r?\n/u))
  .concat(execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { encoding: 'utf8' }).split(/\r?\n/u))
  .map((value) => value.trim())
  .filter((value, index, values) => value.length > 0 && values.indexOf(value) === index)
  .filter((value) => (/^(src|scripts|test)[/\\]/u.test(value) || packageLintFiles.has(value))
    && /\.(?:ts|tsx|mjs)$/u.test(value) && existsSync(value));

if (listed.length === 0) {
  console.log('Biome: no changed TypeScript/JavaScript files since ' + baseline + '.');
  process.exit(0);
}

console.log('Biome linting ' + listed.length + ' changed file(s) since ' + baseline + '.');
const biomeBin = fileURLToPath(new URL('../node_modules/@biomejs/biome/bin/biome', import.meta.url));
execFileSync(process.execPath, [biomeBin, 'lint', '--diagnostic-level=error', ...listed], {
  cwd: root,
  stdio: 'inherit',
});
