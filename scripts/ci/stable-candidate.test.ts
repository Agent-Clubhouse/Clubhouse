import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { readFileSync } from 'node:fs';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vm from 'vm';
import {
  assertDispatchContext,
  assertHardenedFuses,
  assertResultsOnly,
  buildLaunchEnv,
  candidateVersion,
  checkRenderer,
  checkStartupRecord,
  connectCdp,
  expectedFor,
  metadataDifferences,
  parseDevToolsPort,
  parseStartupRecord,
  pickRendererTarget,
  rendererProbeSource,
  SCENARIOS,
  summarize,
  withCandidateVersion,
} from './stable-candidate-lib.mjs';
import { BETA_FLAGS, PREVIEW_PAGES } from '../../e2e/stable-state-seeds.mjs';

/**
 * Nothing here packages or launches anything. The script itself only ever runs
 * with an environment it refuses, so these prove its logic and its guards, not
 * that it can drive a packaged build. Only a dispatch can show that.
 */

const REPO = path.resolve(__dirname, '../..');
const SCRIPT = path.join(__dirname, 'stable-candidate.mjs');
const WORKFLOW = path.join(REPO, '.github/workflows/stable-candidate.yml');

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stable-candidate-test-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const DISPATCH = {
  GITHUB_ACTIONS: 'true',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  RUNNER_ENVIRONMENT: 'github-hosted',
  STABLE_CANDIDATE: 'true',
  RUNNER_TEMP: '/runner/temp',
  GITHUB_WORKSPACE: '/runner/work',
};

describe('assertDispatchContext', () => {
  it('accepts only the dispatch that asked for this', () => {
    expect(() => assertDispatchContext(DISPATCH)).not.toThrow();
  });

  it.each(['pull_request', 'pull_request_target', 'push', 'schedule', 'workflow_call', 'repository_dispatch', undefined])('refuses the %s event', (event) => {
    expect(() => assertDispatchContext({ ...DISPATCH, GITHUB_EVENT_NAME: event })).toThrow(/GITHUB_EVENT_NAME/);
  });

  it.each([
    ['outside Actions', { GITHUB_ACTIONS: undefined }, /GITHUB_ACTIONS/],
    ['a self-hosted runner', { RUNNER_ENVIRONMENT: 'self-hosted' }, /RUNNER_ENVIRONMENT/],
    ['a dispatch without the input', { STABLE_CANDIDATE: 'false' }, /STABLE_CANDIDATE/],
    ['no runner temp', { RUNNER_TEMP: undefined }, /RUNNER_TEMP/],
    ['the unpackaged test seam being set', { CLUBHOUSE_TEST_STABLE_BUILD: '1' }, /CLUBHOUSE_TEST_STABLE_BUILD/],
  ])('refuses %s', (_label, change, message) => {
    expect(() => assertDispatchContext({ ...DISPATCH, ...change })).toThrow(message);
  });
});

describe('the script refuses before doing anything', () => {
  const packageJson = () => readFileSync(path.join(REPO, 'package.json'), 'utf8');

  // Never run with an environment that passes the guard: that would package and launch.
  it.each([
    ['no CI at all', {}],
    ['a pull request on a hosted runner', { ...DISPATCH, GITHUB_EVENT_NAME: 'pull_request' }],
    ['a push on a hosted runner', { ...DISPATCH, GITHUB_EVENT_NAME: 'push' }],
    ['a schedule on a hosted runner', { ...DISPATCH, GITHUB_EVENT_NAME: 'schedule' }],
    ['a dispatch with the input off', { ...DISPATCH, STABLE_CANDIDATE: 'false' }],
  ])('%s', (_label, env) => {
    const before = packageJson();
    const results = path.join(REPO, 'stable-candidate-results');
    const existed = fs.existsSync(results);
    const run = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', cwd: tempDir(), env: { PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), ...env } });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('stable-candidate runs only from its dispatch');
    expect(packageJson()).toBe(before);
    expect(fs.existsSync(results)).toBe(existed);
  });
});

