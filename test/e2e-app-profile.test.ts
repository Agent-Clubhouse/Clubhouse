/**
 * Tests for the E2E launch/profile primitive (`e2e/app-profile.ts`,
 * `e2e/launch.ts`).
 *
 * The guarantee under test: every E2E launch runs against an owned,
 * disposable profile — never an inherited or real one — and a failed launch
 * cleans up after itself. Electron is mocked; nothing here launches the app.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const launchMock = vi.hoisted(() => vi.fn());
vi.mock('@playwright/test', () => ({ _electron: { launch: launchMock } }));

import {
  PROFILE_DIR_PREFIX,
  assertDisposableProfile,
  buildLaunchEnv,
  createDisposableProfile,
  disposeAllProfiles,
  seedProfile,
  type DisposableProfile,
} from '../e2e/app-profile';
import { launchApp } from '../e2e/launch';

let sandbox: string;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'app-profile-test-'));
});

afterEach(() => {
  disposeAllProfiles();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('createDisposableProfile', () => {
  it('creates a prefixed, empty directory directly under the temp root', () => {
    const profile = createDisposableProfile({ tmpDir: sandbox, label: 'satellite' });
    expect(path.dirname(profile.userDataDir)).toBe(sandbox);
    expect(path.basename(profile.userDataDir)).toMatch(new RegExp(`^${PROFILE_DIR_PREFIX}satellite-`));
    expect(fs.readdirSync(profile.userDataDir)).toEqual([]);
  });

  it('gives concurrent profiles distinct directories', () => {
    const a = createDisposableProfile({ tmpDir: sandbox });
    const b = createDisposableProfile({ tmpDir: sandbox });
    expect(a.userDataDir).not.toBe(b.userDataDir);
  });

  it('sanitizes the label so it cannot escape the temp root', () => {
    const profile = createDisposableProfile({ tmpDir: sandbox, label: '../../etc' });
    expect(path.dirname(profile.userDataDir)).toBe(sandbox);
  });

  it('dispose removes only its own directory and is idempotent', () => {
    const profile = createDisposableProfile({ tmpDir: sandbox });
    const sibling = createDisposableProfile({ tmpDir: sandbox });
    const unrelated = fs.mkdtempSync(path.join(sandbox, 'unrelated-'));
    fs.writeFileSync(path.join(profile.userDataDir, 'settings.json'), '{}');

    profile.dispose();
    profile.dispose();

    expect(profile.disposed).toBe(true);
    expect(fs.existsSync(profile.userDataDir)).toBe(false);
    expect(fs.existsSync(sibling.userDataDir)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
  });

  it('disposeAllProfiles removes every live profile', () => {
    const a = createDisposableProfile({ tmpDir: sandbox });
    const b = createDisposableProfile({ tmpDir: sandbox });
    disposeAllProfiles();
    expect(fs.existsSync(a.userDataDir)).toBe(false);
    expect(fs.existsSync(b.userDataDir)).toBe(false);
  });
});

describe('assertDisposableProfile', () => {
  function forged(userDataDir: string): DisposableProfile {
    return { userDataDir, tmpDir: sandbox, disposed: false, dispose: () => {} };
  }

  it('accepts a live profile', () => {
    expect(() => assertDisposableProfile(createDisposableProfile({ tmpDir: sandbox }))).not.toThrow();
  });

  it('rejects a disposed profile', () => {
    const profile = createDisposableProfile({ tmpDir: sandbox });
    profile.dispose();
    expect(() => assertDisposableProfile(profile)).toThrow(/already disposed/);
  });

  it('rejects a directory without the disposable prefix (e.g. a real profile)', () => {
    const real = fs.mkdtempSync(path.join(sandbox, 'Clubhouse-'));
    expect(() => assertDisposableProfile(forged(real))).toThrow(/must be a clubhouse-e2e-\* directory/);
  });

  it('rejects a prefixed directory outside the temp root', () => {
    const nested = path.join(sandbox, 'nested');
    fs.mkdirSync(nested);
    const dir = fs.mkdtempSync(path.join(nested, PROFILE_DIR_PREFIX));
    expect(() => assertDisposableProfile(forged(dir))).toThrow(/directly under the temp root/);
  });

  it('rejects a directory that no longer exists', () => {
    expect(() => assertDisposableProfile(forged(path.join(sandbox, `${PROFILE_DIR_PREFIX}gone`))))
      .toThrow(/does not exist/);
  });
});

describe('seedProfile', () => {
  it('writes experimental flags and userData files as JSON', async () => {
    const profile = createDisposableProfile({ tmpDir: sandbox });
    seedProfile(profile, {
      experimental: { chat: true },
      userDataFiles: { 'mcp-settings.json': { enabled: false } },
    });
    const read = async (f: string) => JSON.parse(await fs.promises.readFile(path.join(profile.userDataDir, f), 'utf-8'));
    expect(await read('experimental-settings.json')).toEqual({ chat: true });
    expect(await read('mcp-settings.json')).toEqual({ enabled: false });
  });

  it.each(['../escape.json', 'nested/file.json', '..', ''])('rejects seed filename %j', (filename) => {
    const profile = createDisposableProfile({ tmpDir: sandbox });
    expect(() => seedProfile(profile, { userDataFiles: { [filename]: {} } })).toThrow(/Invalid userData seed filename/);
  });
});

describe('buildLaunchEnv', () => {
  it('points the app at the profile and disables auto-update', () => {
    const profile = createDisposableProfile({ tmpDir: sandbox });
    const env = buildLaunchEnv({ PATH: '/bin' }, { profile });
    expect(env.CLUBHOUSE_USER_DATA).toBe(profile.userDataDir);
    expect(env.CLUBHOUSE_DISABLE_AUTO_UPDATE).toBe('1');
    expect(env.PATH).toBe('/bin');
  });

  it('drops inherited profile and plugin redirects from the parent environment', () => {
    const profile = createDisposableProfile({ tmpDir: sandbox });
    const env = buildLaunchEnv(
      { CLUBHOUSE_USER_DATA: '/Users/dev/Library/Application Support/Clubhouse', CLUBHOUSE_PLUGINS_DIR: '/real/plugins' },
      { profile },
    );
    expect(env.CLUBHOUSE_USER_DATA).toBe(profile.userDataDir);
    expect(env).not.toHaveProperty('CLUBHOUSE_PLUGINS_DIR');
  });

  it('drops every inherited CLUBHOUSE_* variable, so a parent instance\'s bridge credentials never reach the app (#2620)', () => {
    const profile = createDisposableProfile({ tmpDir: sandbox });
    const env = buildLaunchEnv(
      {
        PATH: '/bin',
        CLUBHOUSE_AGENT_ID: 'parent-agent',
        CLUBHOUSE_HOOK_NONCE: 'parent-nonce',
        CLUBHOUSE_MCP_PORT: '40001',
        CLUBHOUSE_HOOK_PORT: '40002',
        CLUBHOUSE_CLI_DEV: '1',
        CLUBHOUSE_SAFE_MODE: '1',
        clubhouse_hook_nonce: 'windows-spelling',
      },
      { profile },
    );
    expect(Object.keys(env).filter((key) => /^clubhouse_/i.test(key)).sort()).toEqual(['CLUBHOUSE_DISABLE_AUTO_UPDATE', 'CLUBHOUSE_USER_DATA']);
    expect(env.PATH).toBe('/bin');
  });

  it('keeps a CLUBHOUSE_* variable the test passes itself', () => {
    const profile = createDisposableProfile({ tmpDir: sandbox });
    const env = buildLaunchEnv(
      { CLUBHOUSE_TEST_HELPER_SEAM: 'inherited', CLUBHOUSE_TEST_NO_MODEL_PROBES: 'inherited' },
      { profile, env: { CLUBHOUSE_TEST_HELPER_SEAM: '1' } },
    );
    expect(env.CLUBHOUSE_TEST_HELPER_SEAM).toBe('1');
    expect(env).not.toHaveProperty('CLUBHOUSE_TEST_NO_MODEL_PROBES');
  });

  it('applies pluginsDir and extra env', () => {
    const profile = createDisposableProfile({ tmpDir: sandbox });
    const env = buildLaunchEnv({}, { profile, pluginsDir: '/sandbox/plugins', env: { PATH: '/fakes:/bin' } });
    expect(env.CLUBHOUSE_PLUGINS_DIR).toBe('/sandbox/plugins');
    expect(env.PATH).toBe('/fakes:/bin');
  });

  it.each(['CLUBHOUSE_USER_DATA', 'CLUBHOUSE_DISABLE_AUTO_UPDATE'])('refuses an env override of %s', (key) => {
    const profile = createDisposableProfile({ tmpDir: sandbox });
    expect(() => buildLaunchEnv({}, { profile, env: { [key]: 'x' } })).toThrow(new RegExp(key));
  });
});

// ── launchApp ────────────────────────────────────────────────────────────

const RENDERER_URL = 'file:///app/.webpack/x64/renderer/main_window/index.html';

function fakePage(url = RENDERER_URL) {
  return {
    url: () => url,
    waitForLoadState: vi.fn(async () => {}),
    waitForTimeout: vi.fn(async () => {}),
    evaluate: vi.fn(async () => {}),
    locator: vi.fn(() => ({
      waitFor: vi.fn(async () => { throw new Error('not visible'); }),
      click: vi.fn(async () => {}),
    })),
  };
}

function fakeApp(pages: ReturnType<typeof fakePage>[]) {
  return {
    process: () => ({ pid: undefined as number | undefined }),
    windows: () => pages,
    waitForEvent: vi.fn(async () => { throw new Error('no more windows'); }),
    close: vi.fn(async () => {}),
  };
}

/** The `CLUBHOUSE_USER_DATA` the n-th electron.launch call received. */
function launchedUserData(call = 0): string {
  return launchMock.mock.calls[call][0].env.CLUBHOUSE_USER_DATA;
}

