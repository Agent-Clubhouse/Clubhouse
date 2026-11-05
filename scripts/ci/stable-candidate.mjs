// Dispatch only: packages candidate_sha as a stable version and launches it on a
// hosted runner, to check the Preview gates in a real packaged build. Never signs,
// notarizes or publishes, commits nothing and uploads no build. See docs/ci.md.
//
// Two checkouts, so what was built is never in doubt. This harness runs from the
// workflow's revision, in harness/. The app is packaged only from candidate/, at
// candidate_sha, with that checkout's own forge.config.ts and node_modules. So a
// harness fix doesn't move the candidate, and the candidate can't change the checks.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  assertCandidateReportsGates, assertDispatchContext, assertHardenedFuses, assertResultsOnly, buildLaunchEnv,
  candidateVersion, checkRenderer, checkStartupRecord, connectCdp, expectedFor, findMainBundle, metadataDifferences,
  parseDevToolsPort, parseStartupRecord, pickRendererTarget, rendererProbeSource, SCENARIOS, summarize,
  verifyCandidateCheckout, verifyHarnessCheckout, withCandidateVersion,
} from './stable-candidate-lib.mjs';

// Before anything is imported from Forge, packaged or launched.
assertDispatchContext(process.env);
// The input's format is all that can be checked before the candidate is checked out.
if (process.argv[2] === '--check-input') process.exit(0);

const workspace = path.resolve(process.env.GITHUB_WORKSPACE);
const harnessRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
assert.equal(harnessRoot, path.join(workspace, 'harness'), 'The harness must run from harness/ in the workspace');
const root = path.join(workspace, 'candidate');
const candidateSha = process.env.CANDIDATE_SHA;
const workflowSha = process.env.GITHUB_SHA;
const seeds = await import('../../e2e/stable-state-seeds.mjs');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const git = (args, cwd = root) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: {
  ...process.env, GIT_AUTHOR_NAME: 'Candidate', GIT_AUTHOR_EMAIL: 'candidate@test.local', GIT_COMMITTER_NAME: 'Candidate', GIT_COMMITTER_EMAIL: 'candidate@test.local',
} }).trim();

const verifyCandidate = () => verifyCandidateCheckout({ sha: candidateSha, git });
verifyHarnessCheckout({ sha: workflowSha, git: (args) => git(args, harnessRoot) });
verifyCandidate();
assertCandidateReportsGates(fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8'));
// Run before npm ci, so a wrong commit never installs anything.
if (process.argv[2] === '--verify-candidate') {
  console.log(`Candidate ${candidateSha} is on main and clean. Harness is ${workflowSha}.`);
  process.exit(0);
}

const platform = process.platform;
const arch = process.arch;
const runnerTemp = process.env.RUNNER_TEMP;
const results = path.join(workspace, 'stable-candidate-results');
fs.mkdirSync(results, { recursive: true });
process.chdir(root);
// Every dependency, Forge included, comes from the candidate's own node_modules.
const require = createRequire(path.join(root, 'package.json'));

// ---------------------------------------------------------------------------
// Package
// ---------------------------------------------------------------------------

const packagePath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const version = candidateVersion(pkg.version);

const { createJiti } = require('jiti');
const jiti = createJiti(path.join(root, 'package.json'));
const { default: base, assertHardenedFuseWire } = await jiti.import(path.join(root, 'forge.config.ts'));
const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { getCurrentFuseWire } = require('@electron/fuses');
const asar = require('@electron/asar');

const config = {
  ...base,
  packagerConfig: { ...base.packagerConfig, osxSign: false, osxNotarize: undefined },
  plugins: base.plugins.map((plugin) => (plugin instanceof FusesPlugin
    ? new FusesPlugin({ ...plugin.fusesConfig, resetAdHocDarwinSignature: false }) : plugin)),
  makers: [],
  publishers: [],
};
const assertUnsigned = (resolved) => {
  assert.equal(resolved.packagerConfig.osxSign, false);
  assert.equal(resolved.packagerConfig.osxNotarize, undefined);
  assert.deepEqual(resolved.publishers, []);
  assert.deepEqual(resolved.makers, []);
  const fuses = resolved.plugins.find((plugin) => plugin.name === 'fuses').fusesConfig;
  assert.equal(fuses.resetAdHocDarwinSignature, false);
  [false, true, false, false, true, true].forEach((value, index) => assert.equal(fuses[index], value));
};
assertUnsigned(config);
config.hooks = { ...base.hooks, prePackage: async (resolved, ...args) => {
  assertUnsigned(resolved);
  if (base.hooks?.prePackage) await base.hooks.prePackage(resolved, ...args);
} };
const configLoader = require('@electron-forge/core/dist/util/forge-config');
// A config file path is insufficient: Forge auto-discovery can override it.
configLoader.registerForgeConfigForDirectory(root, config);
// What webpack bakes in as the build commit. Without this, anything but a git
// checkout falls back to GITHUB_SHA, which here is the workflow's revision.
process.env.CLUBHOUSE_BUILD_SHA = candidateSha;
try {
  await withCandidateVersion(packagePath, version, async () => {
    const { api } = require('@electron-forge/core');
    await api.package({ dir: root, platform, arch, interactive: false });
  });
} finally {
  configLoader.unregisterForgeConfigForDirectory(root);
}
assert.equal(JSON.parse(fs.readFileSync(packagePath, 'utf8')).version, pkg.version, 'package.json was not restored');
verifyCandidate();

const outDir = path.join(root, 'out', `Clubhouse-${platform}-${arch}`);
let appPath = platform === 'darwin' ? path.join(outDir, 'Clubhouse.app') : outDir;

// A runner copy, ad-hoc signed with no identity, because Apple Silicon won't run
// the unsigned build. Lives in the runner temp and is never uploaded.
if (platform === 'darwin') {
  const copyDir = fs.mkdtempSync(path.join(runnerTemp, 'stable-candidate-copy-'));
  const copy = path.join(copyDir, 'Clubhouse.app');
  execFileSync('/usr/bin/ditto', [appPath, copy]);
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '-s', '-', copy]);
  appPath = copy;
}
// What the package sets at install. The sandbox stays on, unlike the E2E jobs.
if (platform === 'linux') {
  const sandbox = path.join(outDir, 'chrome-sandbox');
  execFileSync('sudo', ['chown', 'root:root', sandbox]);
  execFileSync('sudo', ['chmod', '4755', sandbox]);
}

