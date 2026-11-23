#!/usr/bin/env node
// Report-only fault witnesses, using the unmodified ordinary project config.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const dependencyRoot = path.dirname(path.dirname(require.resolve('vitest/package.json')));
const vitest = path.join(dependencyRoot, 'vitest/vitest.mjs');
const formatter = 'src/renderer/utils/format.ts';
const files = ['src/renderer/utils/format.test.ts', 'src/renderer/features/agents/TranscriptViewer.test.tsx'];
const output = path.resolve(root, process.argv[2] ?? 'docs/ci-efficiency/formatter-sensitivity-receipt.json');
if (process.argv.length > 3) throw new Error('Usage: node scripts/ci/ci-efficiency-formatter-sensitivity.mjs [receipt.json]');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
const began = performance.now();
// Reserve ten seconds of the 120s envelope for removing our own worktree.
const deadline = began + 110_000;
const sandbox = fs.mkdtempSync(path.join(root, '.formatter-sensitivity-'));
const originals = Object.fromEntries([formatter, ...files, 'vitest.config.ts', 'test/setup-renderer.ts'].map((f) => [f, sha(fs.readFileSync(path.join(root, f)))]));
const receipt = {
  schemaVersion: 1, createdAt: new Date().toISOString(), baselineCommit: head,
  scope: 'Two fault-witness suites only; not the full retained shadow-policy suite',
  files, config: 'vitest.config.ts', project: 'renderer', runtime: { node: process.version, vitest: require('vitest/package.json').version, platform: process.platform, arch: process.arch },
  limits: { mutants: 3, budgetMs: 120_000, executionBudgetMs: 110_000, cleanupBudgetMs: 10_000, workers: 1, processTimeoutMs: 30_000 },
  inputHashes: originals, runnerSha256: sha(fs.readFileSync(fileURLToPath(import.meta.url))), baselines: [], mutants: [],
};
let registered = false;
function command(binary, args, options = {}) {
  const remaining = Math.floor(deadline - performance.now());
  if (remaining <= 0) throw new Error('110s execution budget exhausted; remaining envelope reserved for cleanup');
  return spawnSync(binary, args, { cwd: root, encoding: 'utf8', timeout: Math.min(30_000, remaining), maxBuffer: 8 * 1024 * 1024, ...options });
}
function run(label) {
  const json = path.join(sandbox, 'fault-result.json');
  fs.rmSync(json, { force: true });
  const args = [vitest, 'run', '--config', 'vitest.config.ts', '--project', 'renderer', ...files, '--maxWorkers=1', '--no-file-parallelism', '--reporter=json', '--outputFile', json];
  const start = performance.now();
  const child = command(process.execPath, args, { cwd: sandbox });
  const result = { label, command: [process.execPath, ...args.map((a) => a === json ? '<sandbox>/fault-result.json' : a)], elapsedMs: Math.round((performance.now() - start) * 100) / 100, exitCode: child.status, stderr: child.stderr };
  if (child.error || child.signal) return { ...result, outcome: 'unresolved', reason: child.error?.code ?? child.signal };
  try { result.report = JSON.parse(fs.readFileSync(json, 'utf8')); }
  catch { return { ...result, outcome: 'invalid', reason: 'missing reporter JSON', stdout: child.stdout }; }
  const suites = result.report.testResults;
  if (suites.length !== 2 || suites.some((s) => s.message) || result.report.numRuntimeErrorTestSuites > 0 || ![0, 1].includes(child.status)
      || result.report.numTotalTests !== 14 || result.report.numPassedTests + result.report.numFailedTests !== 14) return { ...result, outcome: 'invalid', reason: 'suite/runtime/process failure or unexpected test counts' };
  result.outcome = 'reported';
  return result;
}
function assertGreen(result) {
  if (result.outcome !== 'reported' || result.exitCode !== 0 || result.report.numPassedTests !== 14 || result.report.numFailedTests !== 0) throw new Error('Original witness subset is not green');
}
function classify(result, hypothesis) {
  if (result.outcome !== 'reported') return { formatter: result.outcome, consumer: result.outcome };
  const outcomes = {};
  for (const [index, role] of ['formatter', 'consumer'].entries()) {
    const suite = result.report.testResults.find((s) => s.name.replaceAll('\\', '/').endsWith(files[index]));
    if (!suite || suite.assertionResults.length !== (index === 0 ? 4 : 10)) { outcomes[role] = 'invalid'; continue; }
    const failures = suite.assertionResults.filter((test) => test.status === 'failed');
    if (suite.assertionResults.some((test) => !['passed', 'failed'].includes(test.status))) { outcomes[role] = 'invalid'; continue; }
    const expectedName = index === 0 ? hypothesis.expected : 'TranscriptViewer shows cost and duration for result events';
    const validMessages = failures.every((test) => Array.isArray(test.failureMessages) && test.failureMessages.length > 0 && test.failureMessages.every((message) => index === 0
      ? /^AssertionError: expected [\s\S]+ to be [\s\S]+ \/\/ Object.is equality/.test(message)
      : test.fullName === expectedName && /^Error: Unable to find an element with the text: 30s\./.test(message) && /30 sec/.test(message)));
    outcomes[role] = failures.length === 0 ? 'escaped' : validMessages && failures.some((test) => test.fullName === expectedName) && result.exitCode === 1 ? 'detected' : 'invalid';
  }
  return outcomes;
}
try {
  const add = command('git', ['worktree', 'add', '--detach', sandbox, head]);
  if (add.status !== 0) throw new Error(add.stderr || 'cannot create isolated worktree');
  registered = true;
  fs.symlinkSync(dependencyRoot, path.join(sandbox, 'node_modules'), 'dir');
  const target = path.join(sandbox, formatter);
  const source = fs.readFileSync(target, 'utf8');
  if (sha(source) !== originals[formatter]) throw new Error('formatter differs from baseline commit');
  for (const [file, hash] of Object.entries(originals)) if (sha(fs.readFileSync(path.join(sandbox, file))) !== hash) throw new Error(`${file} differs from baseline commit`);
  const original = await import(pathToFileURL(target).href + '?original');
  const before = run('original-before'); receipt.baselines.push(before); assertGreen(before);
  const hypotheses = [
    { id: 'rounding-floor', from: 'Math.round(ms / 1000)', to: 'Math.floor(ms / 1000)', witnessMs: 500, expected: 'formatDuration formats sub-minute durations as seconds' },
    { id: 'minute-boundary', from: 'totalSeconds < 60', to: 'totalSeconds <= 60', witnessMs: 60_000, expected: 'formatDuration formats durations under an hour as minutes and seconds' },
    { id: 'seconds-text', from: 'return `${totalSeconds}s`;', to: 'return `${totalSeconds} sec`;', witnessMs: 30_000, expected: 'formatDuration formats sub-minute durations as seconds' },
  ];
  for (const hypothesis of hypotheses) {
    const entry = { ...hypothesis }; receipt.mutants.push(entry);
    if (source.split(hypothesis.from).length !== 2) throw new Error('mutation anchor is not unique');
    fs.writeFileSync(target, source.replace(hypothesis.from, hypothesis.to));
    const mutant = await import(pathToFileURL(target).href + '?' + hypothesis.id);
    entry.witness = { original: original.formatDuration(hypothesis.witnessMs), mutant: mutant.formatDuration(hypothesis.witnessMs) };
    if (entry.witness.original === entry.witness.mutant) throw new Error('non-equivalence not established');
    entry.run = run(hypothesis.id);
    entry.outcomes = classify(entry.run, hypothesis);
    console.log(`${entry.id}: ${JSON.stringify(entry.outcomes)}`);
    fs.writeFileSync(target, source);
  }
  const after = run('original-after'); receipt.baselines.push(after); assertGreen(after);
} catch (error) { receipt.error = String(error); process.exitCode = 1; }
finally {
  // Only the worktree created by this invocation is removed.
  if (registered) {
    const cleanup = spawnSync('git', ['worktree', 'remove', '--force', sandbox], { cwd: root, encoding: 'utf8', timeout: 10_000 });
    if (cleanup.status !== 0) { receipt.cleanupError = cleanup.stderr; process.exitCode = 1; }
  } else fs.rmSync(sandbox, { recursive: true, force: true });
  receipt.sandboxRemoved = !fs.existsSync(sandbox);
  receipt.originalsUnchanged = Object.entries(originals).every(([f, hash]) => sha(fs.readFileSync(path.join(root, f))) === hash);
  receipt.elapsedMs = Math.round(performance.now() - began);
  if (!receipt.sandboxRemoved || !receipt.originalsUnchanged || receipt.mutants.length !== 3 || receipt.mutants.some((m) => !m.outcomes || Object.values(m.outcomes).some((o) => ['invalid', 'unresolved'].includes(o)))) process.exitCode = 1;
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ output, elapsedMs: receipt.elapsedMs, error: receipt.error }));
}