describe('candidateVersion', () => {
  it.each([['0.42.0-beta.13', '0.42.0'], ['0.42.0', '0.42.0'], ['1.2.3-beta.1', '1.2.3']])('%s gives %s', (input, output) => {
    expect(candidateVersion(input)).toBe(output);
  });

  it.each(['0.42.0-rc.1', '0.42', 'latest', '0.42.0rc'])('refuses %s', (input) => {
    expect(() => candidateVersion(input)).toThrow();
  });

  it('reads the base from the real package.json rather than a fixed number', () => {
    const { version } = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    expect(version.startsWith(candidateVersion(version))).toBe(true);
  });
});

describe('withCandidateVersion', () => {
  const ORIGINAL = '{\n    "name": "x",\n  "version": "0.42.0-beta.13"\n}\n\n';

  function setup() {
    const file = path.join(tempDir(), 'package.json');
    fs.writeFileSync(file, ORIGINAL);
    return file;
  }

  it('writes the version for the work and restores the exact bytes', async () => {
    const file = setup();
    const seen = await withCandidateVersion(file, '0.42.0', async () => JSON.parse(readFileSync(file, 'utf8')));
    expect(seen).toEqual({ name: 'x', version: '0.42.0' });
    expect(readFileSync(file, 'utf8')).toBe(ORIGINAL);
  });

  it('restores when the work fails', async () => {
    const file = setup();
    await expect(withCandidateVersion(file, '0.42.0', async () => { throw new Error('packaging failed'); })).rejects.toThrow('packaging failed');
    expect(readFileSync(file, 'utf8')).toBe(ORIGINAL);
  });
});

describe('buildLaunchEnv', () => {
  const runnerTemp = path.join(os.tmpdir(), 'runner-temp');
  const profile = path.join(runnerTemp, 'stable-candidate-x', 'profile');

  it('sets every launch condition', () => {
    expect(buildLaunchEnv({}, { profile, runnerTemp })).toEqual({
      CLUBHOUSE_USER_DATA: path.resolve(profile),
      CLUBHOUSE_DISABLE_AUTO_UPDATE: '1',
      CLUBHOUSE_ANNEX_LOOPBACK_ONLY: '1',
      CLUBHOUSE_ANNEX_EPHEMERAL: '1',
    });
  });

  it('passes basic variables and drops everything else', () => {
    const env = buildLaunchEnv({
      PATH: '/bin',
      HOME: '/home/runner',
      DISPLAY: ':99',
      GITHUB_TOKEN: 'secret',
      GH_TOKEN: 'secret',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'secret',
      ACTIONS_RUNTIME_TOKEN: 'secret',
      AZURE_CLIENT_ID: 'secret',
      APPLE_ID_PASSWORD: 'secret',
      NODE_OPTIONS: '--inspect',
      ELECTRON_DISABLE_SANDBOX: '1',
      ELECTRON_RUN_AS_NODE: '1',
      CLUBHOUSE_TEST_STABLE_BUILD: '1',
      CLUBHOUSE_MCP_KEY: 'secret',
    }, { profile, runnerTemp });
    expect(env.PATH).toBe('/bin');
    expect(env.HOME).toBe('/home/runner');
    expect(env.DISPLAY).toBe(':99');
    expect(Object.keys(env).sort()).toEqual([
      'CLUBHOUSE_ANNEX_EPHEMERAL',
      'CLUBHOUSE_ANNEX_LOOPBACK_ONLY',
      'CLUBHOUSE_DISABLE_AUTO_UPDATE',
      'CLUBHOUSE_USER_DATA',
      'DISPLAY',
      'HOME',
      'PATH',
    ]);
    expect(JSON.stringify(env)).not.toContain('secret');
  });

  it('refuses a profile outside the runner temp, including a look-alike sibling', () => {
    expect(() => buildLaunchEnv({}, { profile: os.homedir(), runnerTemp })).toThrow(/runner temp/);
    expect(() => buildLaunchEnv({}, { profile: `${runnerTemp}-other/profile`, runnerTemp })).toThrow(/runner temp/);
    expect(() => buildLaunchEnv({}, { profile: runnerTemp, runnerTemp })).toThrow(/runner temp/);
  });
});

describe('assertHardenedFuses', () => {
  it('accepts the hardened wire values', () => {
    expect(() => assertHardenedFuses({ 0: 48, 1: 49, 2: 48, 3: 48, 4: 49, 5: 49 })).not.toThrow();
  });

  it.each([0, 1, 2, 3, 4, 5])('refuses a wrong value in fuse %i', (index) => {
    const fuses: Record<number, number> = { 0: 48, 1: 49, 2: 48, 3: 48, 4: 49, 5: 49 };
    fuses[index] = fuses[index] === 48 ? 49 : 48;
    expect(() => assertHardenedFuses(fuses)).toThrow(`Fuse ${index}`);
  });
});

