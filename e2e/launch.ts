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

  // Register for cleanup before doing anything else that can throw — a launch
  // that dies during window discovery must still be reapable.
  recordElectronApp(electronApp.process().pid, profile.userDataDir);
  trackOpenApp(electronApp);

  try {
    // Collect all windows that open, then pick the renderer (non-devtools) one.
    const rendererWindow = await findRendererWindow(electronApp);
    await rendererWindow.waitForLoadState('load');
    if ((opts.onboarding ?? 'skip') === 'skip') await dismissOnboarding(rendererWindow);
    return { electronApp, window: rendererWindow, userDataDir: profile.userDataDir, profile };
  } catch (err) {
    untrackOpenApp(electronApp);
    await electronApp.close().catch(() => {});
    if (ownsProfile) profile.dispose();
    throw err;
  }
}

async function dismissOnboarding(rendererWindow: Page): Promise<void> {
  // Mark onboarding as completed so it doesn't appear during E2E tests.
  await rendererWindow.evaluate(() => {
    localStorage.setItem('clubhouse_onboarding', JSON.stringify({ completed: true, cohort: null }));
  });

  // The onboarding store reads localStorage at module-load time (before our
  // evaluate runs), so a 500ms timer in App.tsx may still fire startOnboarding().
  // Use waitFor (which polls) instead of isVisible (which returns instantly and
  // misses the backdrop on slow Windows CI runners).
  const onboardingBackdrop = rendererWindow.locator('[data-testid="onboarding-backdrop"]');
  try {
    await onboardingBackdrop.waitFor({ state: 'visible', timeout: 3_000 });
    await rendererWindow.locator('[data-testid="onboarding-skip"]').click();
    await onboardingBackdrop.waitFor({ state: 'hidden', timeout: 5_000 });
  } catch {
    // Modal never appeared — onboarding was already completed
  }
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
