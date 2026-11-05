// The parts of scripts/ci/stable-candidate.mjs that don't package or launch
// anything, kept apart so they can be tested with fakes.
import fs from 'node:fs';
import path from 'node:path';
import { BETA_FLAGS, PREVIEW_ONLY_FLAGS, PREVIEW_PAGES } from '../../e2e/stable-state-seeds.mjs';

/** Fuse wire values are ASCII '0'/'1', in the order of forge.config.ts `hardenedFuseValues`. */
export const HARDENED_FUSE_WIRE = [48, 49, 48, 48, 49, 49];

/** The only variables a packaged launch inherits. Never CI credentials. */
export const LAUNCH_ENV_ALLOWLIST = [
  'PATH', 'HOME', 'TMPDIR', 'LANG',
  'SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA',
  'DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR',
];

const FULL_SHA = /^[0-9a-f]{40}$/;

/** Everything this job may leave in its artifact: no app, archive or installer. */
const RESULT_EXTENSIONS = new Set(['.json', '.jsonl', '.txt', '.log']);

/**
 * Refuses to run anywhere but a hosted runner, on a dispatch that asked for this.
 * Checked before anything is imported, packaged or launched.
 */
export function assertDispatchContext(env) {
  const need = (name, expected) => {
    if (env[name] !== expected) throw new Error(`stable-candidate runs only from its dispatch: ${name} must be ${expected}, not ${env[name] ?? 'unset'}`);
  };
  need('GITHUB_ACTIONS', 'true');
  need('GITHUB_EVENT_NAME', 'workflow_dispatch');
  need('RUNNER_ENVIRONMENT', 'github-hosted');
  need('STABLE_CANDIDATE', 'true');
  if (!env.RUNNER_TEMP) throw new Error('stable-candidate needs RUNNER_TEMP for its disposable profiles');
  if (!env.GITHUB_WORKSPACE) throw new Error('stable-candidate needs GITHUB_WORKSPACE');
  assertFullSha('CANDIDATE_SHA', env.CANDIDATE_SHA);
  assertFullSha('GITHUB_SHA', env.GITHUB_SHA);
  if (env.CLUBHOUSE_TEST_STABLE_BUILD !== undefined) throw new Error('CLUBHOUSE_TEST_STABLE_BUILD must be unset: a packaged build is the thing under test');
}

function assertFullSha(name, value) {
  if (!FULL_SHA.test(value ?? '')) throw new Error(`${name} must be a full 40-character lower-case SHA, not ${value ?? 'unset'}`);
}

/**
 * Throws unless the candidate checkout is exactly `sha`, on main, with no tracked
 * file changed. Runs before packaging and again before every launch. `git` runs
 * in the candidate checkout and throws on a non-zero exit.
 */
export function verifyCandidateCheckout({ sha, git }) {
  assertFullSha('candidate_sha', sha);
  const head = git(['rev-parse', 'HEAD']).trim();
  if (head !== sha) throw new Error(`The checkout is at ${head}, not candidate_sha ${sha}`);
  try {
    git(['rev-parse', '--verify', 'refs/remotes/origin/main']);
  } catch {
    throw new Error('No origin/main in the candidate checkout, so candidate_sha can\'t be checked against it');
  }
  try {
    git(['merge-base', '--is-ancestor', sha, 'refs/remotes/origin/main']);
  } catch {
    throw new Error(`candidate_sha ${sha} is not on main`);
  }
  const changed = git(['status', '--porcelain', '--untracked-files=no']).trim();
  if (changed) throw new Error(`Tracked files differ from candidate_sha ${sha}:\n${changed}`);
}

/** The harness has to be the workflow's own revision, or provenance would be wrong. */
export function verifyHarnessCheckout({ sha, git }) {
  assertFullSha('GITHUB_SHA', sha);
  const head = git(['rev-parse', 'HEAD']).trim();
  if (head !== sha) throw new Error(`The harness is at ${head}, not the workflow's revision ${sha}`);
}