describe('metadataDifferences', () => {
  const production = { appBundleId: 'com.mason-allen.clubhouse', name: 'Clubhouse' };
  const fields = (list: { field: string }[]) => list.map((d) => d.field);
  const base = { sourceVersion: '0.42.0-beta.13', version: '0.42.0', production };

  it('records the version in every form, on every platform', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      const list = metadataDifferences({ ...base, platform, packaged: { asarPackageVersion: '0.42.0', appGetVersion: '0.42.0' } });
      expect(fields(list)).toEqual(expect.arrayContaining(['package.json version', 'Forge appVersion', 'app.getVersion()', 'Packaged package.json version']));
      expect(list.find((d: { field: string }) => d.field === 'package.json version')).toMatchObject({ source: '0.42.0-beta.13', candidate: '0.42.0' });
    }
  });

  it('says when the app never reported its version', () => {
    const list = metadataDifferences({ ...base, platform: 'linux', packaged: {} });
    expect(list.find((d: { field: string }) => d.field === 'app.getVersion()').candidate).toMatch(/did not start/);
  });

  it('records plist versions and ad-hoc signing on macOS, and no name change when there is none', () => {
    const plist = { CFBundleShortVersionString: '0.42.0', CFBundleVersion: '0.42.0', CFBundleIdentifier: production.appBundleId, CFBundleName: production.name };
    const list = fields(metadataDifferences({ ...base, platform: 'darwin', packaged: { plist } }));
    expect(list).toEqual(expect.arrayContaining(['Info.plist CFBundleShortVersionString', 'Info.plist CFBundleVersion', 'Signing']));
    expect(list).not.toContain('Info.plist CFBundleIdentifier');
    expect(list).not.toContain('Info.plist CFBundleName');
  });

  it('records a bundle id or name that differs from production', () => {
    const plist = { CFBundleIdentifier: 'com.mason-allen.clubhouse.integration', CFBundleName: 'Clubhouse Integration' };
    const list = fields(metadataDifferences({ ...base, platform: 'darwin', packaged: { plist } }));
    expect(list).toEqual(expect.arrayContaining(['Info.plist CFBundleIdentifier', 'Info.plist CFBundleName']));
  });

  it('records Windows version fields and the Linux sandbox', () => {
    expect(fields(metadataDifferences({ ...base, platform: 'win32', packaged: { windowsVersion: { FileVersion: '0.42.0', ProductVersion: '0.42.0' } } })))
      .toEqual(expect.arrayContaining(['Windows FileVersion', 'Windows ProductVersion', 'Signing']));
    expect(fields(metadataDifferences({ ...base, platform: 'linux', packaged: {} }))).toContain('chrome-sandbox');
  });
});

describe('parseStartupRecord', () => {
  const meta = { packaged: true, version: '0.42.0', previewEligible: false, newChrome: false, chatEnabled: false };

  it('finds the record among other lines', () => {
    const text = ['not json', JSON.stringify({ t: 'diag', ns: 'core:other', meta }), JSON.stringify({ t: 'diag', ns: 'core:startup', meta }), ''].join('\n');
    expect(parseStartupRecord(text)).toEqual(meta);
  });

  it('ignores a record from an unpackaged build', () => {
    expect(parseStartupRecord(JSON.stringify({ t: 'diag', ns: 'core:startup', meta: { packaged: false } }))).toBeNull();
    expect(parseStartupRecord('')).toBeNull();
  });
});

describe('parseDevToolsPort', () => {
  it('reads the console line', () => {
    expect(parseDevToolsPort('\nDevTools listening on ws://127.0.0.1:53211/devtools/browser/abc\n')).toBe(53211);
  });

  it('falls back to the DevToolsActivePort file', () => {
    expect(parseDevToolsPort('', '53212\n/devtools/browser/abc\n')).toBe(53212);
  });

  it('gives null when neither has it', () => {
    expect(parseDevToolsPort('Listening somewhere else', '')).toBeNull();
    expect(parseDevToolsPort('DevTools listening on ws://0.0.0.0:53211/devtools/browser/abc')).toBeNull();
  });
});

