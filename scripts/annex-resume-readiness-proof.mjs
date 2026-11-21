/** Capture reproducible, head-bound Annex checks without writing shared dependency caches. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const base = '69ef383cefec405d811f1c199f25c10cdc0395b6';
const outIndex = process.argv.indexOf('--out');
if (outIndex < 0 || !process.argv[outIndex + 1]) {
  throw new Error('Usage: node scripts/annex-resume-readiness-proof.mjs --out <new output directory>');
}
const git = (...args) => {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
};
const root = git('rev-parse', '--show-toplevel');
process.chdir(root);
const head = git('rev-parse', 'HEAD');
git('diff', '--quiet', 'HEAD', '--');
const expectedPackages = JSON.parse(fs.readFileSync('package-lock.json', 'utf8')).packages;
const installedPackages = JSON.parse(fs.readFileSync('node_modules/.package-lock.json', 'utf8')).packages;
let verifiedPackages = 0;
for (const [name, expected] of Object.entries(expectedPackages)) {
  if (!name || expected.optional || expected.link) continue;
  const installed = installedPackages[name];
  if (!installed || installed.version !== expected.version || installed.integrity !== expected.integrity) {
    throw new Error(`Installed dependency metadata does not match the lock: ${name}`);
  }
  verifiedPackages++;
}
const out = path.resolve(process.argv[outIndex + 1]);
fs.mkdirSync(out); // Never overwrite a prior receipt.
const digest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const configPath = path.join(root, `.annex-proof-${randomUUID()}.config.ts`);
const temporaryCaches = path.join(out, '.cache');
const cachePath = path.join(temporaryCaches, 'vite');
const config = fs.readFileSync('vitest.config.ts', 'utf8')
  .replaceAll('__dirname', 'import.meta.dirname')
  .replaceAll('plugins: [rawMarkdown()],', `cacheDir: ${JSON.stringify(cachePath)},\n  plugins: [rawMarkdown()],`)
  .replace('globals: true as const,', 'globals: true as const,\n  cache: false as const,');
fs.writeFileSync(configPath, config);
fs.writeFileSync(path.join(out, 'vitest-config.txt'), config);
const results = [];
const startedAt = new Date().toISOString();
const run = (name, command, args) => {
  const output = path.join(out, `${name}.txt`);
  const fd = fs.openSync(output, 'wx');
  const started = new Date().toISOString();
  let result;
  try {
    result = spawnSync(command, args, {
      cwd: root,
      env: { ...process.env, NODE_COMPILE_CACHE: path.join(temporaryCaches, 'node') },
      stdio: ['ignore', fd, fd],
    });
  } finally {
    fs.closeSync(fd);
  }
  const receipt = {
    name, command: [command, ...args], startedAt: started, finishedAt: new Date().toISOString(),
    exitCode: result.status, signal: result.signal, spawnError: result.error?.message ?? null,
    file: path.basename(output), bytes: fs.statSync(output).size, sha256: digest(output),
  };
  results.push(receipt);
  console.log(`${name}: exit ${receipt.exitCode}; ${receipt.bytes} bytes; ${receipt.sha256}`);
};

try {
  run('admission', 'uptime', []);
  run('tests', process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', configPath,
    '--configLoader', 'runner', '--project', 'main', 'src/main/services/annex-client.test.ts',
    'src/main/services/annex-client-buffer.test.ts', 'src/main/ipc/annex-client-handlers.test.ts',
    '--maxWorkers', '1', '--no-file-parallelism']);
  run('typecheck', process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '--incremental', 'false']);
  run('lint', process.execPath, ['node_modules/eslint/bin/eslint.js', 'src/main/services/annex-client.ts',
    'src/main/services/annex-client.test.ts', 'scripts/annex-resume-readiness-proof.mjs']);
  // Raw captured output is retained byte-for-byte, including terminal whitespace.
  // Check all other PR content; raw payload integrity is checked by SHA256 below.
  run('diff-check', 'git', ['diff', '--check', base, head, '--', '.',
    ':(exclude)docs/annex-resume-readiness/evidence/**']);
  const endingHead = git('rev-parse', 'HEAD');
  git('diff', '--quiet', 'HEAD', '--');
  const manifest = {
    schema: 1, validatedHead: head, endingHead, base, startedAt, finishedAt: new Date().toISOString(),
    trackedContentUnchanged: true, sourceTree: git('rev-parse', `${head}:src`),
    scriptsTree: git('rev-parse', `${head}:scripts`),
    node: process.version, platform: process.platform, cpuCount: os.cpus().length,
    packageLockSha256: digest('package-lock.json'),
    dependencyLocation: fs.realpathSync('node_modules'),
    verifiedNonoptionalDependencyPackages: verifiedPackages,
    config: { file: 'vitest-config.txt', sha256: digest(path.join(out, 'vitest-config.txt')) },
    rawOutputPolicy: 'stdout and stderr share an output file descriptor; files are unmodified captures. Empty output plus exitCode 0 is an observed successful check. Raw payloads are excluded only from whitespace checking, not integrity checks.',
    results,
  };
  fs.writeFileSync(path.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const files = ['manifest.json', 'vitest-config.txt', ...results.map((entry) => entry.file)];
  fs.writeFileSync(path.join(out, 'SHA256SUMS.txt'), files.map((file) => `${digest(path.join(out, file))}  ${file}`).join('\n') + '\n');
  if (endingHead !== head || results.some((result) => result.exitCode !== 0)) process.exitCode = 1;
} finally {
  fs.unlinkSync(configPath);
  fs.rmSync(temporaryCaches, { recursive: true, force: true });
}
