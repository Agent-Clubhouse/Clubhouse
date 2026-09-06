import { spawnSync } from 'node:child_process';

const marker = 'TODO' + '(TC-CRIT-03)';
// Baseline: 29 marker occurrences across the 20 grandfathered files tracked by #1594.
const baseline = 29;

const result = spawnSync(
  'git',
  ['grep', '-n', '--fixed-strings', marker, '--', '*.ts', '*.tsx', '*.mjs'],
  { encoding: 'utf8' },
);
if (result.error) throw result.error;
if (result.status !== 0 && result.status !== 1) {
  throw new Error(result.stderr.trim() || `git grep exited with status ${result.status}`);
}
const output = result.status === 1 ? '' : result.stdout;
const count = output.split(marker).length - 1;

if (count > baseline) {
  console.error(`TC-CRIT-03 marker count increased: found ${count}, baseline is ${baseline}.`);
  process.exit(1);
}

console.log(`TC-CRIT-03 marker count: ${count}/${baseline}.`);