describe('the matrix', () => {
  it('covers Preview off and on, flags absent and present, on fresh and beta state', () => {
    expect(SCENARIOS).toHaveLength(8);
    expect(new Set(SCENARIOS.map((s: { name: string }) => s.name)).size).toBe(8);
    for (const state of ['fresh', 'beta']) {
      for (const preview of [false, true]) {
        for (const flags of [false, true]) {
          expect(SCENARIOS).toContainEqual(expect.objectContaining({ state, preview, flags }));
        }
      }
    }
  });

  it('expects nothing Preview-gated without Preview', () => {
    for (const scenario of SCENARIOS.filter((s: { preview: boolean }) => !s.preview)) {
      expect(expectedFor(scenario)).toMatchObject({ previewEligible: false, newChrome: false, chatEnabled: false, flagsInForce: null, settingsPages: [], dispatcherRow: false, dispatcherFolderAbsent: true });
    }
  });

  it('expects flags to take effect only with Preview on', () => {
    expect(expectedFor({ state: 'beta', preview: true, flags: true })).toMatchObject({ previewEligible: true, newChrome: true, chatEnabled: true, flagsInForce: BETA_FLAGS, settingsPages: PREVIEW_PAGES, dispatcherRow: true, wakesInChatMustBeFalse: false });
    expect(expectedFor({ state: 'beta', preview: true, flags: false })).toMatchObject({ previewEligible: true, newChrome: false, chatEnabled: false, flagsInForce: null, settingsPages: ['Experimental', 'Annex', 'Annex control'], wakesInChatMustBeFalse: true });
    expect(expectedFor({ state: 'fresh', preview: true, flags: true })).toMatchObject({ newChrome: true, dispatcherRow: false, wakesInChatMustBeFalse: false });
  });

  it('expects saved beta files to stay byte for byte only with Preview off', () => {
    expect(expectedFor({ state: 'beta', preview: false, flags: true }).savedFilesUntouched).toBe(true);
    expect(expectedFor({ state: 'beta', preview: false, flags: false }).savedFilesUntouched).toBe(true);
    expect(expectedFor({ state: 'beta', preview: true, flags: true }).savedFilesUntouched).toBe(false);
    expect(expectedFor({ state: 'fresh', preview: false, flags: true }).savedFilesUntouched).toBe(false);
  });
});

describe('checkStartupRecord', () => {
  const expected = expectedFor({ state: 'fresh', preview: false, flags: false });
  const good = { packaged: true, version: '0.42.0', electron: '45.1.0', previewEligible: false, newChrome: false, chatEnabled: false };
  const opts = { version: '0.42.0', electron: '45.1.0' };

  it('passes a matching record', () => {
    expect(checkStartupRecord(good, expected, opts)).toEqual([]);
  });

  it.each([
    ['packaged', { packaged: false }],
    ['app.getVersion()', { version: '0.42.0-beta.13' }],
    ['electron', { electron: '45.2.0' }],
    ['previewEligible', { previewEligible: true }],
    ['newChrome', { newChrome: true }],
    ['chatEnabled', { chatEnabled: true }],
  ])('fails on %s', (field, change) => {
    expect(checkStartupRecord({ ...good, ...change }, expected, opts).join()).toContain(field);
  });

  it('fails when a build predates the new fields', () => {
    const { previewEligible: _a, newChrome: _b, chatEnabled: _c, ...old } = good;
    expect(checkStartupRecord(old, expected, opts)).toHaveLength(3);
  });
});

