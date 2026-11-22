import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

const [key, minimum, ...command] = process.argv.slice(2);
if (!/^\d{2}-[a-z-]+$/.test(key ?? '') || !['4', '6'].includes(minimum) || !command.length) {
  throw new Error('Usage: node capture.mjs NN-name 4|6 command ...');
}
const root = process.cwd();
const prefix = resolve(root, 'docs/evidence/3714-route-budget/attempts', key);
const log = `${prefix}-original.txt`;
const receipt = `${prefix}-receipt.json`;
if (existsSync(log) || existsSync(receipt)) throw new Error(`Refusing to replace evidence: ${prefix}`);
mkdirSync(dirname(log), { recursive: true });
const gate = resolve(homedir(), '.clubhouse/orch/desktop-test-gate.sh');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const inputs = [
  'src/main/services/annex-control.ts', 'src/main/services/annex-control.test.ts',
  'src/main/services/annex-control-bulk.ts', 'src/main/services/annex-control-bulk.test.ts',
  'src/main/services/annex-authorizer.ts', 'src/shared/annex-control-protocol.ts',
  'src/shared/annex-control-protocol.test.ts', 'src/shared/annex-binary-limits.ts',
  'src/shared/icon-limits.ts', 'src/shared/chat/index.ts', 'src/shared/chat/attachments.ts',
  'src/main/services/annex-full-events.ts',
  'src/shared/handoff-transfer.ts', 'src/main/services/annex-routes.ts',
  'src/shared/annex-problems.ts', 'src/shared/types.ts', 'src/main/services/annex-tls.ts',
  'src/main/services/annex-device-signal.ts', 'src/main/services/log-service.ts',
  'test/global-setup.ts', 'test/standard-runtime-boundary.ts', 'vitest.config.ts',
  'tsconfig.json', 'docs/annex-reverse-routes.tsconfig.json', 'package.json', 'package-lock.json',
  'docs/evidence/3714-route-budget/capture.mjs',
];
const seal = () => ({
  head: git('rev-parse', 'HEAD'),
  tree: git('rev-parse', 'HEAD^{tree}'),
  trackedStatus: git('status', '--porcelain=v1', '--untracked-files=no'),
  trackedDiffSha256: hash(execFileSync('git', ['diff', 'HEAD', '--binary'], { cwd: root })),
  gateSha256: hash(readFileSync(gate)),
  inputs: inputs.map((path) => ({ path, sha256: hash(readFileSync(resolve(root, path))) })),
});
const before = seal();
const startedAt = new Date().toISOString();
const run = spawnSync(gate, ['lane-p2', minimum, '--', ...command], {
  cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
});
const finishedAt = new Date().toISOString();
const after = seal();
const raw = `${run.stdout ?? ''}${run.stderr ?? ''}`;
writeFileSync(log, raw, { flag: 'wx' });
writeFileSync(receipt, `${JSON.stringify({
  command: [gate, 'lane-p2', minimum, '--', ...command], minimumGiB: Number(minimum),
  startedAt, finishedAt, before, after, inputsUnchanged: JSON.stringify(before) === JSON.stringify(after),
  exit: run.status, signal: run.signal, processError: run.error?.message ?? null,
  logSha256: hash(Buffer.from(raw)), stdoutThenStderr: true,
}, null, 2)}\n`, { flag: 'wx' });
console.log(raw);
if (run.error) throw run.error;
if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Execution inputs changed during the command.');
process.exitCode = run.status ?? 1;
