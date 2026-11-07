import { _electron as electron, type Page } from '@playwright/test';
import * as path from 'path';
import {
  assertDisposableProfile,
  buildLaunchEnv,
  createDisposableProfile,
  seedProfile,
  type DisposableProfile,
} from './app-profile';
import { recordElectronApp, trackOpenApp, untrackOpenApp } from './e2e-cleanup';
import { installFrameMonitor, reportActionFailure } from './renderer-diagnostics';
import { observeOwnedProcess } from './owned-process-receipts';

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
   * Seeded as `experimental-settings.json` in the launch's profile.
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

  /**
   * `'skip'` (default) dismisses first-run onboarding so it can't overlay the
   * UI. `'show'` leaves it alone, for tests of onboarding itself.
   */
  onboarding?: 'skip' | 'show';

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
 * renderer window (skipping DevTools), and dismiss onboarding.
 *
 * A profile created here is removed when the worker exits (and by the local
 * global-teardown sweep); specs that inspect it after quitting may also
 * remove it themselves. If the launch fails partway, the app is closed and an
 * owned profile is removed before the error propagates.
 */
export async function launchApp(opts: LaunchOptions = {}): Promise<LaunchedApp> {
  const launchStarted = Date.now();
  const ownsProfile = !opts.profile;
  const profile = opts.profile ?? createDisposableProfile({ label: opts.label });

  let electronApp: ElectronApp;
  try {
    if (!ownsProfile) assertDisposableProfile(profile);
    seedProfile(profile, { experimental: opts.experimental, userDataFiles: opts.userDataFiles });
    const env = buildLaunchEnv(process.env, { profile, pluginsDir: opts.pluginsDir, env: opts.env });
    electronApp = await electron.launch({
      ...(opts.executablePath ? { executablePath: opts.executablePath } : {}),
      args: [...(opts.args ?? []), ...(opts.executablePath ? [] : [MAIN_ENTRY])],
      cwd: APP_PATH,
      env,
    });
  } catch (err) {
    if (ownsProfile) profile.dispose();
    throw err;
  }

  const ownedProcess = observeOwnedProcess(() => electronApp.process());

  // Register for cleanup before doing anything else that can throw — a launch
  // that dies during window discovery must still be reapable.
  recordElectronApp(electronApp.process().pid, profile.userDataDir);
  trackOpenApp(electronApp);

  try {
    const electronReady = Date.now();
    // Electron may return before or after the first page starts loading. The
    // marker below tells us whether this beat the renderer's app scripts.
    if ((opts.onboarding ?? 'skip') === 'skip') {
      await electronApp.context().addInitScript(seedClassicOnboarding);
    }
    // Collect all windows that open, then pick the renderer (non-devtools) one.
    const rendererWindow = await findRendererWindow(electronApp);
    await rendererWindow.waitForLoadState('load');
    const rendererReady = Date.now();
    const onboardingMode = (opts.onboarding ?? 'skip') === 'skip'
      ? await dismissOnboarding(electronApp, rendererWindow, opts.preserveFirstLoad ?? false)
      : 'show';
    await installFrameMonitor(rendererWindow);
    console.log(`[e2e launch] ${JSON.stringify({
      label: opts.label, onboardingMode, preserveFirstLoad: opts.preserveFirstLoad ?? false,
      electronMs: electronReady - launchStarted, rendererMs: rendererReady - electronReady,
      onboardingMs: Date.now() - rendererReady, totalMs: Date.now() - launchStarted,
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

/** Serialized into the page by addInitScript; it must be self-contained. */
export function seedClassicOnboarding(): void {
  const target = window as Window & {
    clubhouse?: { newChromeLayout?: boolean };
    __clubhouseE2EOnboardingSeeded?: boolean;
  };
  // The default shell completes onboarding itself. Do not change its startup.
  if (target.clubhouse?.newChromeLayout !== false) return;
  localStorage.setItem('clubhouse_onboarding', JSON.stringify({ completed: true, cohort: null }));
  target.__clubhouseE2EOnboardingSeeded = true;
}

async function dismissOnboarding(electronApp: ElectronApp, rendererWindow: Page, preserveFirstLoad: boolean): Promise<string> {
  const state = await rendererWindow.evaluate(() => {
    const target = window as Window & {
      clubhouse?: { newChromeLayout?: boolean };
      __clubhouseE2EOnboardingSeeded?: boolean;
    };
    let completed = false;
    try { completed = JSON.parse(localStorage.getItem('clubhouse_onboarding') ?? '{}').completed === true; } catch { /* fresh state */ }
    return { newChrome: target.clubhouse?.newChromeLayout === true, preseeded: target.__clubhouseE2EOnboardingSeeded === true, completed };
  });
  if (state.newChrome) return 'new-shell';
  let mode = state.preseeded ? 'preseeded' : 'already-completed';
  if (!state.completed) {
    if (preserveFirstLoad) {
      const cause = new Error('Onboarding preseed missed the first app scripts; preserveFirstLoad forbids reloading startup');
      await reportActionFailure(electronApp, rendererWindow, 'onboarding-preseed', cause);
      throw cause;
    }
    // Only an incomplete classic profile needs this fallback. Destroy the old
    // store/timer and let the next module load read completion before initApp.
    await rendererWindow.evaluate(() => {
      localStorage.setItem('clubhouse_onboarding', JSON.stringify({ completed: true, cohort: null }));
    });
    await rendererWindow.reload();
    mode = 'classic-reload';
  }

  // The store already read localStorage; startup can still show the modal
  // later. Handle it whenever it blocks an action, including after slow init,
  // rather than giving up after a fixed visibility wait.
  const onboardingBackdrop = rendererWindow.locator('[data-testid="onboarding-backdrop"]');
  await rendererWindow.addLocatorHandler(onboardingBackdrop, async () => {
    try {
      await rendererWindow.locator('[data-testid="onboarding-skip"]').click();
      await onboardingBackdrop.waitFor({ state: 'hidden', timeout: 5_000 });
    } catch (cause) {
      await reportActionFailure(electronApp, rendererWindow, 'onboarding-skip', cause);
      throw new Error(`Onboarding dismissal failed; cannot continue with a blocking modal. ${String(cause)}`, { cause });
    }
  });
  return mode;
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