describe('checkRenderer', () => {
  const offObserved = {
    eligible: false, flags: {}, newChromeLayout: false, titleBar: true, chromeTitleBar: false, chromeSidebar: false,
    dispatcherRow: false, wakesInChat: false, settingsPages: [],
  };

  it('passes a legacy layout with Preview off', () => {
    expect(checkRenderer(offObserved, expectedFor({ state: 'beta', preview: false, flags: true }))).toEqual([]);
  });

  it.each([
    ['isPreviewEligible()', { eligible: true }],
    ['newChromeLayout', { newChromeLayout: true }],
    ['title-bar', { titleBar: false }],
    ['chrome-title-bar', { chromeTitleBar: true }],
    ['chrome-sidebar', { chromeSidebar: true }],
    ['dispatcher-row', { dispatcherRow: true }],
    ['settings pages', { settingsPages: ['Experimental'] }],
    ['wakes in chat', { wakesInChat: true }],
    ['flags in force', { flags: { chat: true } }],
  ])('fails on %s', (label, change) => {
    expect(checkRenderer({ ...offObserved, ...change }, expectedFor({ state: 'beta', preview: false, flags: true })).join()).toContain(label);
  });

  it('does not care what order the flags come back in', () => {
    const reversed = Object.fromEntries(Object.entries(BETA_FLAGS).reverse());
    const on = { ...offObserved, eligible: true, newChromeLayout: true, titleBar: false, chromeTitleBar: true, chromeSidebar: true, dispatcherRow: true, wakesInChat: null, settingsPages: PREVIEW_PAGES, flags: reversed };
    expect(checkRenderer(on, expectedFor({ state: 'beta', preview: true, flags: true }))).toEqual([]);
  });
});

describe('rendererProbeSource', () => {
  /** A stand-in window with just what the probe reads. */
  function run(present: string[], buttons: string[], projectPath: string | null) {
    const calls: unknown[][] = [];
    const nav = { click() { calls.push(['nav-settings']); } };
    const context = {
      setTimeout,
      document: {
        querySelector: (selector: string) => {
          const id = /data-testid="([^"]+)"/.exec(selector)?.[1] ?? '';
          if (id === 'nav-settings') return nav;
          return present.includes(id) ? {} : null;
        },
        querySelectorAll: () => buttons.map((textContent) => ({ textContent })),
      },
      window: {
        clubhouse: {
          newChromeLayout: false,
          app: { isPreviewEligible: async () => false, getExperimentalSettings: async () => ({}) },
          chat: { getAgentRuntime: async (...args: unknown[]) => { calls.push(args); return { chat: false }; } },
        },
      },
    };
    const source = rendererProbeSource({ agentId: 'agent', orchestrator: 'claude-code', projectPath });
    return vm.runInNewContext(source, context).then((observed: Record<string, unknown>) => ({ observed, calls }));
  }

  it('reads the layout, the pages and main\'s decision, and leaves Settings closed', async () => {
    const { observed, calls } = await run(['title-bar'], ['Updates', ' Experimental ', 'Annex'], '/project');
    expect(JSON.parse(JSON.stringify(observed))).toEqual({
      eligible: false, flags: {}, newChromeLayout: false, titleBar: true, chromeTitleBar: false, chromeSidebar: false,
      dispatcherRow: false, wakesInChat: false, settingsPages: ['Experimental', 'Annex'],
    });
    expect(calls).toEqual([['agent', 'claude-code', { projectPath: '/project', starting: true }], ['nav-settings'], ['nav-settings']].map((c) => expect.arrayContaining(c.map((v) => (typeof v === 'object' ? expect.objectContaining(v as object) : v)))));
  }, 30_000);

  it('skips the agent question with no project', async () => {
    const { observed, calls } = await run(['title-bar'], ['Updates'], null);
    expect(observed.wakesInChat).toBeNull();
    expect(calls).toHaveLength(2);
  }, 30_000);
});

describe('pickRendererTarget', () => {
  it('skips DevTools and targets it can\'t connect to', () => {
    const page = { type: 'page', url: 'file:///app/index.html', webSocketDebuggerUrl: 'ws://x/1' };
    expect(pickRendererTarget([
      { type: 'page', url: 'devtools://devtools/x', webSocketDebuggerUrl: 'ws://x/0' },
      { type: 'service_worker', url: 'file:///sw.js', webSocketDebuggerUrl: 'ws://x/2' },
      { type: 'page', url: 'file:///other.html' },
      page,
    ])).toBe(page);
    expect(pickRendererTarget([])).toBeNull();
  });
});

