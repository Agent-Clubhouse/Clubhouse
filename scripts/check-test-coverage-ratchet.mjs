import { spawnSync } from 'node:child_process';

const marker = 'TODO' + '(TC-CRIT-03)';
const baseline = 20;

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
const files = new Set(
  output === ''
    ? []
    : output.trimEnd().split('\n').map((line) => line.slice(0, line.indexOf(':'))),
);
const count = files.size;

if (count > baseline) {
  console.error(`TC-CRIT-03 file count increased: found ${count}, baseline is ${baseline}.`);
  process.exit(1);
}

console.log(`TC-CRIT-03 file count: ${count}/${baseline}.`);
