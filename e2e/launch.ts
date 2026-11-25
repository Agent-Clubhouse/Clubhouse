import { _electron as electron, type Page } from '@playwright/test';
import * as path from 'path';
import {
  assertDisposableProfile,
  buildLaunchEnv,
  createDisposableProfile,
  registerProfileProcess,
  seedProfile,
  type DisposableProfile,
} from './app-profile';
import { recordElectronApp, trackOpenApp, untrackOpenApp } from './e2e-cleanup';
import { installFrameMonitor } from './renderer-diagnostics';
import { observeOwnedProcess } from './owned-process-receipts';
import { classicRunSeedOver, isClassicRun, withRunLayout } from './layout';
import * as fs from 'fs';

const APP_PATH = path.resolve(__dirname, '..');
const MAIN_ENTRY = path.join(APP_PATH, '.webpack', process.arch, 'main');

export type ElectronApp = Awaited<ReturnType<typeof electron.launch>>;

export interface LaunchOptions {
  /**
   * Experimental flags to seed before the app starts. Pass these via
   * `experimental` rather than calling `saveExperimentalSettings` after
   * mount — UI surfaces gated on these flags read them once on mount and
   * won't react to a later IPC write.
   *
   * Seeded as `experimental-settings.json` in the launch's profile. Leave
   * `newChrome` unset to launch on the run's layout: the new one, or classic in
   * the Classic layout E2E job (e2e/classic-specs.mjs).
   */
  experimental?: Record<string, boolean>;

  /**
   * Redirect the community-plugins directory to a sandbox via
   * `CLUBHOUSE_PLUGINS_DIR`. Honored only in unpackaged builds (E2E runs
   * unpackaged), and feeds both plugin discovery and the `clubhouse-plugin:`
   * protocol handler's allowed-root. Lets a test install a fixture plugin
   * without touching the real user dir.
   */
  pluginsDir?: string;

  /**
   * JSON files to seed in the launch's userData directory before launch,
   * keyed by filename (for example `mcp-settings.json`).
   */
  userDataFiles?: Record<string, unknown>;

  /**
   * Reuse a disposable profile the test owns (from `createDisposableProfile`)
   * — for restart/persistence tests that relaunch against the same state. The
   * test disposes it. Without this, every launch gets a fresh profile of its
   * own, so a launch never runs against an inherited or real profile.
   */
  profile?: DisposableProfile;

  /** Readable tag for the profile directory name (e.g. `satellite`). */
  label?: string;

  /** Extra Electron command-line arguments (e.g. `--disable-gpu`). */
  args?: string[];

  /** Startup-path specs must exercise the first renderer load, never a reload. */
  preserveFirstLoad?: boolean;

  /** Launch a packaged Clubhouse executable instead of the webpack entry. */
  executablePath?: string;

  /**
   * Extra environment for the app process. Chat E2E uses this to put fake
   * CLIs first on PATH (see e2e/chat-fake-cli.ts). May not set the profile or
   * auto-update variables — the primitive owns those.
   */
  env?: Record<string, string>;
}

export interface LaunchedApp {
  electronApp: ElectronApp;
  window: Page;
  /** The profile directory (`CLUBHOUSE_USER_DATA`) this launch ran against. */
  userDataDir: string;
  profile: DisposableProfile;
}

/**
 * The single E2E launch primitive: allocate (or validate) a disposable
 * profile, launch Electron against it with auto-update disabled, pick the
 * renderer window (skipping DevTools).
 *
 * A profile created here is removed when the worker exits (and by the local
 * global-teardown sweep); specs that inspect it after quitting may also
 * remove it themselves. If launch setup fails, closing the app is attempted;
 * an owned profile is retained unless the launched process has observably exited.
 */