const binary = platform === 'darwin' ? path.join(appPath, 'Contents/MacOS/Clubhouse')
  : platform === 'win32' ? path.join(appPath, 'Clubhouse.exe') : path.join(appPath, 'clubhouse');
const asarPath = platform === 'darwin' ? path.join(appPath, 'Contents/Resources/app.asar') : path.join(appPath, 'resources/app.asar');
const fuseTarget = platform === 'darwin' ? appPath : binary;

await assertHardenedFuseWire(fuseTarget);
const fuses = await getCurrentFuseWire(fuseTarget);
assertHardenedFuses(fuses);

const packaged = { asarPackageVersion: JSON.parse(asar.extractFile(asarPath, 'package.json').toString()).version };
assert.equal(packaged.asarPackageVersion, version);
const mainBundle = findMainBundle(asar.listPackage(asarPath));
assert.ok(mainBundle, 'No main bundle in the packaged app.asar');
packaged.bakedBuildSha = asar.extractFile(asarPath, mainBundle).toString().includes(candidateSha) ? candidateSha : null;
assert.equal(packaged.bakedBuildSha, candidateSha, 'The packaged build does not carry candidate_sha as its build commit');
if (platform === 'darwin') {
  const plist = path.join(appPath, 'Contents/Info.plist');
  const field = (key) => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { encoding: 'utf8' }).trim();
  packaged.plist = Object.fromEntries(['CFBundleShortVersionString', 'CFBundleVersion', 'CFBundleIdentifier', 'CFBundleName', 'CFBundleDisplayName', 'LSMinimumSystemVersion'].map((key) => [key, field(key)]));
  assert.equal(packaged.plist.CFBundleShortVersionString, version);
}
if (platform === 'win32') {
  const script = `(Get-Item -LiteralPath '${binary}').VersionInfo | Select-Object FileVersion,ProductVersion,ProductName | ConvertTo-Json`;
  packaged.windowsVersion = JSON.parse(execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' }));
}

const provenance = {
  candidateSha,
  packagedFrom: 'candidate/, at candidateSha, with its own forge.config.ts and node_modules',
  workflowSha,
  workflowRef: process.env.GITHUB_REF,
  harnessFrom: 'harness/, at workflowSha: this script, its checks and the seeds. None of it is packaged.',
  runId: process.env.GITHUB_RUN_ID,
  attempt: process.env.GITHUB_RUN_ATTEMPT,
  platform,
  arch,
  sourceVersion: pkg.version,
  candidateVersion: version,
  electron: pkg.devDependencies.electron,
  asarSha256: createHash('sha256').update(fs.readFileSync(asarPath)).digest('hex'),
  fuses,
  fusesMatchHardened: true,
  packaged,
  differences: metadataDifferences({
    platform, sourceVersion: pkg.version, version, packaged,
    production: { appBundleId: base.packagerConfig.appBundleId, name: base.packagerConfig.name },
  }),
  signing: platform === 'darwin' ? 'ad-hoc on a runner copy' : 'none',
  notarization: false,
  published: false,
  uploadedBuild: false,
};
writeJson(path.join(results, 'provenance.json'), provenance);

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

function seedProfile(profile, state, flags, preview) {
  const write = (name, value) => fs.writeFileSync(path.join(profile, name), JSON.stringify(value, null, 2));
  write('logging-settings.json', { enabled: true, minLogLevel: 'info', telemetryRecording: false });
  write('annex-settings.json', { enabled: false, enableServer: false, enableClient: false });
  if (flags) write('experimental-settings.json', seeds.BETA_FLAGS);
  if (state === 'fresh' && preview) {
    for (const [name, value] of Object.entries(seeds.updateSettings(true))) write(name, value);
  }
  if (state === 'beta') {
    for (const [name, value] of Object.entries(seeds.betaFiles(preview))) write(name, value);
    const transcript = path.join(profile, 'agent-logs', 'chat', seeds.AGENT_ID, `${seeds.LAST_SESSION}.jsonl`);
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, seeds.BETA_TRANSCRIPT);
  }
}

