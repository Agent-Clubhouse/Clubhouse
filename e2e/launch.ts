import { _electron as electron, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const APP_PATH = path.resolve(__dirname, '..');
const MAIN_ENTRY = path.join(APP_PATH, '.webpack', process.arch, 'main');

export interface LaunchOptions {
  /**
   * Experimental flags to seed before the app starts. Pass these via
   * `experimental` rather than calling `saveExperimentalSettings` after
   * mount — UI surfaces gated on these flags (e.g. the rail Assistant
   * button) read them once on mount and won't react to a later IPC write.
   *
   * When provided, a temp `userData` directory is created and seeded with
   * `experimental-settings.json`, then passed to electron via the
   * `CLUBHOUSE_USER_DATA` env var.
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
}

/**
 * Launch the Electron app and return the renderer window (skipping DevTools).
 * DevTools opens automatically for unpackaged builds, so firstWindow() may
 * return the DevTools page instead of the renderer.
 */
export async function launchApp(opts: LaunchOptions = {}) {
  let userDataDir: string | undefined;
  const env = { ...process.env };
  if (opts.experimental) {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-e2e-'));
    fs.writeFileSync(
      path.join(userDataDir, 'experimental-settings.json'),
      JSON.stringify(opts.experimental, null, 2),
      'utf-8',
    );
    env.CLUBHOUSE_USER_DATA = userDataDir;
  }
  if (opts.pluginsDir) {
    env.CLUBHOUSE_PLUGINS_DIR = opts.pluginsDir;
  }

  const electronApp = await electron.launch({
    args: [MAIN_ENTRY],
    cwd: APP_PATH,
    env,
  });

  // Collect all windows that open, then pick the renderer (non-devtools) one.
  const rendererWindow = await findRendererWindow(electronApp);
  await rendererWindow.waitForLoadState('load');

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

  return { electronApp, window: rendererWindow, userDataDir };
}

async function findRendererWindow(
  electronApp: Awaited<ReturnType<typeof electron.launch>>,
) {
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
