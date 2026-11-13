import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const biome = fileURLToPath(new URL('../node_modules/@biomejs/biome/bin/biome', import.meta.url));

function runFixture(name, expectedStatus) {
  let status = 0;
  try {
    execFileSync(process.execPath, [biome, 'lint', '--config-path=biome.json', '--only=plugin', '--diagnostic-level=error', `config/biome-fixtures/${name}.ts`], {
      cwd: root,
      stdio: 'inherit',
    });
  } catch (error) {
    status = error.status ?? 1;
  }
  if (status !== expectedStatus) {
    throw new Error(`${name} fixture exited with ${status}; expected ${expectedStatus}`);
  }
  console.log(`${name}: exit ${status} as expected`);
}

runFixture('positive', 0);
runFixture('negative', 1);