/** A repo holding the Chat-mode agent, registered with the app. */
function seedProject(profile, scenarioDir) {
  const project = path.join(scenarioDir, 'project');
  fs.mkdirSync(path.join(project, '.clubhouse'), { recursive: true });
  fs.writeFileSync(path.join(project, '.clubhouse', 'agents.json'), JSON.stringify(seeds.betaAgents()));
  fs.writeFileSync(path.join(project, 'README.md'), '# stable candidate\n');
  git(['init', '-q'], project);
  git(['add', '-A'], project);
  git(['commit', '-qm', 'init'], project);
  const baseDir = path.join(profile, '.clubhouse');
  fs.mkdirSync(baseDir, { recursive: true });
  fs.writeFileSync(path.join(baseDir, 'projects.json'), JSON.stringify({ version: 1, projects: [{ id: 'proj_stable_candidate', name: 'project', path: project }] }));
  return project;
}

/** Saved bytes by file, with null for one that doesn't exist. */
const readSaved = (profile) => Object.fromEntries(seeds.UNTOUCHED_FILES.map((name) => {
  const file = path.join(profile, name);
  return [name, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null];
}));

function readStartupRecord(profile) {
  const logDir = path.join(profile, '.clubhouse', 'logs');
  for (const name of fs.existsSync(logDir) ? fs.readdirSync(logDir) : []) {
    if (!name.endsWith('.jsonl')) continue;
    const record = parseStartupRecord(fs.readFileSync(path.join(logDir, name), 'utf8'));
    if (record) return record;
  }
  return null;
}

async function waitFor(read, ms, interval = 250) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await pause(interval);
  }
  return read();
}