export async function launchApp(opts: LaunchOptions = {}): Promise<LaunchedApp> {
  const launchStarted = Date.now();
  const ownsProfile = !opts.profile;
  const profile = opts.profile ?? createDisposableProfile({ label: opts.label });

  let electronApp: ElectronApp;
  try {
    if (!ownsProfile) assertDisposableProfile(profile);
    seedProfile(profile, { experimental: runExperimental(profile, opts), userDataFiles: opts.userDataFiles });
    const env = buildLaunchEnv(process.env, { profile, pluginsDir: opts.pluginsDir, env: opts.env });
    electronApp = await electron.launch({
      ...(opts.executablePath ? { executablePath: opts.executablePath } : {}),
      args: [...(opts.args ?? []), ...(opts.executablePath ? [] : [MAIN_ENTRY])],
      cwd: APP_PATH,
      env,
    });
    registerProfileProcess(profile, electronApp.process());
  } catch (err) {
    if (ownsProfile) {
      try { profile.dispose(); }
      catch (cleanupError) {
        throw new AggregateError([err, cleanupError], 'E2E launch failed and owned profile disposal failed');
      }
    }
    throw err;
  }

  const ownedProcess = observeOwnedProcess(() => electronApp.process());

  // Register for cleanup before doing anything else that can throw — a launch
  // that dies during window discovery must still be reapable.
  recordElectronApp(electronApp.process().pid, profile.userDataDir);
  trackOpenApp(electronApp);

  try {
    const electronReady = Date.now();
    // Collect all windows that open, then pick the renderer (non-devtools) one.
    const rendererWindow = await findRendererWindow(electronApp);
    await rendererWindow.waitForLoadState('load');
    const rendererReady = Date.now();
    await installFrameMonitor(rendererWindow);
    console.log(`[e2e launch] ${JSON.stringify({
      label: opts.label, preserveFirstLoad: opts.preserveFirstLoad ?? false,
      electronMs: electronReady - launchStarted, rendererMs: rendererReady - electronReady,
      totalMs: Date.now() - launchStarted,
    })}`);
    return { electronApp, window: rendererWindow, userDataDir: profile.userDataDir, profile };
  } catch (err) {
    untrackOpenApp(electronApp);
    ownedProcess.emit('setup-failed');
    try {
      await electronApp.close();
      ownedProcess.emit('setup-close-attempt', { outcome: 'fulfilled' });
    } catch {
      ownedProcess.emit('setup-close-attempt', { outcome: 'rejected' });
    }
    if (ownsProfile) {
      try { profile.dispose(); }
      catch { ownedProcess.emit('setup-profile-dispose', { outcome: 'rejected' }); }
    }
    throw err;
  }
}

/**
 * The experimental flags to seed. When the spec passed none, the classic run
 * merges the classic flag into what a reused profile already saved rather
 * than replacing it, and leaves an unreadable file alone.
 */
function runExperimental(profile: DisposableProfile, opts: LaunchOptions): Record<string, boolean> | undefined {
  if (!isClassicRun || opts.experimental !== undefined || opts.userDataFiles?.['experimental-settings.json'] !== undefined) {
    return withRunLayout(opts.experimental);
  }
  const file = path.join(profile.userDataDir, 'experimental-settings.json');
  return classicRunSeedOver(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined);
}

async function findRendererWindow(electronApp: ElectronApp) {
  // Fast path: pick the first renderer window already open.
  // Avoid evaluating inside candidate pages here: a not-yet-ready renderer can
  // hang evaluation while DevTools is open. The app renderer has a stable file
  // URL under the webpack renderer bundle; DevTools never does.
  // If verification fails, we wait for the next window.
  const seen = new Set<Awaited<ReturnType<typeof electronApp.firstWindow>>>();

  for (const page of electronApp.windows()) {
    if (page.url().startsWith('devtools://')) { seen.add(page); continue; }
    try {
      await page.waitForLoadState('load');
      await page.waitForTimeout(250);
      if (page.url().startsWith('devtools://')) { seen.add(page); continue; }
      if (isClubhouseRenderer(page)) return page;
    } catch { /* not ready */ }
    seen.add(page);
  }

  // Wait for new windows — the renderer hasn't appeared yet or was
  // mis-identified above.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const page = await electronApp.waitForEvent('window', {
      timeout: Math.max(1_000, deadline - Date.now()),
    });
    if (seen.has(page)) continue;
    seen.add(page);
    if (page.url().startsWith('devtools://')) continue;
    try {
      await page.waitForLoadState('load');
      await page.waitForTimeout(250);
      if (page.url().startsWith('devtools://')) continue;
      if (isClubhouseRenderer(page)) return page;
    } catch { /* not ready */ }
  }

  throw new Error('Timed out waiting for renderer window (30 s)');
}

function isClubhouseRenderer(page: Page): boolean {
  const url = page.url();
  return url.startsWith('file://') && url.includes('/renderer/main_window/');
}