describe('launchApp', () => {
  beforeEach(() => {
    launchMock.mockReset();
  });

  it('launches against a fresh disposable profile when given no options', async () => {
    const page = fakePage();
    launchMock.mockResolvedValue(fakeApp([page]));

    const launched = await launchApp();

    const userData = launchedUserData();
    expect(path.basename(userData)).toMatch(new RegExp(`^${PROFILE_DIR_PREFIX}`));
    expect(fs.existsSync(userData)).toBe(true);
    expect(launched.userDataDir).toBe(userData);
    expect(launchMock.mock.calls[0][0].env.CLUBHOUSE_DISABLE_AUTO_UPDATE).toBe('1');
    expect(launched.window).toBe(page);
    // Onboarding is dismissed by default.
    expect(page.evaluate).toHaveBeenCalled();
    launched.profile.dispose();
  });

  it('does not hand the app the bridge credentials of the agent running the tests (#2620)', async () => {
    vi.stubEnv('CLUBHOUSE_AGENT_ID', 'parent-agent');
    vi.stubEnv('CLUBHOUSE_HOOK_NONCE', 'parent-nonce');
    vi.stubEnv('CLUBHOUSE_MCP_PORT', '40001');
    try {
      launchMock.mockResolvedValue(fakeApp([fakePage()]));
      const launched = await launchApp();
      const { env } = launchMock.mock.calls[0][0];
      for (const key of ['CLUBHOUSE_AGENT_ID', 'CLUBHOUSE_HOOK_NONCE', 'CLUBHOUSE_MCP_PORT']) expect(env).not.toHaveProperty(key);
      launched.profile.dispose();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('gives two launches two distinct profiles', async () => {
    launchMock.mockImplementation(async () => fakeApp([fakePage()]));
    const [a, b] = await Promise.all([launchApp({ label: 'satellite' }), launchApp({ label: 'controller' })]);
    expect(a.userDataDir).not.toBe(b.userDataDir);
    a.profile.dispose();
    b.profile.dispose();
  });

  it('relaunches against a profile the test owns, preserving its state', async () => {
    launchMock.mockImplementation(async () => fakeApp([fakePage()]));
    const profile = createDisposableProfile();
    fs.writeFileSync(path.join(profile.userDataDir, 'state.json'), '{"kept":true}');

    await launchApp({ profile });
    await launchApp({ profile, experimental: { chat: true } });

    expect(launchedUserData(0)).toBe(profile.userDataDir);
    expect(launchedUserData(1)).toBe(profile.userDataDir);
    expect(await fs.promises.readFile(path.join(profile.userDataDir, 'state.json'), 'utf-8')).toBe('{"kept":true}');
    expect(fs.existsSync(path.join(profile.userDataDir, 'experimental-settings.json'))).toBe(true);
    profile.dispose();
  });

  it('refuses to launch against a profile that is not disposable', async () => {
    const real = fs.mkdtempSync(path.join(sandbox, 'Clubhouse-'));
    const profile: DisposableProfile = { userDataDir: real, tmpDir: sandbox, disposed: false, dispose: () => {} };
    await expect(launchApp({ profile })).rejects.toThrow(/clubhouse-e2e-/);
    expect(launchMock).not.toHaveBeenCalled();
  });

  it('removes its own profile when Electron fails to launch', async () => {
    launchMock.mockRejectedValue(new Error('spawn failed'));

    await expect(launchApp({ experimental: {} })).rejects.toThrow('spawn failed');

    expect(fs.existsSync(launchedUserData())).toBe(false);
  });

  it('closes the app and removes its own profile when no renderer window appears', async () => {
    const app = fakeApp([fakePage('devtools://devtools/bundled/inspector.html')]);
    launchMock.mockResolvedValue(app);

    await expect(launchApp()).rejects.toThrow('no more windows');

    expect(app.close).toHaveBeenCalled();
    expect(fs.existsSync(launchedUserData())).toBe(false);
  });

  it('leaves a test-owned profile in place when the launch fails', async () => {
    launchMock.mockRejectedValue(new Error('spawn failed'));
    const profile = createDisposableProfile();

    await expect(launchApp({ profile })).rejects.toThrow('spawn failed');

    expect(profile.disposed).toBe(false);
    expect(fs.existsSync(profile.userDataDir)).toBe(true);
    profile.dispose();
  });

  it("leaves onboarding alone with onboarding: 'show'", async () => {
    const page = fakePage();
    launchMock.mockResolvedValue(fakeApp([page]));
    const launched = await launchApp({ onboarding: 'show' });
    expect(page.evaluate).not.toHaveBeenCalled();
    launched.profile.dispose();
  });

  it('passes extra args before the main entry', async () => {
    launchMock.mockResolvedValue(fakeApp([fakePage()]));
    const launched = await launchApp({ args: ['--disable-gpu'] });
    const args: string[] = launchMock.mock.calls[0][0].args;
    expect(args[0]).toBe('--disable-gpu');
    expect(args[1]).toMatch(/\.webpack/);
    launched.profile.dispose();
  });
});
