/**
 * Disposable app profiles for E2E launches.
 *
 * Every E2E launch runs against a profile this module created: a fresh
 * `clubhouse-e2e-*` directory directly under the temp root, handed to the app
 * through `CLUBHOUSE_USER_DATA`. The main process applies it as both
 * `userData` and `home` (`src/main/index.ts`), so app-owned registries that
 * live under the home path are isolated too. A launch never falls through to
 * whatever profile the environment happens to provide.
 *
 * A test that needs state to survive a relaunch (restart/persistence tests)
 * creates a profile with `createDisposableProfile()`, passes it to each launch
 * and disposes it when done. Anything left over is removed when the worker
 * exits, and — locally — by the global-teardown sweep in `e2e-cleanup.ts`,
 * which recognises the same directory prefix.
 *
 * Kept free of Playwright imports so it can be unit-tested under vitest.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { removeTempDir } from './e2e-cleanup';

/** Must match the prefix `e2e-cleanup.ts` sweeps. */
export const PROFILE_DIR_PREFIX = 'clubhouse-e2e-';

/** Env vars the launch primitive owns; a test may not set them via `env`. */
export const RESERVED_ENV_KEYS = ['CLUBHOUSE_USER_DATA', 'CLUBHOUSE_DISABLE_AUTO_UPDATE'] as const;

export interface DisposableProfile {
  /** Passed to the app as `CLUBHOUSE_USER_DATA` (userData and app home). */
  readonly userDataDir: string;
  /** Temp root the profile was created under; disposal never leaves it. */
  readonly tmpDir: string;
  readonly disposed: boolean;
  /** Remove the profile directory. Idempotent. */
  dispose(): void;
}

export interface CreateProfileOptions {
  /** Readable tag in the directory name, e.g. `satellite`. */
  label?: string;
  /** Override the temp root (tests only). */
  tmpDir?: string;
}

const liveProfiles = new Set<DisposableProfile>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // Backstop for profiles a spec never disposed. Synchronous because 'exit'
  // cannot await.
  process.on('exit', disposeAllProfiles);
}

/** Allocate a fresh, empty, owned profile directory. */
export function createDisposableProfile(opts: CreateProfileOptions = {}): DisposableProfile {
  const tmpDir = opts.tmpDir ?? os.tmpdir();
  const label = opts.label ? `${opts.label.replace(/[^a-zA-Z0-9_-]/g, '_')}-` : '';
  const userDataDir = fs.mkdtempSync(path.join(tmpDir, `${PROFILE_DIR_PREFIX}${label}`));

  let disposed = false;
  const profile: DisposableProfile = {
    userDataDir,
    tmpDir,
    get disposed() { return disposed; },
    dispose() {
      if (disposed) return;
      disposed = true;
      liveProfiles.delete(profile);
      // removeTempDir refuses anything that is not a prefixed direct child of
      // the temp root, so a corrupted path can never delete outside it.
      removeTempDir(userDataDir, { tmpDir });
    },
  };
  liveProfiles.add(profile);
  installExitHook();
  return profile;
}

/** Dispose every profile created in this process that is still live. */
export function disposeAllProfiles(): void {
  for (const profile of [...liveProfiles]) {
    try {
      profile.dispose();
    } catch {
      // Best-effort — never fail a run over cleanup.
    }
  }
}

/**
 * Throw unless `profile` is a live disposable profile: a prefixed directory
 * directly under its temp root that still exists. Guards the "test passes its
 * own profile" path so a real profile directory can never be launched against.
 */
export function assertDisposableProfile(profile: DisposableProfile): void {
  if (profile.disposed) {
    throw new Error(`E2E profile was already disposed: ${profile.userDataDir}`);
  }
  const resolved = path.resolve(profile.userDataDir);
  if (!path.basename(resolved).startsWith(PROFILE_DIR_PREFIX)) {
    throw new Error(`E2E profile must be a ${PROFILE_DIR_PREFIX}* directory: ${resolved}`);
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`E2E profile directory does not exist: ${resolved}`);
  }
  if (fs.realpathSync(path.dirname(resolved)) !== fs.realpathSync(profile.tmpDir)) {
    throw new Error(`E2E profile must live directly under the temp root: ${resolved}`);
  }
}

export interface ProfileSeed {
  /** Written as `experimental-settings.json`. */
  experimental?: Record<string, boolean>;
  /** JSON files keyed by bare filename. */
  userDataFiles?: Record<string, unknown>;
}

/** Write seed files into the profile before launch. */
export function seedProfile(profile: DisposableProfile, seed: ProfileSeed): void {
  const files: Record<string, unknown> = {};
  if (seed.experimental) files['experimental-settings.json'] = seed.experimental;
  Object.assign(files, seed.userDataFiles);
  for (const [filename, value] of Object.entries(files)) {
    if (!filename || filename === '.' || filename === '..' || path.basename(filename) !== filename) {
      throw new Error(`Invalid userData seed filename: ${filename}`);
    }
    fs.writeFileSync(path.join(profile.userDataDir, filename), JSON.stringify(value, null, 2), 'utf-8');
  }
}

export interface LaunchEnvOptions {
  profile: DisposableProfile;
  /** Sandbox for community plugins (`CLUBHOUSE_PLUGINS_DIR`). */
  pluginsDir?: string;
  /** Extra environment, applied after the inherited one. */
  env?: Record<string, string>;
}

/**
 * Build the app's environment. Every inherited CLUBHOUSE_* variable is dropped,
 * so the developer's shell cannot leak a real directory into a run and an agent
 * running the tests cannot leak its bridge credentials (#2620). A test that
 * needs one passes it in `env`, and the primitive's own keys are applied last
 * so nothing can override them.
 */
export function buildLaunchEnv(baseEnv: NodeJS.ProcessEnv, opts: LaunchEnvOptions): NodeJS.ProcessEnv {
  for (const key of RESERVED_ENV_KEYS) {
    if (opts.env && key in opts.env) {
      throw new Error(`${key} is set by the E2E launch primitive; pass a profile instead of env.${key}`);
    }
  }
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  // Case-insensitive for Windows, where the variable's spelling is not fixed.
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith('CLUBHOUSE_')) delete env[key];
  }
  Object.assign(env, opts.env);
  if (opts.pluginsDir) env.CLUBHOUSE_PLUGINS_DIR = opts.pluginsDir;
  env.CLUBHOUSE_USER_DATA = opts.profile.userDataDir;
  // Never let the auto-updater run during E2E. A real "update available/ready"
  // banner appearing mid-run overlays the UI and flakes unrelated tests (editor
  // focus clicks, canvas context menus). Belt-and-suspenders with the
  // isPackaged gate — this also covers a packaged smoke-test launch.
  env.CLUBHOUSE_DISABLE_AUTO_UPDATE = '1';
  return env;
}