/** A candidate older than these startup fields can't report its gates, so stop before packaging it. */
export function assertCandidateReportsGates(startupSource) {
  const missing = ['previewEligible:', 'newChrome:', 'chatEnabled:'].filter((field) => !startupSource.includes(field));
  if (missing.length) throw new Error(`candidate_sha predates the startup record this job reads: src/main/index.ts has no ${missing.join(', ')}`);
}

/** The packaged main bundle's path inside the asar. */
export function findMainBundle(asarFiles) {
  return asarFiles.find((file) => /^[\\/]?\.webpack[\\/](?:[^\\/]+[\\/])?main[\\/]index\.js$/.test(file))?.replace(/^[\\/]/, '') ?? null;
}

/** The version a stable build of this source would carry. */
export function candidateVersion(version) {
  const match = /^(\d+\.\d+\.\d+)(-beta\.\d+)?$/.exec(version);
  if (!match) throw new Error(`Can't derive a stable version from ${version}`);
  return match[1];
}

/** Runs `fn` with package.json at `version`, and always puts the original bytes back. */
export async function withCandidateVersion(packagePath, version, fn, fsImpl = fs) {
  const original = fsImpl.readFileSync(packagePath, 'utf8');
  const pkg = JSON.parse(original);
  try {
    fsImpl.writeFileSync(packagePath, JSON.stringify({ ...pkg, version }, null, 2) + '\n');
    return await fn();
  } finally {
    fsImpl.writeFileSync(packagePath, original);
  }
}

/**
 * The packaged app's whole environment: the allowlist plus the launch conditions
 * from scripts/ci/package-integration.mjs. CLUBHOUSE_USER_DATA also redirects home
 * (src/main/index.ts), so nothing outside the profile is read or written.
 */
export function buildLaunchEnv(baseEnv, { profile, runnerTemp }) {
  const resolved = path.resolve(profile);
  if (!resolved.startsWith(path.resolve(runnerTemp) + path.sep)) {
    throw new Error(`Profile ${resolved} must be under the runner temp ${runnerTemp}`);
  }
  const env = Object.fromEntries(LAUNCH_ENV_ALLOWLIST.filter((key) => baseEnv[key]).map((key) => [key, baseEnv[key]]));
  return {
    ...env,
    CLUBHOUSE_USER_DATA: resolved,
    CLUBHOUSE_DISABLE_AUTO_UPDATE: '1',
    CLUBHOUSE_ANNEX_LOOPBACK_ONLY: '1',
    CLUBHOUSE_ANNEX_EPHEMERAL: '1',
  };
}

export function assertHardenedFuses(fuses) {
  HARDENED_FUSE_WIRE.forEach((value, index) => {
    if (fuses[index] !== value) throw new Error(`Fuse ${index} is ${fuses[index]}, expected ${value}: this build isn't hardened`);
  });
}

/** What differs from a real release of this source, for provenance.json. */
export function metadataDifferences({ platform, sourceVersion, version, packaged, production }) {
  const differences = [
    { field: 'package.json version', source: sourceVersion, candidate: version, release: version, note: 'Written for packaging only and restored. A prerelease version is always Preview-eligible, so this is the point of the build.' },
    { field: 'Forge appVersion', source: sourceVersion, candidate: version, release: version, note: 'Follows package.json.' },
    { field: 'app.getVersion()', source: sourceVersion, candidate: packaged.appGetVersion ?? 'not read: the app did not start', release: version },
    { field: 'Packaged package.json version', source: sourceVersion, candidate: packaged.asarPackageVersion, release: version },
    { field: 'Forge makers', candidate: 'none', release: 'zip, dmg, squirrel, deb, rpm', note: 'No installer is built.' },
  ];
  if (platform === 'darwin') {
    for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) {
      differences.push({ field: `Info.plist ${key}`, source: sourceVersion, candidate: packaged.plist?.[key], release: version, note: 'Follows package.json.' });
    }
    differences.push(
      { field: 'Signing', candidate: 'ad-hoc on a runner copy, never uploaded', release: 'Developer ID, notarized', note: 'osxSign false, no notarization, resetAdHocDarwinSignature false in the build.' },
    );
    for (const [key, expected] of [['CFBundleIdentifier', production.appBundleId], ['CFBundleName', production.name]]) {
      if (packaged.plist?.[key] !== expected) differences.push({ field: `Info.plist ${key}`, candidate: packaged.plist?.[key], release: expected });
    }
  }
  if (platform === 'win32') {
    for (const key of ['FileVersion', 'ProductVersion']) {
      differences.push({ field: `Windows ${key}`, source: sourceVersion, candidate: packaged.windowsVersion?.[key], release: version, note: 'Follows package.json.' });
    }
    differences.push({ field: 'Signing', candidate: 'none', release: 'Setup.exe signed; the exe in the nupkg is not' });
  }
  if (platform === 'linux') {
    differences.push({ field: 'chrome-sandbox', candidate: 'root-owned, mode 4755, set by this job on the runner', release: 'set by the package at install', note: 'The sandbox stays on. ELECTRON_DISABLE_SANDBOX is not set.' });
  }
  return differences;
}