/** Starts the app, runs `drive` if CDP connects, and always stops only its own process tree. */
async function launch(profile, drive) {
  // Outside the try on purpose: a checkout that moved stops the whole run.
  verifyCandidate();
  const env = buildLaunchEnv(process.env, { profile, runnerTemp });
  const child = spawn(binary, ['--remote-debugging-port=0'], { cwd: profile, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let consoleOutput = '';
  let spawnError;
  child.on('error', (error) => { spawnError = error; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { consoleOutput = (consoleOutput + chunk.toString()).slice(-1024 * 1024); });
  const exited = new Promise((resolve) => child.once('close', resolve));
  const outcome = { record: null, renderer: { status: 'not-run' }, exit: 'killed' };
  try {
    outcome.record = await waitFor(() => {
      if (spawnError) throw spawnError;
      assert.equal(child.exitCode, null, 'Packaged app exited before its startup record');
      return readStartupRecord(profile);
    }, 60_000);
    if (!outcome.record) throw new Error('No startup record within 60 seconds');

    let cdp;
    try {
      const activePort = () => {
        try { return fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8'); } catch { return ''; }
      };
      const port = await waitFor(() => parseDevToolsPort(consoleOutput, activePort()), 20_000);
      if (!port) throw new Error('No DevTools port: the build may not honour --remote-debugging-port');
      const target = await waitFor(async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/json/list`);
          return pickRendererTarget(await response.json());
        } catch {
          return null;
        }
      }, 30_000, 500);
      if (!target) throw new Error('No renderer target over CDP');
      cdp = await connectCdp(target.webSocketDebuggerUrl, globalThis.WebSocket);
      outcome.renderer = { status: 'driven', value: await drive(cdp) };
      cdp.close();
      // Asks the app to quit so localStorage reaches disk. Killing it is the fallback below.
      const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      const browser = await connectCdp(webSocketDebuggerUrl, globalThis.WebSocket);
      await Promise.race([browser.send('Browser.close').catch(() => {}), pause(5_000)]);
      await Promise.race([exited, pause(10_000)]);
      browser.close();
      if (child.exitCode !== null) outcome.exit = 'graceful';
    } catch (error) {
      outcome.renderer = { status: 'not-run', error: error instanceof Error ? error.message : String(error) };
    }
  } catch (error) {
    outcome.launchError = error instanceof Error ? error.message : String(error);
  } finally {
    // Target only this owned process and its descendants, never an image name.
    if (child.pid) {
      if (platform === 'win32') {
        try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already exited */ }
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
      }
      await Promise.race([exited, pause(5_000)]);
    }
  }
  outcome.console = consoleOutput;
  return outcome;
}

function saveLogs(profile, name, consoleOutput) {
  const dest = path.join(results, 'logs', name);
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'console.log'), consoleOutput ?? '');
  const logDir = path.join(profile, '.clubhouse', 'logs');
  for (const file of fs.existsSync(logDir) ? fs.readdirSync(logDir) : []) {
    if (file.endsWith('.jsonl')) fs.copyFileSync(path.join(logDir, file), path.join(dest, file));
  }
}

function applyOutcome(result, outcome, expected) {
  if (outcome.launchError || !outcome.record) {
    result.main = { status: 'fail', problems: [outcome.launchError ?? 'no startup record'] };
  } else {
    const problems = checkStartupRecord(outcome.record, expected, { version, electron: pkg.devDependencies.electron });
    result.main = { status: problems.length ? 'fail' : 'pass', problems, record: outcome.record };
  }
  if (outcome.renderer.status === 'driven') {
    const problems = checkRenderer(outcome.renderer.value, expected);
    result.renderer = { status: problems.length ? 'fail' : 'pass', problems, observed: outcome.renderer.value };
  } else {
    result.renderer = outcome.renderer;
  }
  result.exit = outcome.exit;
}

async function runScenario(scenario) {
  const dir = fs.mkdtempSync(path.join(runnerTemp, 'stable-candidate-'));
  const profile = path.join(dir, 'profile');
  fs.mkdirSync(profile);
  const result = { name: scenario.name, scenario };
  const expected = expectedFor(scenario);
  try {
    seedProfile(profile, scenario.state, scenario.flags, scenario.preview);
    const project = scenario.state === 'beta' ? seedProject(profile, dir) : null;
    const saved = expected.savedFilesUntouched ? readSaved(profile) : null;
    const outcome = await launch(profile, (cdp) => cdp.evaluate(rendererProbeSource({ agentId: seeds.AGENT_ID, orchestrator: seeds.ORCHESTRATOR, projectPath: project })));
    applyOutcome(result, outcome, expected);
    const problems = [];
    if (saved) {
      const now = readSaved(profile);
      for (const name of Object.keys(saved)) if (now[name] !== saved[name]) problems.push(`${name} changed`);
    }
    if (project) {
      const agents = JSON.parse(fs.readFileSync(path.join(project, '.clubhouse', 'agents.json'), 'utf8'));
      if (agents.find((a) => a.id === seeds.AGENT_ID)?.runtimeMode !== 'chat') problems.push('The agent lost its saved Chat mode');
    }
    result.files = { status: problems.length ? 'fail' : 'pass', problems };
    saveLogs(profile, scenario.name, outcome.console);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  return result;
}

/** Beta state through Preview on, off and on, with a saved layout, in one profile. */
async function runRoundTrip() {
  const name = 'beta-roundtrip-on-off-on';
  const dir = fs.mkdtempSync(path.join(runnerTemp, 'stable-candidate-'));
  const profile = path.join(dir, 'profile');
  fs.mkdirSync(profile);
  const result = { name, steps: [] };
  const setPreview = (preview) => {
    for (const [file, value] of Object.entries(seeds.updateSettings(preview))) fs.writeFileSync(path.join(profile, file), JSON.stringify(value, null, 2));
  };
  const layoutWidth = (cdp) => cdp.evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(seeds.CHROME_STORAGE_KEY)}) ?? '{}').sidebarWidth`);
  try {
    seedProfile(profile, 'beta', true, true);
    const project = seedProject(profile, dir);
    const probe = rendererProbeSource({ agentId: seeds.AGENT_ID, orchestrator: seeds.ORCHESTRATOR, projectPath: project });
    let graceful = true;
    let saved;
    for (const [index, preview] of [true, false, true].entries()) {
      setPreview(preview);
      const expected = expectedFor({ state: 'beta', preview, flags: true });
      const outcome = await launch(profile, async (cdp) => {
        const value = await cdp.evaluate(probe);
        if (index === 0) {
          await pause(1_000);
          await cdp.evaluate(`(() => { const key = ${JSON.stringify(seeds.CHROME_STORAGE_KEY)}; const saved = JSON.parse(localStorage.getItem(key) ?? '{}'); localStorage.setItem(key, JSON.stringify({ ...saved, sidebarWidth: ${seeds.SAVED_SIDEBAR_WIDTH} })); })()`);
        } else {
          value.layoutWidth = await layoutWidth(cdp);
        }
        return value;
      });
      const step = { preview };
      applyOutcome(step, outcome, expected);
      graceful = graceful && outcome.exit === 'graceful';
      if (index === 0) saved = readSaved(profile);
      const problems = [];
      const now = readSaved(profile);
      // Preview off must leave it all alone. Preview on is free to write its own settings.
      if (!preview) for (const file of Object.keys(saved)) if (now[file] !== saved[file]) problems.push(`${file} changed`);
      // Only meaningful if the first step quit cleanly and so flushed localStorage.
      if (index > 0 && graceful && step.renderer.observed && step.renderer.observed.layoutWidth !== seeds.SAVED_SIDEBAR_WIDTH) problems.push('The saved layout was lost');
      step.files = { status: problems.length ? 'fail' : 'pass', problems };
      result.steps.push(step);
      saveLogs(profile, `${name}-${index}`, outcome.console);
    }
    result.layout = graceful ? 'checked' : 'inconclusive: a step was killed, so localStorage may not have flushed';
    const statuses = (key) => result.steps.map((step) => step[key].status);
    result.main = { status: statuses('main').every((s) => s === 'pass') ? 'pass' : 'fail' };
    result.renderer = { status: statuses('renderer').every((s) => s === 'pass') ? 'pass' : statuses('renderer').includes('fail') ? 'fail' : 'not-run' };
    result.files = { status: statuses('files').every((s) => s === 'pass') ? 'pass' : 'fail' };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  return result;
}

const scenarioResults = [];
for (const scenario of SCENARIOS) {
  console.log(`--- ${scenario.name}`);
  scenarioResults.push(await runScenario(scenario));
}
console.log('--- beta round trip');
scenarioResults.push(await runRoundTrip());

// What app.getVersion() really said, now that the app has run.
packaged.appGetVersion = scenarioResults.find((r) => r.main?.record)?.main.record.version ?? scenarioResults.flatMap((r) => r.steps ?? []).find((step) => step.main?.record)?.main.record.version ?? null;
provenance.differences = metadataDifferences({
  platform, sourceVersion: pkg.version, version, packaged,
  production: { appBundleId: base.packagerConfig.appBundleId, name: base.packagerConfig.name },
});
writeJson(path.join(results, 'provenance.json'), provenance);

const summary = summarize(scenarioResults);
writeJson(path.join(results, 'results.json'), {
  candidateSha,
  workflowSha,
  platform,
  arch,
  candidateVersion: version,
  host: os.release(),
  summary,
  scope: {
    main: 'Startup record from the packaged app: main-process gates only',
    renderer: 'CDP on the packaged renderer: what the window drew and what the preload was told',
    files: 'Bytes on disk after quitting',
    notCovered: 'No agent is woken and no CLI runs. Unsigned or ad-hoc builds, so no signing, notarization, Gatekeeper or update path.',
  },
  scenarios: scenarioResults,
});
assertResultsOnly(results);
console.log(JSON.stringify(summary, null, 2));
if (summary.status !== 'pass') console.error(`::error::Stable candidate ${summary.status} on ${platform}: see results.json`);
process.exit(summary.status === 'pass' ? 0 : 1);
