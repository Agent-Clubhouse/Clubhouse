#!/usr/bin/env node
// Local, serial pilot: never changes the classifier or its existing tests.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { reportVerdict, combinedVerdict } from './ci-efficiency-mutation-verdict.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const vitest = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const sourcePath = path.join(root, 'scripts/ci/classify-changes.mjs');
const testPath = path.join(root, 'scripts/ci/ci-scripts.test.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const tests = fs.readFileSync(testPath, 'utf8');
const hash = (text) => createHash('sha256').update(text).digest('hex');
const output = path.resolve(root, process.argv[2] ?? 'docs/ci-efficiency/mutation-results.json');
if (process.argv.length > 3) throw new Error('Usage: node scripts/ci/ci-efficiency-mutation.mjs [results.json]');

// Each witness is an explicit counterexample, independent of the test oracle.
const hypotheses = [
  { id: 'docs-any', from: 'const docsOnly = changed.every(', to: 'const docsOnly = changed.some(', test: 'docs-only changes need nothing', files: ['docs/ci.md', 'src/main/index.ts'] },
  { id: 'empty-e2e', from: "docsOnly: false, e2e: true, macosBuild: true, macosBuildReason: 'no changed files listed'", to: "docsOnly: false, e2e: false, macosBuild: true, macosBuildReason: 'no changed files listed'", test: 'with no file list it runs everything', files: [] },
  { id: 'test-e2e', from: '&& !isTest(f) && !isStableCandidateOnly(f)', to: '&& !isStableCandidateOnly(f)', test: 'a unit-test-only change skips the E2E build', files: ['src/main/a.test.ts'] },
  { id: 'stable-e2e', from: '&& !isStableCandidateOnly(f) && !isCliDenylistOnly(f)', to: '&& !isCliDenylistOnly(f)', test: 'the dispatch-only stable candidate files need neither E2E nor the macOS build', files: ['scripts/ci/stable-candidate.mjs'] },
  { id: 'path-build', from: 'if (byPath) reason =', to: 'if (false) reason =', test: 'the macOS build by path: packaging inputs, the app menu, renderer chrome and the CI itself', files: ['forge.config.ts'] },
  { id: 'dependency-build', from: 'else if (byDependency) reason =', to: 'else if (false) reason =', test: 'dependency changes count only for Electron, native modules and forge', files: ['package.json'], lines: [['package.json', ['"electron": "1"']]] },
  { id: 'marker-build', from: 'else if (byMarker) reason =', to: 'else if (false) reason =', test: 'the macOS build for darwin lines in window chrome, preload or the renderer', files: ['src/main/index.ts'], lines: [['src/main/index.ts', ["process.platform === 'darwin'"]]] },
  { id: 'removed-lines', from: "(line.startsWith('+') || line.startsWith('-'))", to: "line.startsWith('+')", test: 'parses changed lines per file from git diff -U0', diff: 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +0 @@\n-removed\n' },
];

const started = performance.now();
const deadline = started + 600_000;
// Inside the checkout so existing Vitest dependencies resolve without installing.
const sandbox = fs.mkdtempSync(path.join(root, '.ci-mutation-'));
const modulePath = path.join(sandbox, 'classify-changes.mjs');
const config = path.join(sandbox, 'vitest.config.mjs');
fs.writeFileSync(path.join(sandbox, 'ci-scripts.test.ts'), tests);
fs.writeFileSync(config, `export default ${JSON.stringify({ root: sandbox, test: { include: ['ci-scripts.test.ts'], environment: 'node', maxWorkers: 1, fileParallelism: false } })};\n`);
const report = {
  schemaVersion: 2, createdAt: new Date().toISOString(), baseCommit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(),
  runtime: { node: process.version, vitest: require('vitest/package.json').version, platform: process.platform, arch: process.arch, cpus: os.cpus().length },
  inputs: { source: 'scripts/ci/classify-changes.mjs', sourceSha256: hash(source), tests: 'scripts/ci/ci-scripts.test.ts', testsSha256: hash(tests), runnerSha256: hash(fs.readFileSync(fileURLToPath(import.meta.url))), verdictSha256: hash(fs.readFileSync(new URL('./ci-efficiency-mutation-verdict.mjs', import.meta.url))) },
  limits: { hypotheses: 8, repetitions: 2, workers: 1, budgetMs: 600_000, processTimeoutMs: 30_000 },
  strategies: { targeted: 'Existing classifier suite filtered to one named test per hypothesis', full: 'All existing classifier tests (not the repository suite)' },
  baselines: [], hypotheses: [],
};

function run(strategy, name, matcher) {
  const remaining = Math.floor(deadline - performance.now());
  if (remaining <= 0) return { outcome: 'unresolved', reason: 'pilot budget exhausted', elapsedMs: 0 };
  const json = path.join(sandbox, 'result.json');
  fs.rmSync(json, { force: true });
  const args = [vitest, 'run', '--config', config, '--maxWorkers=1', '--no-file-parallelism', '--reporter=json', '--outputFile', json];
  if (strategy === 'targeted') args.push('--testNamePattern', `^classify-changes ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  const start = performance.now();
  const child = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: Math.min(30_000, remaining), maxBuffer: 2 * 1024 * 1024, env: { ...process.env, NO_COLOR: '1' } });
  const result = { elapsedMs: Math.round((performance.now() - start) * 100) / 100, exitCode: child.status };
  if (child.error || child.signal) return { ...result, outcome: 'unresolved', reason: child.error?.code ?? child.signal };
  let data;
  try { data = JSON.parse(fs.readFileSync(json, 'utf8')); }
  catch { return { ...result, outcome: 'invalid', reason: 'missing or invalid test report', output: (child.stderr + child.stdout).slice(-2000) }; }
  return { ...result, ...reportVerdict(data, child.status, name, matcher) };
}

function green(strategy, name, phase) {
  fs.writeFileSync(modulePath, source);
  const result = run(strategy, name);
  report.baselines.push({ phase, strategy, name, ...result });
  if (result.outcome !== 'survived') throw new Error(`Original is not green: ${phase} ${name ?? strategy}`);
}

const witness = (module, hypothesis) => hypothesis.diff
  ? [...module.changedLinesByFile(hypothesis.diff)]
  : module.classify(hypothesis.files, new Map(hypothesis.lines));

try {
  green('full', undefined, 'before');
  const original = await import(pathToFileURL(modulePath).href + '?original');
  for (const hypothesis of hypotheses) {
    green('targeted', hypothesis.test, 'before');
    const entry = { id: hypothesis.id, from: hypothesis.from, to: hypothesis.to, targetedTest: hypothesis.test, witnessInput: hypothesis.diff ?? { files: hypothesis.files, lines: hypothesis.lines ?? [] }, runs: {} };
    report.hypotheses.push(entry);
    if (source.split(hypothesis.from).length !== 2) { entry.classification = 'invalid'; entry.reason = 'mutation anchor must occur exactly once'; continue; }
    fs.writeFileSync(modulePath, source.replace(hypothesis.from, hypothesis.to));
    let mutant;
    try { mutant = await import(pathToFileURL(modulePath).href + '?' + hypothesis.id); }
    catch (error) { entry.classification = 'invalid'; entry.reason = String(error); continue; }
    entry.witness = { original: witness(original, hypothesis), mutant: witness(mutant, hypothesis) };
    if (JSON.stringify(entry.witness.original) === JSON.stringify(entry.witness.mutant)) { entry.classification = 'unresolved'; entry.reason = 'witness did not prove non-equivalence; not counted as equivalent'; continue; }
    entry.equivalence = 'non-equivalent (explicit counterexample)';
    entry.expectedMatcher = ['docs-any', 'test-e2e', 'stable-e2e', 'removed-lines'].includes(hypothesis.id) ? 'deeply equal' : 'match object';
    for (const strategy of ['targeted', 'full']) {
      entry.runs[strategy] = Array.from({ length: 2 }, () => run(strategy, hypothesis.test, entry.expectedMatcher));
    }
    entry.classification = combinedVerdict(entry.runs);
    console.log(`${entry.id}: targeted=${entry.runs.targeted.map((r) => r.outcome).join('/')} full=${entry.runs.full.map((r) => r.outcome).join('/')}`);
  }
  green('full', undefined, 'after');
} catch (error) {
  report.error = String(error);
  process.exitCode = 1;
} finally {
  report.originalsUnchanged = fs.readFileSync(sourcePath, 'utf8') === source && fs.readFileSync(testPath, 'utf8') === tests;
  fs.rmSync(sandbox, { recursive: true, force: true });
  report.sandboxRemoved = !fs.existsSync(sandbox);
  report.elapsedMs = Math.round(performance.now() - started);
  report.summary = Object.fromEntries(['killed', 'survived', 'invalid', 'equivalent', 'unresolved'].map((state) => [state, report.hypotheses.filter((h) => h.classification === state).length]));
  report.strategyElapsedMs = Object.fromEntries(['targeted', 'full'].map((strategy) => [strategy, Math.round(report.hypotheses.flatMap((h) => h.runs[strategy] ?? []).reduce((sum, r) => sum + r.elapsedMs, 0))]));
  if (!report.originalsUnchanged || report.summary.invalid || report.summary.unresolved || report.hypotheses.length !== 8) process.exitCode = 1;
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ output, summary: report.summary, elapsedMs: report.elapsedMs, strategyElapsedMs: report.strategyElapsedMs }));
}