/** The startup record from a log file's text, if the packaged app has written it. */
export function parseStartupRecord(text) {
  for (const line of text.split('\n')) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record?.t === 'diag' && record.ns === 'core:startup' && record.meta?.packaged === true) return record.meta;
  }
  return null;
}

/** The DevTools port from Chromium's console line or DevToolsActivePort file. */
export function parseDevToolsPort(consoleOutput, activePortFile = '') {
  const fromConsole = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(consoleOutput);
  if (fromConsole) return Number(fromConsole[1]);
  const fromFile = /^(\d+)\s/.exec(activePortFile);
  return fromFile ? Number(fromFile[1]) : null;
}

/**
 * Preview off and on, flags absent and present, on fresh and beta state.
 * "fresh" still has the logging and Annex-off seeds every launch gets.
 */
export const SCENARIOS = ['fresh', 'beta'].flatMap((state) => [false, true].flatMap((preview) => [false, true].map((flags) => ({
  name: `${state}-preview-${preview ? 'on' : 'off'}-flags-${flags ? 'present' : 'absent'}`,
  state,
  preview,
  flags,
}))));

export function expectedFor({ state, preview, flags }) {
  const inForce = preview && flags;
  return {
    previewEligible: preview,
    // The default, and what BETA_FLAGS saves, in every scenario.
    newChrome: true,
    // On unless saved off, and no scenario saves it off.
    chatEnabled: true,
    flagsInForce: inForce ? BETA_FLAGS : null,
    settingsPages: !preview ? [] : flags ? PREVIEW_PAGES : ['Experimental', 'Annex', 'Annex control'],
    // On by default in the new layout, which every scenario runs, and Preview doesn't gate it.
    dispatcherRow: true,
    savedFilesUntouched: state === 'beta' && !preview,
  };
}

/** Proves main-process gates only: nothing here shows what the window drew. */
export function checkStartupRecord(record, expected, { version, electron }) {
  const problems = [];
  const expect = (field, actual, wanted) => { if (actual !== wanted) problems.push(`${field}: expected ${wanted}, got ${actual}`); };
  expect('packaged', record.packaged, true);
  expect('app.getVersion()', record.version, version);
  expect('electron', record.electron, electron);
  expect('previewEligible', record.previewEligible, expected.previewEligible);
  expect('newChrome', record.newChrome, expected.newChrome);
  expect('chatEnabled', record.chatEnabled, expected.chatEnabled);
  return problems;
}

