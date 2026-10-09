import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = process.cwd();
const baseline = process.env.BIOME_BASELINE ?? 'baseline/pre-architecture-20261009';
const listed = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMRT', baseline + '...HEAD'], { encoding: 'utf8' })
  .split(/\r?\n/u)
  .concat(execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMRT'], { encoding: 'utf8' }).split(/\r?\n/u))
  .concat(execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { encoding: 'utf8' }).split(/\r?\n/u))
  .map((value) => value.trim())
  .filter((value, index, values) => value.length > 0 && values.indexOf(value) === index)
  .filter((value) => /^(src|scripts|test)[/\\]/u.test(value) && /\.(?:ts|tsx|mjs)$/u.test(value) && existsSync(value));

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