describe('connectCdp', () => {
  type Handler = (event: { data: string }) => void;

  /** A fake socket that answers Runtime.evaluate as `reply` says. */
  function fakeSocket(reply: (message: { id: number; method: string }) => unknown, behaviour: 'open' | 'error' | 'silent' = 'open') {
    return class FakeWebSocket {
      handlers = new Map<string, Handler>();
      closed = false;
      constructor() {
        setTimeout(() => {
          if (behaviour === 'open') this.handlers.get('open')?.({ data: '' });
          if (behaviour === 'error') this.handlers.get('error')?.({ data: '' });
        }, 0);
      }
      addEventListener(name: string, handler: Handler) { this.handlers.set(name, handler); }
      send(text: string) {
        const message = JSON.parse(text);
        setTimeout(() => this.handlers.get('message')?.({ data: JSON.stringify({ id: message.id, ...(reply(message) as object) }) }), 0);
      }
      close() { this.closed = true; }
    };
  }

  it('returns the evaluated value', async () => {
    const cdp = await connectCdp('ws://x', fakeSocket((m) => {
      expect(m.method).toBe('Runtime.evaluate');
      return { result: { result: { value: 42 } } };
    }));
    await expect(cdp.evaluate('6 * 7')).resolves.toBe(42);
  });

  it('rejects when the page throws', async () => {
    const cdp = await connectCdp('ws://x', fakeSocket(() => ({ result: { result: {}, exceptionDetails: { text: 'Uncaught', exception: { description: 'Boom' } } } })));
    await expect(cdp.evaluate('x')).rejects.toThrow('Boom');
  });

  it('rejects on a protocol error', async () => {
    const cdp = await connectCdp('ws://x', fakeSocket(() => ({ error: { message: 'Not allowed' } })));
    await expect(cdp.send('Browser.close')).rejects.toThrow('Not allowed');
  });

  it('rejects when the socket fails or never opens', async () => {
    await expect(connectCdp('ws://x', fakeSocket(() => ({}), 'error'))).rejects.toThrow('socket error');
    await expect(connectCdp('ws://x', fakeSocket(() => ({}), 'silent'), 10)).rejects.toThrow("didn't connect");
  });
});

describe('summarize', () => {
  const ok = { name: 'a', main: { status: 'pass' }, renderer: { status: 'pass' }, files: { status: 'pass' } };

  it('is green only when everything ran and passed', () => {
    expect(summarize([ok]).status).toBe('pass');
  });

  it('calls main-only evidence incomplete, not a pass', () => {
    const result = summarize([ok, { ...ok, name: 'b', renderer: { status: 'not-run', error: 'No DevTools port' } }]);
    expect(result).toEqual({ status: 'incomplete', failed: [], rendererNotRun: ['b'] });
  });

  it.each(['main', 'renderer', 'files'])('fails on %s', (key) => {
    const result = summarize([ok, { ...ok, name: 'b', [key]: { status: 'fail' } }]);
    expect(result.status).toBe('fail');
    expect(result.failed).toEqual(['b']);
  });

  it('fails a launch that never reported', () => {
    expect(summarize([{ name: 'b', main: { status: 'fail' }, renderer: { status: 'not-run' } }]).status).toBe('fail');
  });
});

describe('assertResultsOnly', () => {
  function results(files: string[]) {
    const dir = tempDir();
    for (const file of files) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), 'x');
    }
    return dir;
  }

  it('accepts results, provenance and logs', () => {
    expect(() => assertResultsOnly(results(['results.json', 'provenance.json', 'logs/a/console.log', 'logs/a/2026.jsonl', 'logs/a/note.txt']))).not.toThrow();
  });

  it.each(['Clubhouse.zip', 'Clubhouse.dmg', 'Clubhouse.exe', 'clubhouse.deb', 'clubhouse.rpm', 'app.asar', 'logs/a/clubhouse', 'x.nupkg', 'Clubhouse.app/README.txt'])('refuses %s', (file) => {
    expect(() => assertResultsOnly(results([file]))).toThrow();
  });
});