/** Runs in the renderer over CDP. Reads what's on screen and asks main through the preload. */
export function rendererProbeSource({ agentId, orchestrator, projectPath }) {
  return `(async () => {
    const until = async (test, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (test()) return true; await new Promise((r) => setTimeout(r, 200)); } return test(); };
    const has = (id) => document.querySelector('[data-testid="' + id + '"]') !== null;
    const navLabels = () => [...document.querySelectorAll('button')].map((b) => (b.textContent || '').trim());
    await until(() => has('title-bar') || has('chrome-title-bar'), 15000);
    const api = window.clubhouse;
    const observed = {
      eligible: await api.app.isPreviewEligible(),
      flags: await api.app.getExperimentalSettings(),
      newChromeLayout: api.newChromeLayout,
      titleBar: has('title-bar'),
      chromeTitleBar: has('chrome-title-bar'),
      chromeSidebar: has('chrome-sidebar'),
    };
    observed.dispatcherRow = await until(() => has('dispatcher-row'), observed.chromeTitleBar ? 15000 : 1000);
    observed.wakesInChat = ${JSON.stringify(projectPath)} === null ? null
      : (await api.chat.getAgentRuntime(${JSON.stringify(agentId)}, ${JSON.stringify(orchestrator)}, { projectPath: ${JSON.stringify(projectPath)}, starting: true })).chat;
    document.querySelector('[data-testid="nav-settings"]').click();
    await until(() => navLabels().includes('Updates'), 10000);
    await new Promise((r) => setTimeout(r, 2000));
    observed.settingsPages = ${JSON.stringify(PREVIEW_PAGES)}.filter((page) => navLabels().includes(page));
    document.querySelector('[data-testid="nav-settings"]').click();
    return observed;
  })()`;
}

/** Proves what the window drew and what the preload was told. */
export function checkRenderer(observed, expected) {
  const problems = [];
  const expect = (field, actual, wanted) => {
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) problems.push(`${field}: expected ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`);
  };
  expect('isPreviewEligible()', observed.eligible, expected.previewEligible);
  expect('newChromeLayout', observed.newChromeLayout, expected.newChrome);
  expect('title-bar', observed.titleBar, !expected.newChrome);
  expect('chrome-title-bar', observed.chromeTitleBar, expected.newChrome);
  expect('chrome-sidebar', observed.chromeSidebar, expected.newChrome);
  expect('dispatcher-row', observed.dispatcherRow, expected.dispatcherRow);
  expect('settings pages', observed.settingsPages, expected.settingsPages);
  if (expected.flagsInForce) {
    const sorted = (flags) => Object.entries(flags ?? {}).sort(([a], [b]) => a.localeCompare(b));
    expect('flags in force', sorted(observed.flags), sorted(expected.flagsInForce));
  } else {
    for (const flag of PREVIEW_ONLY_FLAGS) {
      if (observed.flags && flag in observed.flags) problems.push(`flags in force: ${flag} should be hidden`);
    }
  }
  return problems;
}

/** The renderer page among CDP targets, skipping DevTools. */
export function pickRendererTarget(targets) {
  return targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl && !String(target.url).startsWith('devtools://')) ?? null;
}

/** A minimal CDP client. `WebSocketImpl` is injected so tests can pass a fake. */
export function connectCdp(url, WebSocketImpl, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(url);
    const pending = new Map();
    let nextId = 1;
    const timer = setTimeout(() => reject(new Error(`CDP didn't connect within ${timeoutMs}ms`)), timeoutMs);
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(`CDP socket error on ${url}`));
    });
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    });
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      const send = (method, params = {}) => new Promise((res, rej) => {
        const id = nextId++;
        pending.set(id, { resolve: res, reject: rej });
        socket.send(JSON.stringify({ id, method, params }));
      });
      resolve({
        send,
        async evaluate(expression) {
          const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
          if (exceptionDetails) throw new Error(`Renderer probe threw: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
          return result.value;
        },
        close: () => socket.close(),
      });
    });
  });
}

/** Green must mean all of it ran. A launch that only reached main is reported as incomplete. */
export function summarize(results) {
  const failed = results.filter((r) => r.main?.status !== 'pass' || r.files?.status === 'fail' || r.renderer?.status === 'fail').map((r) => r.name);
  const rendererNotRun = results.filter((r) => r.renderer?.status !== 'pass' && r.renderer?.status !== 'fail').map((r) => r.name);
  const status = failed.length > 0 ? 'fail' : rendererNotRun.length > 0 ? 'incomplete' : 'pass';
  return { status, failed, rendererNotRun };
}

/** Throws if the results folder holds anything but results, provenance and logs. */
export function assertResultsOnly(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.endsWith('.app')) throw new Error(`${full} is an app bundle`);
      assertResultsOnly(full);
    } else if (!RESULT_EXTENSIONS.has(path.extname(entry.name))) {
      throw new Error(`${full} doesn't belong in the results artifact`);
    }
  }
}