describe('.github/workflows/stable-candidate.yml', () => {
  const text = readFileSync(WORKFLOW, 'utf8');
  const lines = text.split(/\r?\n/).filter((l) => !l.trimStart().startsWith('#'));
  const code = lines.join('\n');

  /** The keys directly under a top-level key. */
  function childrenOf(key: string): string[] {
    const start = lines.indexOf(`${key}:`);
    expect(start, key).toBeGreaterThanOrEqual(0);
    const children: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (line && !line.startsWith(' ')) break;
      const match = /^ {2}([^\s:]+):/.exec(line);
      if (match) children.push(match[1]);
    }
    return children;
  }

  it('can only be started by a dispatch', () => {
    expect(childrenOf('on')).toEqual(['workflow_dispatch']);
    for (const trigger of ['pull_request', 'pull_request_target', 'push', 'schedule', 'workflow_call', 'workflow_run', 'repository_dispatch', 'labeled', 'merge_group', 'release']) {
      expect(code).not.toMatch(new RegExp(`\\b${trigger}\\b`));
    }
  });

  it('needs the explicit input, off by default, and checks it again on the job', () => {
    expect(code).toMatch(/inputs:\n\s+stable_candidate:\n[^]*?required: true\n\s+type: boolean\n\s+default: false/);
    expect(code).toContain("if: ${{ github.event_name == 'workflow_dispatch' && inputs.stable_candidate == true }}");
  });

  it('reads the repo and nothing else', () => {
    expect(childrenOf('permissions')).toEqual(['contents']);
    expect(code).toMatch(/^permissions:\n {2}contents: read$/m);
    expect(code.match(/permissions:/g)).toHaveLength(1);
  });

  it('reaches no environment and no secrets', () => {
    expect(code).not.toMatch(/^\s*environment:/m);
    expect(code).not.toContain('secrets.');
    expect(code).not.toContain('secrets:');
    expect(code).not.toContain('github.token');
    expect(code).not.toContain('GITHUB_TOKEN');
    expect(code).toContain('persist-credentials: false');
  });

  it('runs on hosted runners only', () => {
    expect(code).toContain('os: [ubuntu-latest, windows-2022, macos-latest]');
    expect(code).not.toContain('self-hosted');
  });

  it('writes nowhere but its own artifact', () => {
    for (const command of ['az ', 'gh ', 'git push', 'git tag', 'azure/login', 'electron-forge make', 'npm publish']) {
      expect(code).not.toContain(command);
    }
  });

  it('uploads results only, for the usual 7 days', () => {
    expect(code.match(/upload-artifact/g)).toHaveLength(1);
    expect(code).toContain('path: stable-candidate-results/');
    expect(code).toContain('retention-days: 7');
    expect(code).not.toMatch(/path:\s*(out|dist)/);
  });

  it('checks package.json came back', () => {
    expect(code).toMatch(/if: always\(\)\n\s+run: git diff --exit-code -- package\.json/);
  });

  it('leaves Validate and Release out of it', () => {
    for (const file of ['validate.yml', 'release.yml']) {
      expect(readFileSync(path.join(REPO, '.github/workflows', file), 'utf8')).not.toMatch(/stable[-_]candidate/);
    }
  });
});

describe('scripts/ci/stable-candidate.mjs', () => {
  const text = readFileSync(SCRIPT, 'utf8');

  it('checks the context before it imports Forge or does anything else', () => {
    const guard = text.indexOf('assertDispatchContext(process.env);');
    expect(guard).toBeGreaterThan(-1);
    for (const later of ['jiti', 'forge.config.ts', 'api.package', 'spawn(binary']) {
      expect(text.indexOf(later), later).toBeGreaterThan(guard);
    }
    expect(text.slice(0, guard)).not.toMatch(/from '(jiti|@electron)/);
  });

  it('never signs with an identity, notarizes, publishes or commits to the checkout', () => {
    expect(text).toContain("['--force', '--deep', '-s', '-', copy]");
    expect(text).toContain('osxSign: false');
    expect(text).toContain('osxNotarize: undefined');
    expect(text).toContain('makers: []');
    expect(text).toContain('publishers: []');
    for (const word of ['APPLE_', 'AZURE_', 'api.publish', 'api.make', 'signtool', 'ELECTRON_DISABLE_SANDBOX', '--no-sandbox', '--inspect', 'CLUBHOUSE_TEST_']) {
      expect(text, word).not.toContain(word);
    }
    // The only commit is in the seeded project under the runner temp.
    expect(text.match(/\['commit'/g)).toHaveLength(1);
    expect(text).toContain("git(['commit', '-qm', 'init'], project);");
    expect(text).not.toMatch(/\['push'|\['tag'/);
  });

  it('launches only through the allowlisted environment, on the DevTools flag alone', () => {
    expect(text.match(/spawn\(binary/g)).toHaveLength(1);
    expect(text).toContain("spawn(binary, ['--remote-debugging-port=0'], { cwd: profile, env,");
    expect(text).toContain('buildLaunchEnv(process.env, { profile, runnerTemp })');
  });

  it('checks the artifact holds no build before finishing', () => {
    expect(text).toContain('assertResultsOnly(results);');
  });
});
